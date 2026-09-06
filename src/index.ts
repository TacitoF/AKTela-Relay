import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<RoomRelay>;
}

type Role = 'publisher' | 'viewer' | 'observer';
type ViewerTransport = 'binary' | 'text';
type ModeKey = '720p30' | '720p60' | '1080p30' | '1080p60';
type CapabilityToken = 'h264-baseline' | 'h264-main' | 'h264-high' | 'vp8';

type ViewerCapabilities = {
  protocol: 5;
  modes: Partial<Record<ModeKey, CapabilityToken[]>>;
  audioOpus?: boolean;
};

type Attachment = {
  role: Role;
  waitingForKeyframe: boolean;
  transport: ViewerTransport;
  connectionId: string;
  streamId?: string;
  slot?: number;
  publisherName?: string;
  receiveAudio?: boolean;
  capabilities?: ViewerCapabilities;
};

type ControlMessage = {
  type?: string;
  sentAt?: number;
  protocol?: number;
  modes?: ViewerCapabilities['modes'];
  audioOpus?: boolean;
  reason?: string;
  enabled?: boolean;
};

const ROOM_RE = /^[A-Z2-9]{6}$/;
const STREAM_RE = /^[A-Za-z0-9_-]{1,96}$/;
const MAGIC = [65, 75, 86, 53]; // AKV5
const BATCH_MAGIC = [65, 75, 66, 49]; // AKB1
const MEDIA_HEADER = 24;
const BATCH_HEADER = 8;
const MAX_BATCH_PACKETS = 32;
const TEXT_MEDIA_PREFIX = '@media:';
const MAX_STREAMS = 3;
const MODE_ORDER: ModeKey[] = ['1080p60', '1080p30', '720p60', '720p30'];
const TOKEN_ORDER: CapabilityToken[] = ['h264-main', 'h264-baseline', 'h264-high', 'vp8'];

function json(ws: WebSocket, value: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(value)); } catch { }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') {
    try { return native.call(bytes); } catch { }
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function codecString(mode: ModeKey, token: CapabilityToken): string {
  if (token === 'vp8') return 'vp8';
  const profile = token === 'h264-main' ? '4D40' : token === 'h264-high' ? '6400' : '42E0';
  const level = mode === '1080p60' ? '2A' : mode === '1080p30' ? '28' : mode === '720p60' ? '20' : '1F';
  return `avc1.${profile}${level}`;
}

function tokenParts(token: CapabilityToken) {
  if (token === 'vp8') return { videoCodec: 'vp8', videoProfile: 'compatibility' };
  return { videoCodec: 'h264', videoProfile: token.replace('h264-', '') };
}

type MediaPacket = { buffer: ArrayBuffer; kind: 1 | 2; keyframe: boolean };

function normalizePublisherName(value: string | null) {
  const clean = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || 'Transmissor').slice(0, 32);
}

function parsePacket(buffer: ArrayBuffer): MediaPacket | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < MEDIA_HEADER) return null;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null;
  const kind = bytes[5];
  const payloadLength = new DataView(buffer).getInt32(20, true);
  if (bytes[4] !== 5 || (kind !== 1 && kind !== 2) || payloadLength <= 0 || payloadLength !== bytes.byteLength - MEDIA_HEADER) return null;
  return { buffer, kind, keyframe: kind === 1 && (bytes[6] & 1) !== 0 };
}

function parseMediaMessage(message: ArrayBuffer): MediaPacket[] | null {
  const single = parsePacket(message);
  if (single) return [single];

  const bytes = new Uint8Array(message);
  if (bytes.byteLength < BATCH_HEADER) return null;
  for (let i = 0; i < BATCH_MAGIC.length; i++) if (bytes[i] !== BATCH_MAGIC[i]) return null;
  const view = new DataView(message);
  const count = view.getUint16(6, true);
  if (bytes[4] !== 1 || count < 1 || count > MAX_BATCH_PACKETS) return null;

  const packets: MediaPacket[] = [];
  let offset = BATCH_HEADER;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.byteLength) return null;
    const length = view.getInt32(offset, true);
    offset += 4;
    if (length < MEDIA_HEADER || offset + length > bytes.byteLength) return null;
    const packet = parsePacket(message.slice(offset, offset + length));
    if (!packet) return null;
    packets.push(packet);
    offset += length;
  }
  return offset === bytes.byteLength ? packets : null;
}

