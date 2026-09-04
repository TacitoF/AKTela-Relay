import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<RoomRelay>;
}

type Role = 'publisher' | 'viewer';
type Attachment = { role: Role; waitKey?: boolean };
type Control = { type?: string; sentAt?: number };

const MAX_BUFFERED = 650_000;

function sendJson(ws: WebSocket, value: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(value)); } catch { }
  }
}

export class RoomRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') as Role | null;
    if (role !== 'publisher' && role !== 'viewer') return new Response('role inválido', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'publisher') {
      for (const old of this.ctx.getWebSockets('publisher')) {
        if (old.readyState === WebSocket.OPEN) {
          try { old.close(4001, 'publisher replaced'); } catch { }
        }
      }
      await this.ctx.storage.delete('streamConfig');
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, waitKey: role === 'viewer' } satisfies Attachment);

    await this.updateRoom();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = (ws.deserializeAttachment() ?? {}) as Attachment;

    if (typeof message === 'string') {
      let control: Control = {};
      try { control = JSON.parse(message) as Control; } catch { return; }

      if (control.type === 'ping') {
        sendJson(ws, { type: 'pong', sentAt: control.sentAt ?? 0 });
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
        return;
      }

      return;
    }

    if (attachment.role !== 'publisher') return;

    const bytes = new Uint8Array(message);
    if (bytes.byteLength < 24 || bytes[0] !== 65 || bytes[1] !== 75 || bytes[2] !== 86 || bytes[3] !== 51) return;

    const kind = bytes[5];
    const key = bytes[6] === 1;

    for (const viewer of this.ctx.getWebSockets('viewer')) {
      if (viewer.readyState !== WebSocket.OPEN) continue;

      const state = (viewer.deserializeAttachment() ?? { role: 'viewer', waitKey: true }) as Attachment;
      const buffered = (viewer as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0;

      if (buffered > MAX_BUFFERED) {
        if (kind === 1 && !state.waitKey) {
          state.waitKey = true;
          viewer.serializeAttachment(state);
        }
        continue;
      }

      if (kind === 1 && state.waitKey && !key) continue;
      if (kind === 1 && key && state.waitKey) {
        state.waitKey = false;
        viewer.serializeAttachment(state);
      }

      try { viewer.send(message); } catch { }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const attachment = (ws.deserializeAttachment() ?? {}) as Attachment;
    if (attachment.role === 'publisher') await this.ctx.storage.delete('streamConfig');
    try { ws.close(code, reason); } catch { }
    await this.updateRoom();
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {
    await this.updateRoom();
  }

  private broadcastText(text: string) {
    for (const viewer of this.ctx.getWebSockets('viewer')) {
      if (viewer.readyState === WebSocket.OPEN) {
        try { viewer.send(text); } catch { }
      }
    }
  }

  private async updateRoom() {
    const publishers = this.ctx.getWebSockets('publisher').filter(ws => ws.readyState === WebSocket.OPEN);
    const viewers = this.ctx.getWebSockets('viewer').filter(ws => ws.readyState === WebSocket.OPEN);
    const live = publishers.length > 0;
    const streamConfig = live ? await this.ctx.storage.get<string>('streamConfig') : undefined;

    for (const viewer of viewers) {
      sendJson(viewer, { type: 'status', live });
      sendJson(viewer, { type: 'viewer-count', count: viewers.length });
      if (streamConfig) {
        try { viewer.send(streamConfig); } catch { }
      }
    }

    for (const publisher of publishers) {
      sendJson(publisher, { type: 'viewer-count', count: viewers.length });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'AKTela Relay Cloudflare v1' });
    }

    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('Upgrade: websocket obrigatório', { status: 426 });
    }

    const role = url.searchParams.get('role');
    const room = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    if ((role !== 'publisher' && role !== 'viewer') || !/^[A-Z2-9]{6}$/.test(room)) {
      return new Response('Parâmetros inválidos', { status: 400 });
    }

    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;
