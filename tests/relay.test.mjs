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
function viewer(ctx, id, streamId) {
  const ws = new Socket();
  ws.serializeAttachment({ role: 'viewer', transport: 'binary', connectionId: id, waitingForKeyframe: true,
    streamId,
    capabilities: { protocol: 5, modes: { '720p30': ['h264-main'] } } });
  ctx.acceptWebSocket(ws, ['viewer']);
  return ws;
}
function packet(key, length = 1, kind = 1) {
  const bytes = new Uint8Array(24 + length);
  bytes.set([65, 75, 86, 53, 5, kind, key ? 1 : 0]);
  new DataView(bytes.buffer).setInt32(20, length, true);
  return bytes.buffer;
}
function batch(...packets) {
  const length = 8 + packets.reduce((total, value) => total + 4 + value.byteLength, 0);
  const buffer = new ArrayBuffer(length);
  const bytes = new Uint8Array(buffer);
  bytes.set([65, 75, 66, 49, 1, 0]);
  const view = new DataView(buffer);
  view.setUint16(6, packets.length, true);
  let offset = 8;
  for (const value of packets) {
    view.setInt32(offset, value.byteLength, true);
    offset += 4;
    bytes.set(new Uint8Array(value), offset);
    offset += value.byteLength;
  }
  return buffer;
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

test('three publishers are accepted and the fourth is rejected', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=second'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=third'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=fourth'));
  assert.equal(ctx.getWebSockets('publisher').filter(ws => ws.readyState === WebSocket.OPEN).length, 3);
  assert.ok(messages(ctx.getWebSockets('rejected')[0]).some(m => m.type === 'publisher-rejected'));
});

test('media and capabilities are isolated by stream', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=second'));
  const [first, second] = ctx.getWebSockets('publisher');
  const firstViewer = viewer(ctx, 'viewer-a', 'first');
  const secondViewer = viewer(ctx, 'viewer-b', 'second');

  await room.webSocketMessage(first, packet(true));
  assert.equal(firstViewer.sent.filter(m => m instanceof ArrayBuffer).length, 1);
  assert.equal(secondViewer.sent.filter(m => m instanceof ArrayBuffer).length, 0);

  await room.webSocketMessage(secondViewer, JSON.stringify({ type: 'viewer-capabilities', protocol: 5, modes: { '720p30': ['vp8'] } }));
  const capabilityMessages = messages(second).filter(m => m.type === 'audience-capabilities');
  assert.ok(capabilityMessages.some(m => m.viewers === 1 && m.videoCodec === 'vp8'));
});

test('idle publishers do not force a multi-screen quality limit', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=observer&observe=1'));
  const observer = ctx.getWebSockets('observer')[0];
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first&publisherName=T%C3%A1cito'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=second&publisherName=Isabele'));

  const list = messages(observer).filter(m => m.type === 'stream-list').at(-1);
  assert.deepEqual(list.streams.map(stream => stream.id), ['first', 'second']);
  assert.deepEqual(list.streams.map(stream => stream.publisherName), ['Tácito', 'Isabele']);
  for (const publisher of ctx.getWebSockets('publisher')) {
    assert.ok(messages(publisher).some(m => m.type === 'room-policy' && m.activeStreams === 2 && m.maxModeKey === '1080p60'));
  }
});

test('keyframe recovery preserves audio before the first video keyframe', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const target = viewer(ctx, 'listener', 'first');
  await room.webSocketMessage(publisher, batch(packet(false, 1, 2), packet(false), packet(true), packet(false, 1, 2)));
  const output = target.sent.find(value => value instanceof ArrayBuffer);
  const view = new DataView(output);
  const kinds = [];
  let offset = 8;
  for (let i = 0; i < view.getUint16(6, true); i++) {
    const length = view.getInt32(offset, true);
    kinds.push(view.getUint8(offset + 4 + 5));
    offset += 4 + length;
  }
  assert.deepEqual(kinds, [2, 1, 2], 'recuperar vídeo não pode descartar áudio válido');
});

