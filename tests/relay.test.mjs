import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'mock:workers', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'mock:workers') return {
      format: 'module', shortCircuit: true,
      source: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'
    };
    return next(url, context);
  }
});

class Socket {
  static OPEN = 1;
  readyState = 1;
  sent = [];
  attachment = {};
  send(value) { this.sent.push(value); }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = Socket;
globalThis.WebSocketPair = class { constructor() { this[0] = new Socket(); this[1] = new Socket(); } };
globalThis.WebSocketRequestResponsePair = class {};
const RealResponse = Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init = {}) { super(body, { ...init, status: init.status === 101 ? 200 : init.status }); }
};
const { RoomRelay } = await import('../src/index.ts');

function fixture() {
  const sockets = [];
  const data = new Map();
  const ctx = {
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws, tags) { sockets.push({ ws, tags }); },
    getWebSockets(tag) { return sockets.filter(s => s.tags.includes(tag)).map(s => s.ws); },
    storage: { async get(key) { return data.get(key); }, async put(key, value) { data.set(key, value); }, async delete(key) { data.delete(key); } }
  };
  return { ctx, room: new RoomRelay(ctx, {}), sockets };
}
function viewer(ctx, id) {
  const ws = new Socket();
  ws.serializeAttachment({ role: 'viewer', transport: 'binary', connectionId: id, waitingForKeyframe: true,
    capabilities: { protocol: 5, modes: { '720p30': ['h264-main'] } } });
  ctx.acceptWebSocket(ws, ['viewer']);
  return ws;
}
function packet(key, length = 1) {
  const bytes = new Uint8Array(24 + length);
  bytes.set([65, 75, 86, 53, 5, 1, key ? 1 : 0]);
  new DataView(bytes.buffer).setInt32(20, length, true);
  return bytes.buffer;
}
const messages = ws => ws.sent.filter(s => typeof s === 'string').map(s => JSON.parse(s));

test('publisher receives capabilities of viewers already in the room', async () => {
  const { room, ctx } = fixture();
  viewer(ctx, 'before');
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=capture'));
  const publisher = ctx.getWebSockets('publisher')[0];
  assert.ok(messages(publisher).some(m => m.type === 'audience-capabilities' && m.ready && m.viewers === 1));
});

test('new viewer waits for a fresh IDR, never cached IDR plus unrelated deltas', async () => {
  const { room, ctx } = fixture();
  viewer(ctx, 'before');
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=capture'));
  const publisher = ctx.getWebSockets('publisher')[0];
  await room.webSocketMessage(publisher, packet(true));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=after'));
  const joined = ctx.getWebSockets('viewer').at(-1);
  assert.equal(joined.sent.filter(m => m instanceof ArrayBuffer).length, 0);
  await room.webSocketMessage(publisher, packet(false));
  assert.equal(joined.sent.filter(m => m instanceof ArrayBuffer).length, 0);
  await room.webSocketMessage(publisher, packet(true));
  await room.webSocketMessage(publisher, packet(false));
  assert.equal(joined.sent.filter(m => m instanceof ArrayBuffer).length, 2);
});

test('malformed capabilities are sanitized and invalid media is not broadcast', async () => {
  const { room, ctx } = fixture();
  const v = viewer(ctx, 'viewer');
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=capture'));
  await room.webSocketMessage(v, JSON.stringify({ type: 'viewer-capabilities', protocol: 5, modes: { '720p30': 9 } }));
  assert.deepEqual(v.deserializeAttachment().capabilities.modes['720p30'], []);
  const bad = packet(true);
  new DataView(bad).setInt32(20, 9999, true);
  await room.webSocketMessage(ctx.getWebSockets('publisher')[0], bad);
  assert.equal(v.sent.filter(m => m instanceof ArrayBuffer).length, 0);
});

test('second publisher is rejected without replacing the active session', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=second'));
  assert.equal(ctx.getWebSockets('publisher').length, 1);
  assert.ok(messages(ctx.getWebSockets('rejected')[0]).some(m => m.type === 'publisher-rejected'));
});

test('latency probe makes a full publisher-viewer-publisher round trip', async () => {
  const { room, ctx } = fixture();
  const v = viewer(ctx, 'viewer');
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=capture'));
  const publisher = ctx.getWebSockets('publisher')[0];
  await room.webSocketMessage(publisher, JSON.stringify({ type: 'latency-probe', sentAt: 12345 }));
  assert.ok(messages(v).some(m => m.type === 'latency-probe' && m.sentAt === 12345));
  await room.webSocketMessage(v, JSON.stringify({ type: 'latency-probe-ack', sentAt: 12345 }));
  assert.ok(messages(publisher).some(m => m.type === 'latency-probe-ack' && m.sentAt === 12345));
});
