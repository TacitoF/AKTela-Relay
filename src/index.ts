import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<RoomRelay>;
}

type Role = 'publisher' | 'viewer';
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
  capabilities?: ViewerCapabilities;
};

type ControlMessage = {
  type?: string;
  sentAt?: number;
  protocol?: number;
  modes?: ViewerCapabilities['modes'];
  audioOpus?: boolean;
  reason?: string;
};

const ROOM_RE = /^[A-Z2-9]{6}$/;
const MAGIC = [65, 75, 86, 53]; // AKV5
const TEXT_MEDIA_PREFIX = '@media:';
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

export class RoomRelay extends DurableObject<Env> {

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeat textual tratado pelo runtime sem acordar o Durable Object em hibernação.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as Role | null;
    if (role !== 'publisher' && role !== 'viewer') return new Response('role inválido', { status: 400 });

    const transport: ViewerTransport = url.searchParams.get('transport') === 'text' ? 'text' : 'binary';
    const connectionId = (url.searchParams.get(role === 'publisher' ? 'publisherId' : 'viewerId') ?? crypto.randomUUID()).slice(0, 96);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'publisher') {
      const active = this.ctx.getWebSockets('publisher').filter(ws => ws.readyState === WebSocket.OPEN);
      const foreign = active.find(ws => {
        const state = (ws.deserializeAttachment() ?? {}) as Partial<Attachment>;
        return !state.connectionId || state.connectionId !== connectionId;
      });

      if (foreign) {
        this.ctx.acceptWebSocket(server, ['rejected']);
        server.serializeAttachment({ role, waitingForKeyframe: false, transport, connectionId } satisfies Attachment);
        json(server, {
          type: 'publisher-rejected',
          code: 'publisher-active',
          message: 'Já existe uma transmissão ativa nesta Activity.'
        });
        try { server.close(4009, 'publisher-active'); } catch { }
        return new Response(null, { status: 101, webSocket: client });
      }

      // Reconexão do mesmo Capture: substitui apenas o socket antigo da mesma sessão.
      for (const old of active) {
        const state = (old.deserializeAttachment() ?? {}) as Partial<Attachment>;
        if (state.connectionId === connectionId) {
          try { old.close(4008, 'publisher-reconnected'); } catch { }
        }
      }

      if (active.length === 0) {
        await this.ctx.storage.delete('streamConfig');
      }
    } else {
      // Reconexão do mesmo espectador não deve ser contada duas vezes.
      for (const old of this.ctx.getWebSockets('viewer')) {
        const state = (old.deserializeAttachment() ?? {}) as Partial<Attachment>;
        if (old.readyState === WebSocket.OPEN && state.connectionId === connectionId) {
          try { old.close(4008, 'viewer-reconnected'); } catch { }
        }
      }
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role,
      waitingForKeyframe: role === 'viewer',
      transport,
      connectionId
    } satisfies Attachment);

    json(server, { type: 'hello', role, protocol: 5, transport });
    if (role === 'publisher') json(server, { type: 'publisher-accepted', protocol: 5 });

    await this.publishRoomState();

    if (role === 'viewer') {
      await this.syncViewer(server);
    }
    // A Capture joining existing viewers needs their capabilities immediately.
    await this.publishAudienceCapabilities();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = (ws.deserializeAttachment() ?? {}) as Partial<Attachment>;

    if (typeof message === 'string') {
      let control: ControlMessage;
      try { control = JSON.parse(message) as ControlMessage; } catch { return; }

      if (control.type === 'ping') {
        json(ws, { type: 'pong', sentAt: control.sentAt ?? 0 });
        return;
      }

      if (attachment.role === 'viewer') {
        if (control.type === 'viewer-capabilities') {
          if (control.protocol !== 5 || !control.modes || typeof control.modes !== 'object') return;
          const modes: ViewerCapabilities['modes'] = {};
          for (const mode of MODE_ORDER) {
            const tokens = control.modes[mode];
            modes[mode] = Array.isArray(tokens) ? TOKEN_ORDER.filter(token => tokens.includes(token)) : [];
          }
          const state = attachment as Attachment;
          state.capabilities = {
            protocol: 5,
            modes,
            audioOpus: control.audioOpus
          };
          ws.serializeAttachment(state);
          await this.publishAudienceCapabilities();
          return;
        }

        if (control.type === 'request-keyframe') {
          this.requestKeyframe(control.reason ?? 'viewer-request');
          const state = attachment as Attachment;
          state.waitingForKeyframe = true;
          ws.serializeAttachment(state);
          return;
        }

        if (control.type === 'decoder-error') {
          const state = attachment as Attachment;
          state.waitingForKeyframe = true;
          ws.serializeAttachment(state);
          this.requestKeyframe('decoder-error');
          return;
        }

        return;
      }

      if (attachment.role !== 'publisher') return;

      if (control.type === 'stream-config') {
        await this.ctx.storage.put('streamConfig', message);
        this.markViewersWaiting();
        this.broadcastText(message);
        return;
      }

      if (control.type === 'cursor') {
        this.broadcastText(message);
        return;
      }

      return;
    }

    if (attachment.role !== 'publisher') return;

    const bytes = new Uint8Array(message);
    if (bytes.byteLength < 24) return;
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return;

    const kind = bytes[5];
    const payloadLength = new DataView(message).getInt32(20, true);
    if (bytes[4] !== 5 || (kind !== 1 && kind !== 2) || payloadLength <= 0 || payloadLength !== bytes.byteLength - 24) return;
    const isKeyframe = (bytes[6] & 1) !== 0;
    const viewers = this.ctx.getWebSockets('viewer').filter(v => v.readyState === WebSocket.OPEN);
    if (viewers.length === 0) return;

    let textEnvelope: string | null = null;
    const textViewerExists = viewers.some(v => {
      const state = (v.deserializeAttachment() ?? {}) as Partial<Attachment>;
      return state.transport === 'text';
    });
    if (textViewerExists) textEnvelope = TEXT_MEDIA_PREFIX + toBase64(message);

    for (const viewer of viewers) {
      const state = (viewer.deserializeAttachment() ?? {
        role: 'viewer',
        waitingForKeyframe: true,
        transport: 'text',
        connectionId: 'legacy'
      }) as Attachment;

      if (kind === 1 && state.waitingForKeyframe && !isKeyframe) continue;

      try {
        if (state.transport === 'text') viewer.send(textEnvelope!);
        else viewer.send(message);

        if (kind === 1 && isKeyframe && state.waitingForKeyframe) {
          state.waitingForKeyframe = false;
          viewer.serializeAttachment(state);
        }
      } catch {
        if (kind === 1) {
          state.waitingForKeyframe = true;
          try { viewer.serializeAttachment(state); } catch { }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    const attachment = (ws.deserializeAttachment() ?? {}) as Partial<Attachment>;
    if (attachment.role === 'publisher') {
      const replacementExists = this.ctx.getWebSockets('publisher').some(other => other !== ws && other.readyState === WebSocket.OPEN);
      if (!replacementExists) {
        await this.ctx.storage.delete('streamConfig');
      }
    }
    await this.publishRoomState();
    await this.publishAudienceCapabilities();
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    const attachment = (ws.deserializeAttachment() ?? {}) as Partial<Attachment>;
    if (attachment.role === 'publisher') {
      const replacementExists = this.ctx.getWebSockets('publisher').some(other => other !== ws && other.readyState === WebSocket.OPEN);
      if (!replacementExists) {
      }
    }
    await this.publishRoomState();
    await this.publishAudienceCapabilities();
  }

  private async syncViewer(viewer: WebSocket) {
    if (viewer.readyState !== WebSocket.OPEN) return;
    const streamConfig = await this.ctx.storage.get<string>('streamConfig');
    if (streamConfig) {
      try { viewer.send(streamConfig); } catch { }
    }

    // A cached IDR cannot decode current deltas when intervening reference frames
    // were never delivered. Keep this viewer waiting for a fresh live keyframe.
    this.requestKeyframe('viewer-joined');
  }

  private requestKeyframe(reason: string) {
    for (const publisher of this.ctx.getWebSockets('publisher')) {
      json(publisher, { type: 'request-keyframe', reason });
    }
  }

  private markViewersWaiting() {
    for (const viewer of this.ctx.getWebSockets('viewer')) {
      const state = (viewer.deserializeAttachment() ?? {}) as Attachment;
      state.waitingForKeyframe = true;
      try { viewer.serializeAttachment(state); } catch { }
    }
  }

  private broadcastText(text: string) {
    for (const viewer of this.ctx.getWebSockets('viewer')) {
      if (viewer.readyState === WebSocket.OPEN) {
        try { viewer.send(text); } catch { }
      }
    }
  }

  private async publishRoomState() {
    const publishers = this.ctx.getWebSockets('publisher').filter(ws => ws.readyState === WebSocket.OPEN);
    const viewers = this.ctx.getWebSockets('viewer').filter(ws => ws.readyState === WebSocket.OPEN);
    const live = publishers.length > 0;

    for (const viewer of viewers) {
      json(viewer, { type: 'status', live });
      json(viewer, { type: 'viewer-count', count: viewers.length });
    }

    for (const publisher of publishers) {
      json(publisher, { type: 'viewer-count', count: viewers.length });
    }
  }

  private async publishAudienceCapabilities() {
    const publishers = this.ctx.getWebSockets('publisher').filter(ws => ws.readyState === WebSocket.OPEN);
    if (publishers.length === 0) return;

    const viewers = this.ctx.getWebSockets('viewer').filter(ws => ws.readyState === WebSocket.OPEN);
    if (viewers.length === 0) {
      for (const publisher of publishers) {
        json(publisher, {
          type: 'audience-capabilities',
          viewers: 0,
          readyViewers: 0,
          ready: true,
          modeKey: '720p30',
          videoCodec: 'h264',
          videoProfile: 'main',
          codecString: 'avc1.4D401F',
          compatibilityMode: false,
          reason: 'sem espectadores'
        });
      }
      return;
    }

    const caps = viewers.map(ws => ((ws.deserializeAttachment() ?? {}) as Attachment).capabilities).filter(Boolean) as ViewerCapabilities[];
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
        modeKey = '720p30';
        selected = 'h264-main';
        reason = 'nenhum codec comum confirmado; modo compatibilidade';
      }
    }

    const parts = tokenParts(selected);
    const message = {
      type: 'audience-capabilities',
      viewers: viewers.length,
      readyViewers,
      ready,
      modeKey,
      videoCodec: parts.videoCodec,
      videoProfile: parts.videoProfile,
      codecString: codecString(modeKey, selected),
      compatibilityMode: !ready || modeKey === '720p30' || selected === 'vp8',
      reason
    };

    for (const publisher of publishers) json(publisher, message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/relay/health') {
      return Response.json({
        ok: true,
        service: 'AKTela Relay',
        protocol: 5,
        stability: 'v2.3',
        features: ['single-publisher', 'same-client-reconnect', 'capability-negotiation', 'fresh-keyframe-sync', 'hibernation-heartbeat', 'text-media-fallback']
      });
    }

    const websocketPath = url.pathname === '/ws' || url.pathname === '/relay' || url.pathname === '/relay/ws';
    if (!websocketPath) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('Upgrade: websocket obrigatório', { status: 426 });
    }

    const role = url.searchParams.get('role');
    const room = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    if ((role !== 'publisher' && role !== 'viewer') || !ROOM_RE.test(room)) {
      return new Response('Parâmetros inválidos', { status: 400 });
    }

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id, { locationHint: 'sam' });
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;