test('an audio-only viewer cannot block video negotiation and is included again on resume', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  const publisher = ctx.getWebSockets('publisher')[0];
  viewer(ctx, 'visible', 'first');
  const hidden = viewer(ctx, 'hidden', 'first');
  await room.webSocketMessage(hidden, JSON.stringify({ type: 'viewer-capabilities', protocol: 5, modes: { '720p30': ['vp8'] } }));
  await room.webSocketMessage(hidden, JSON.stringify({ type: 'set-video', enabled: false }));
  let caps = messages(publisher).filter(message => message.type === 'audience-capabilities').at(-1);
  assert.equal(caps.ready, true);
  assert.equal(caps.viewers, 1);
  assert.equal(caps.videoCodec, 'h264');
  const demand = messages(publisher).filter(message => message.type === 'viewer-demand').at(-1);
  assert.equal(demand.viewers, 2);
  assert.equal(demand.audioViewers, 2);
  await room.webSocketMessage(hidden, JSON.stringify({ type: 'set-video', enabled: true }));
  caps = messages(publisher).filter(message => message.type === 'audience-capabilities').at(-1);
  assert.equal(caps.ready, false);
  assert.equal(caps.viewers, 2);
});

test('quality follows active viewer layouts independently for each stream', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=second'));
  const [first, second] = ctx.getWebSockets('publisher');
  const focused = viewer(ctx, 'focused', 'first');
  const grid = viewer(ctx, 'grid', 'second');
  const policy = publisher => messages(publisher).filter(message => message.type === 'room-policy').at(-1).maxModeKey;
  await room.webSocketMessage(focused, JSON.stringify({ type: 'set-video', enabled: true, maxModeKey: '1080p60' }));
  await room.webSocketMessage(grid, JSON.stringify({ type: 'set-video', enabled: true, maxModeKey: '720p30' }));
  assert.equal(policy(first), '1080p60');
  assert.equal(policy(second), '720p30');
  const otherGrid = viewer(ctx, 'other-grid', 'first');
  await room.webSocketMessage(otherGrid, JSON.stringify({ type: 'set-video', enabled: true, maxModeKey: '720p30' }));
  assert.equal(policy(first), '720p30', 'ainda precisa proteger quem assiste à grade');
  await room.webSocketMessage(otherGrid, JSON.stringify({ type: 'set-video', enabled: false }));
  assert.equal(policy(first), '1080p60');
  const before = messages(first).filter(message => message.type === 'request-keyframe').length;
  await room.webSocketMessage(focused, JSON.stringify({ type: 'set-video', enabled: true, maxModeKey: '1080p60' }));
  assert.equal(messages(first).filter(message => message.type === 'request-keyframe').length, before,
    'atualizar o layout não deve iniciar recuperação desnecessária');
});

test('batched media uses one relay message and preserves keyframe recovery', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=viewer&streamId=first'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const target = ctx.getWebSockets('viewer')[0];

  await room.webSocketMessage(publisher, batch(packet(false), packet(true), packet(false), packet(true, 1, 2)));
  const media = target.sent.filter(value => value instanceof ArrayBuffer);
  assert.equal(media.length, 1, 'um lote deve atravessar o Relay em uma única mensagem');
  assert.deepEqual(Array.from(new Uint8Array(media[0]).slice(0, 4)), [65, 75, 66, 49]);
  assert.equal(new DataView(media[0]).getUint16(6, true), 3, 'delta anterior ao primeiro IDR deve ser removido');
  assert.equal(target.deserializeAttachment().waitingForKeyframe, false);
});

test('batched media removes audio for muted grid viewers', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=grid&streamId=first&audio=0'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const target = ctx.getWebSockets('viewer')[0];

  await room.webSocketMessage(publisher, batch(packet(true, 1, 2), packet(true), packet(false)));
  const media = target.sent.filter(value => value instanceof ArrayBuffer);
  assert.equal(media.length, 1);
  assert.equal(new DataView(media[0]).getUint16(6, true), 2);
});