function createMediaMessage(packets: MediaPacket[]): ArrayBuffer {
  if (packets.length === 1) return packets[0].buffer;
  const length = BATCH_HEADER + packets.reduce((total, packet) => total + 4 + packet.buffer.byteLength, 0);
  const output = new ArrayBuffer(length);
  const bytes = new Uint8Array(output);
  bytes.set(BATCH_MAGIC, 0);
  bytes[4] = 1;
  new DataView(output).setUint16(6, packets.length, true);
  let offset = BATCH_HEADER;
  for (const packet of packets) {
    new DataView(output).setInt32(offset, packet.buffer.byteLength, true);
    offset += 4;
    bytes.set(new Uint8Array(packet.buffer), offset);
    offset += packet.buffer.byteLength;
  }
  return output;
}

export class RoomRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestedRole = url.searchParams.get('role');
    if (requestedRole !== 'publisher' && requestedRole !== 'viewer') {
      return new Response('role inválido', { status: 400 });
    }

    const role: Role = requestedRole === 'viewer' && url.searchParams.get('observe') === '1'
      ? 'observer'
      : requestedRole;
    const transport: ViewerTransport = url.searchParams.get('transport') === 'text' ? 'text' : 'binary';
    const idParameter = role === 'publisher' ? 'publisherId' : 'viewerId';
    const connectionId = (url.searchParams.get(idParameter) ?? crypto.randomUUID()).slice(0, 96);
    const requestedStreamId = url.searchParams.get('streamId') ?? undefined;
    if (requestedStreamId && !STREAM_RE.test(requestedStreamId)) {
      return new Response('streamId inválido', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    let streamId = requestedStreamId;
    let slot: number | undefined;
    const publisherName = role === 'publisher' ? normalizePublisherName(url.searchParams.get('publisherName')) : undefined;

    if (role === 'publisher') {
      streamId = connectionId;
      const active = this.publishers();
      const existing = active.find(ws => this.state(ws).connectionId === connectionId);

      if (!existing && active.length >= MAX_STREAMS) {
        this.ctx.acceptWebSocket(server, ['rejected']);
        server.serializeAttachment({ role, waitingForKeyframe: false, transport, connectionId, streamId } satisfies Attachment);
        json(server, {
          type: 'publisher-rejected',
          code: 'room-full',
          message: `Esta Activity já possui ${MAX_STREAMS} transmissões ativas.`
        });
        try { server.close(4009, 'room-full'); } catch { }
        return new Response(null, { status: 101, webSocket: client });
      }

      slot = existing ? this.state(existing).slot : this.firstFreeSlot(active);
      if (existing) {
        try { existing.close(4008, 'publisher-reconnected'); } catch { }
      } else {
        await this.ctx.storage.delete(this.configKey(streamId));
      }
    } else {
      // O mesmo viewer pode abrir um socket para cada tela, mas não duplicar a mesma assinatura.
      for (const old of this.ctx.getWebSockets(role)) {
        const state = this.state(old);
        if (old.readyState === WebSocket.OPEN && state.connectionId === connectionId && state.streamId === streamId) {
          try { old.close(4008, `${role}-reconnected`); } catch { }
        }
      }
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role,
      waitingForKeyframe: role === 'viewer',
      transport,
      connectionId,
      streamId,
      slot,
      publisherName,
      receiveAudio: role === 'viewer' ? url.searchParams.get('audio') !== '0' : false
    } satisfies Attachment);

    json(server, { type: 'hello', role, protocol: 5, roomProtocol: 3, transport });
    if (role === 'publisher') {
      json(server, {
        type: 'publisher-accepted', protocol: 5, streamId, slot, activeStreams: this.publishers().length, maxStreams: MAX_STREAMS,
        maxModeKey: this.publishers().length > 1 ? '720p30' : '1080p60'
      });
    }

    await this.publishRoomState();
    this.publishStreamList();
    this.publishRoomPolicy();
    if (role === 'viewer') await this.syncViewer(server);
    await this.publishAudienceCapabilities();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = this.state(ws);

    if (typeof message === 'string') {
      let control: ControlMessage;
      try { control = JSON.parse(message) as ControlMessage; } catch { return; }

      if (control.type === 'ping') {
        json(ws, { type: 'pong', sentAt: control.sentAt ?? 0 });
        return;
      }
      if (attachment.role === 'observer') return;

      if (attachment.role === 'viewer') {
        const streamId = this.viewerStreamId(attachment);
        if (!streamId) return;

        if (control.type === 'latency-probe-ack' && Number.isSafeInteger(control.sentAt) && control.sentAt! >= 0) {
          for (const publisher of this.publishers(streamId)) {
            json(publisher, { type: 'latency-probe-ack', sentAt: control.sentAt });
          }
          return;
        }

        if (control.type === 'viewer-capabilities') {
          if (control.protocol !== 5 || !control.modes || typeof control.modes !== 'object') return;
          const modes: ViewerCapabilities['modes'] = {};
          for (const mode of MODE_ORDER) {
            const tokens = control.modes[mode];
            modes[mode] = Array.isArray(tokens) ? TOKEN_ORDER.filter(token => tokens.includes(token)) : [];
          }
          attachment.capabilities = { protocol: 5, modes, audioOpus: control.audioOpus };
          ws.serializeAttachment(attachment);
          await this.publishAudienceCapabilities(streamId);
          return;
        }

        if (control.type === 'set-audio' && typeof control.enabled === 'boolean') {
          attachment.receiveAudio = control.enabled;
          ws.serializeAttachment(attachment);
          return;
        }

        if (control.type === 'request-keyframe' || control.type === 'decoder-error') {
          attachment.waitingForKeyframe = true;
          ws.serializeAttachment(attachment);
          this.requestKeyframe(streamId, control.type === 'decoder-error' ? 'decoder-error' : control.reason ?? 'viewer-request');
        }
        return;
      }

      if (attachment.role !== 'publisher' || !attachment.streamId) return;
      const streamId = attachment.streamId;

      if (control.type === 'stream-config') {
        await this.ctx.storage.put(this.configKey(streamId), message);
        this.markViewersWaiting(streamId);
        this.broadcastText(streamId, message);
        return;
      }
      if (control.type === 'cursor') {
        this.broadcastText(streamId, message);
        return;
      }
      if (control.type === 'latency-probe' && Number.isSafeInteger(control.sentAt) && control.sentAt! >= 0) {
        for (const viewer of this.viewers(streamId)) json(viewer, { type: 'latency-probe', sentAt: control.sentAt });
      }
      return;
    }

    if (attachment.role !== 'publisher' || !attachment.streamId) return;
    const packets = parseMediaMessage(message);
    if (!packets) return;
    const viewers = this.viewers(attachment.streamId);
    if (viewers.length === 0) return;

    for (const viewer of viewers) {
      const state = this.state(viewer);
      let selected = state.receiveAudio === false ? packets.filter(packet => packet.kind !== 2) : packets;
      if (state.waitingForKeyframe) {
        const keyframeIndex = selected.findIndex(packet => packet.kind === 1 && packet.keyframe);
        selected = keyframeIndex >= 0
          ? selected.slice(keyframeIndex)
          : selected.filter(packet => packet.kind === 2);
      }
      if (selected.length === 0) continue;
      const outbound = selected.length === packets.length && selected.every((packet, index) => packet === packets[index])
        ? message
        : createMediaMessage(selected);
      try {
        viewer.send(state.transport === 'text' ? TEXT_MEDIA_PREFIX + toBase64(outbound) : outbound);
        if (selected.some(packet => packet.kind === 1 && packet.keyframe) && state.waitingForKeyframe) {
          state.waitingForKeyframe = false;
          viewer.serializeAttachment(state);
        }
      } catch {
        if (selected.some(packet => packet.kind === 1)) {
          state.waitingForKeyframe = true;
          try { viewer.serializeAttachment(state); } catch { }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    const attachment = this.state(ws);
    if (attachment.role === 'publisher' && attachment.streamId) {
      const replacementExists = this.publishers(attachment.streamId).some(other => other !== ws);
      if (!replacementExists) await this.ctx.storage.delete(this.configKey(attachment.streamId));
    }
    await this.publishRoomState();
    this.publishStreamList();
    this.publishRoomPolicy();
    await this.publishAudienceCapabilities();
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {
    await this.publishRoomState();
    this.publishStreamList();
    this.publishRoomPolicy();
    await this.publishAudienceCapabilities();
  }

  private state(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() ?? {
      role: 'viewer', waitingForKeyframe: true, transport: 'text', connectionId: 'legacy', receiveAudio: true
    }) as Attachment;
  }

  private publishers(streamId?: string) {
    return this.ctx.getWebSockets('publisher').filter(ws => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      return !streamId || this.state(ws).streamId === streamId;
    });
  }

  private firstPublisher() {
    return this.publishers().sort((a, b) => (this.state(a).slot ?? 99) - (this.state(b).slot ?? 99))[0];
  }

  private viewerStreamId(state: Attachment) {
    const first = this.firstPublisher();
    return state.streamId ?? (first ? this.state(first).streamId : undefined);
  }

  private viewers(streamId: string) {
    return this.ctx.getWebSockets('viewer').filter(ws => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      return this.viewerStreamId(this.state(ws)) === streamId;
    });
  }

  private firstFreeSlot(publishers: WebSocket[]) {
    const used = new Set(publishers.map(ws => this.state(ws).slot));
    for (let slot = 1; slot <= MAX_STREAMS; slot++) if (!used.has(slot)) return slot;
    return MAX_STREAMS;
  }

  private configKey(streamId: string) {
    return `streamConfig:${streamId}`;
  }

  private async syncViewer(viewer: WebSocket) {
    if (viewer.readyState !== WebSocket.OPEN) return;
    const streamId = this.viewerStreamId(this.state(viewer));
    if (!streamId) return;
    const streamConfig = await this.ctx.storage.get<string>(this.configKey(streamId));
    if (streamConfig) {
      try { viewer.send(streamConfig); } catch { }
    }
    this.requestKeyframe(streamId, 'viewer-joined');
  }

  private requestKeyframe(streamId: string, reason: string) {
    for (const publisher of this.publishers(streamId)) json(publisher, { type: 'request-keyframe', reason });
  }

  private markViewersWaiting(streamId: string) {
    for (const viewer of this.viewers(streamId)) {
      const state = this.state(viewer);
      state.waitingForKeyframe = true;
      try { viewer.serializeAttachment(state); } catch { }
    }
  }

  private broadcastText(streamId: string, text: string) {
    for (const viewer of this.viewers(streamId)) {
      try { viewer.send(text); } catch { }
    }
  }

  private async publishRoomState() {
    const publishers = this.publishers();
    for (const observer of this.ctx.getWebSockets('observer').filter(ws => ws.readyState === WebSocket.OPEN)) {
      json(observer, { type: 'status', live: publishers.length > 0, streamCount: publishers.length, maxStreams: MAX_STREAMS });
    }
    for (const publisher of publishers) {
      const streamId = this.state(publisher).streamId!;
      json(publisher, { type: 'viewer-count', count: this.viewers(streamId).length });
    }
    for (const viewer of this.ctx.getWebSockets('viewer').filter(ws => ws.readyState === WebSocket.OPEN)) {
      const streamId = this.viewerStreamId(this.state(viewer));
      json(viewer, { type: 'status', live: Boolean(streamId && this.publishers(streamId).length) });
      json(viewer, { type: 'viewer-count', count: streamId ? this.viewers(streamId).length : 0 });
    }
  }

  private publishStreamList() {
    const streams = this.publishers().map(ws => {
      const state = this.state(ws);
      return {
        id: state.streamId!, slot: state.slot ?? 1, label: `Tela ${state.slot ?? 1}`,
        publisherName: state.publisherName ?? 'Transmissor'
      };
    }).sort((a, b) => a.slot - b.slot);
    const message = { type: 'stream-list', streams, maxStreams: MAX_STREAMS };
    for (const observer of this.ctx.getWebSockets('observer')) json(observer, message);
  }

  private publishRoomPolicy() {
    const publishers = this.publishers();
    const maxModeKey: ModeKey = publishers.length > 1 ? '720p30' : '1080p60';
    for (const publisher of publishers) {
      json(publisher, { type: 'room-policy', activeStreams: publishers.length, maxStreams: MAX_STREAMS, maxModeKey });
    }
  }

  private async publishAudienceCapabilities(onlyStreamId?: string) {
    for (const publisher of this.publishers(onlyStreamId)) {
      const streamId = this.state(publisher).streamId!;
      const viewers = this.viewers(streamId);
      if (viewers.length === 0) {
        json(publisher, {
          type: 'audience-capabilities', viewers: 0, readyViewers: 0, ready: true,
          modeKey: '720p30', videoCodec: 'h264', videoProfile: 'main', codecString: 'avc1.4D401F',
          compatibilityMode: false, reason: 'sem espectadores'
        });
        continue;
      }

      const caps = viewers.map(ws => this.state(ws).capabilities).filter(Boolean) as ViewerCapabilities[];
      const readyViewers = caps.length;
      let modeKey: ModeKey = '720p30';
      let selected: CapabilityToken = 'h264-main';
      let reason = readyViewers === viewers.length ? 'recursos negociados' : 'aguardando recursos dos espectadores';
      let ready = readyViewers === viewers.length;

      if (ready && caps.length > 0) {
        let found = false;
        for (const mode of MODE_ORDER) {
          const common = TOKEN_ORDER.filter(token => caps.every(cap => (cap.modes[mode] ?? []).includes(token)));
          if (common.length > 0) {
            modeKey = mode;
            selected = common[0];
            found = true;
            break;
          }
        }
        if (!found) {
          ready = false;
          reason = 'nenhum codec comum confirmado; modo compatibilidade';
        }
      }

      const parts = tokenParts(selected);
      json(publisher, {
        type: 'audience-capabilities', viewers: viewers.length, readyViewers, ready, modeKey,
        videoCodec: parts.videoCodec, videoProfile: parts.videoProfile, codecString: codecString(modeKey, selected),
        compatibilityMode: !ready || modeKey === '720p30' || selected === 'vp8', reason
      });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/relay/health') {
      return Response.json({
        ok: true, service: 'AKTela Relay', protocol: 5, roomProtocol: 3, stability: 'v2.5',
        features: ['batched-media', 'publisher-names', 'three-publishers', 'selective-subscriptions', 'stream-discovery', 'room-quality-policy', 'capability-negotiation', 'fresh-keyframe-sync', 'hibernation-heartbeat', 'text-media-fallback']
      });
    }

    const websocketPath = url.pathname === '/ws' || url.pathname === '/relay' || url.pathname === '/relay/ws';
    if (!websocketPath) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') return new Response('Upgrade: websocket obrigatório', { status: 426 });

    const role = url.searchParams.get('role');
    const room = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    if ((role !== 'publisher' && role !== 'viewer') || !ROOM_RE.test(room)) return new Response('Parâmetros inválidos', { status: 400 });

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id, { locationHint: 'sam' });
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;
