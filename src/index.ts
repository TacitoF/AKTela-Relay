import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<RoomRelay>;
}

type Role = 'publisher' | 'viewer';
type Attachment = { role: Role; waitingForKeyframe: boolean };
type ControlMessage = { type?: string; sentAt?: number };

const ROOM_RE = /^[A-Z2-9]{6}$/;
const MAGIC = [65, 75, 86, 52]; // AKV4

function json(ws: WebSocket, value: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(value)); } catch { }
}

export class RoomRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as Role | null;
    if (role !== 'publisher' && role !== 'viewer') {
      return new Response('role inválido', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'publisher') {
      for (const old of this.ctx.getWebSockets('publisher')) {
        try { old.close(4001, 'publisher replaced'); } catch { }
      }
      await this.ctx.storage.delete('streamConfig');
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, waitingForKeyframe: role === 'viewer' } satisfies Attachment);

    json(server, { type: 'hello', role, protocol: 4 });
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

    for (const viewer of this.ctx.getWebSockets('viewer')) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      const state = (viewer.deserializeAttachment() ?? { role: 'viewer', waitingForKeyframe: true }) as Attachment;

      if (kind === 1 && state.waitingForKeyframe && !isKeyframe) continue;
      if (kind === 1 && isKeyframe && state.waitingForKeyframe) {
        state.waitingForKeyframe = false;
        viewer.serializeAttachment(state);
      }

      try { viewer.send(message); }
      catch {
        if (kind === 1) {
          state.waitingForKeyframe = true;
          try { viewer.serializeAttachment(state); } catch { }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    const attachment = (ws.deserializeAttachment() ?? {}) as Partial<Attachment>;
    if (attachment.role === 'publisher') await this.ctx.storage.delete('streamConfig');
    await this.publishRoomState();
  }

  async webSocketError() {
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
      return Response.json({ ok: true, service: 'AKTela Relay', protocol: 4 });
    }

    // Aceitamos os dois formatos para funcionar tanto diretamente quanto pelo URL Mapping do Discord.
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
    return env.ROOMS.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;
