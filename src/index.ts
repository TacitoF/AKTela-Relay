import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<RoomRelay>;
}

type Role = 'publisher' | 'viewer';
type ViewerTransport = 'binary' | 'text';
type Attachment = {
  role: Role;
  waitingForKeyframe: boolean;
  transport: ViewerTransport;
};
type ControlMessage = { type?: string; sentAt?: number };

const ROOM_RE = /^[A-Z2-9]{6}$/;
const MAGIC = [65, 75, 86, 52]; // AKV4
const TEXT_MEDIA_PREFIX = '@media:';

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

export class RoomRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as Role | null;
    if (role !== 'publisher' && role !== 'viewer') {
      return new Response('role inválido', { status: 400 });
    }

    const transport: ViewerTransport = url.searchParams.get('transport') === 'text' ? 'text' : 'binary';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'publisher') {
      for (const old of this.ctx.getWebSockets('publisher')) {
        try { old.close(4001, 'publisher replaced'); } catch { }
      }
      await this.ctx.storage.delete('streamConfig');
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role,
      waitingForKeyframe: role === 'viewer',
      transport
    } satisfies Attachment);

    json(server, { type: 'hello', role, protocol: 4, transport });
    await this.publishRoomState();

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

      if (attachment.role !== 'publisher') return;

      if (control.type === 'stream-config') {
        await this.ctx.storage.put('streamConfig', message);
        this.broadcastText(message);
        return;
      }

      if (control.type === 'cursor') {
        this.broadcastText(message);
      }
      return;
    }

    if (attachment.role !== 'publisher') return;

    const bytes = new Uint8Array(message);
    if (bytes.byteLength < 24) return;
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return;

    const kind = bytes[5];
    const isKeyframe = (bytes[6] & 1) !== 0;
    const viewers = this.ctx.getWebSockets('viewer').filter(v => v.readyState === WebSocket.OPEN);
    if (viewers.length === 0) return;

    // O proxy do Discord é confiável para WebSocket de texto, mas em alguns clientes
    // os quadros binários grandes não chegam de forma consistente. Para esses viewers
    // usamos um envelope base64. A conversão é feita uma vez e reutilizada para todos.
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
        transport: 'text'
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
    if (attachment.role === 'publisher') await this.ctx.storage.delete('streamConfig');
    await this.publishRoomState();
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {
    await this.publishRoomState();
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
    const streamConfig = live ? await this.ctx.storage.get<string>('streamConfig') : undefined;

    for (const viewer of viewers) {
      json(viewer, { type: 'status', live });
      json(viewer, { type: 'viewer-count', count: viewers.length });
      if (streamConfig) {
        try { viewer.send(streamConfig); } catch { }
      }
    }

    for (const publisher of publishers) {
      json(publisher, { type: 'viewer-count', count: viewers.length });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/relay/health') {
      return Response.json({ ok: true, service: 'AKTela Relay', protocol: 4, transport: 'text-fallback-v2' });
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