test('muted grid viewer does not receive audio until it enables it', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=grid&streamId=first&audio=0'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const gridViewer = ctx.getWebSockets('viewer')[0];

  await room.webSocketMessage(publisher, packet(true, 1, 2));
  assert.equal(gridViewer.sent.filter(m => m instanceof ArrayBuffer).length, 0);
  await room.webSocketMessage(gridViewer, JSON.stringify({ type: 'set-audio', enabled: true }));
  await room.webSocketMessage(publisher, packet(true, 1, 2));
  assert.equal(gridViewer.sent.filter(m => m instanceof ArrayBuffer).length, 1);
});

test('hidden viewer stops receiving video and resumes only from a fresh keyframe', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=viewer&streamId=first'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const target = ctx.getWebSockets('viewer')[0];

  await room.webSocketMessage(target, JSON.stringify({ type: 'set-video', enabled: false }));
  assert.ok(messages(publisher).some(message => message.type === 'viewer-demand' && message.videoViewers === 0 && message.audioViewers === 1));
  await room.webSocketMessage(publisher, batch(packet(true), packet(true, 1, 2)));
  const hiddenMedia = target.sent.filter(value => value instanceof ArrayBuffer);
  assert.equal(hiddenMedia.length, 1);
  assert.equal(new Uint8Array(hiddenMedia[0])[5], 2, 'áudio deve continuar disponível com a Activity oculta');

  target.sent.length = 0;
  await room.webSocketMessage(target, JSON.stringify({ type: 'set-video', enabled: true }));
  assert.equal(messages(publisher).filter(message => message.type === 'request-keyframe').length, 1,
    'o pedido do ingresso já cobre a retomada imediata de visibilidade');
  assert.ok(messages(publisher).some(message => message.type === 'viewer-demand' && message.videoViewers === 1));
  await room.webSocketMessage(publisher, packet(false));
  assert.equal(target.sent.filter(value => value instanceof ArrayBuffer).length, 0);
  await room.webSocketMessage(publisher, packet(true));
  assert.equal(target.sent.filter(value => value instanceof ArrayBuffer).length, 1);
});

test('bursts of keyframe requests are coalesced per stream', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=viewer&streamId=first'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const target = ctx.getWebSockets('viewer')[0];

  await room.webSocketMessage(target, JSON.stringify({ type: 'request-keyframe', reason: 'stall' }));
  await room.webSocketMessage(target, JSON.stringify({ type: 'decoder-error' }));
  await room.webSocketMessage(target, JSON.stringify({ type: 'set-video', enabled: true }));

  assert.equal(messages(publisher).filter(message => message.type === 'request-keyframe').length, 1);

  room.lastKeyframeRequested.set('first', 0);
  await room.webSocketMessage(target, JSON.stringify({ type: 'request-keyframe', reason: 42 }));
  assert.equal(messages(publisher).filter(message => message.type === 'request-keyframe').at(-1).reason, 'viewer-request',
    'motivos malformados não devem chegar ao Capture');
});

test('viewer health is sanitized, aggregated and ignores paused video', async () => {
  const { room, ctx } = fixture();
  await room.fetch(new Request('https://relay/ws?role=publisher&publisherId=first'));
  await room.fetch(new Request('https://relay/ws?role=viewer&viewerId=viewer&streamId=first'));
  const publisher = ctx.getWebSockets('publisher')[0];
  const target = ctx.getWebSockets('viewer')[0];

  await room.webSocketMessage(target, JSON.stringify({
    type: 'viewer-health', decodedFps: 999, decodeQueue: -3, dropped: 4, resets: 2,
    audioBufferMs: 55, audioUnderflows: 3, stalled: true
  }));
  const health = messages(publisher).filter(message => message.type === 'viewer-health').at(-1);
  assert.equal(health.reporting, 1);
  assert.ok(health.sampleAt > 0, 'a amostra precisa identificar telemetria nova para a adaptação');
  assert.equal(health.minDecodedFps, 240);
  assert.equal(health.maxDecodeQueue, 0);
  assert.equal(health.audioBufferMs, 55);
  assert.equal(health.stalled, true);

  await room.webSocketMessage(target, JSON.stringify({ type: 'set-video', enabled: false }));
  const paused = messages(publisher).filter(message => message.type === 'viewer-health').at(-1);
  assert.equal(paused.reporting, 0);
  assert.equal(paused.stalled, false);
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
