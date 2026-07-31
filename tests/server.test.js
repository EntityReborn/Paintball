/* Server-side tests: the headless engine and the room's rules.
 *
 *   node --test tests/server.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHeadlessGame } = require('../server/engine.js');
const { Room } = require('../server/room.js');

/* ------------------------------------------------------------- headless */
test('the browser engine runs in node with no renderer or DOM', () => {
  const g = createHeadlessGame({ seed: 4242 });
  assert.equal(g.renderer, null, 'headless built a renderer');
  assert.equal(g.domElement, null, 'headless built a canvas');
  assert.ok(g.obstacleMeshes.length > 15, 'no obstacles');
  assert.equal(g.aliveCount(), 10, 'no targets');
  assert.equal(g.npcsAlive(), 4, 'no NPCs');
});

test('the same seed builds the same arena on both sides', () => {
  const a = createHeadlessGame({ seed: 99 });
  const b = createHeadlessGame({ seed: 99 });
  assert.equal(a.obstacleBoxes.length, b.obstacleBoxes.length, 'obstacle counts differ');
  for (let i = 0; i < a.obstacleBoxes.length; i++) {
    assert.deepEqual(
      a.obstacleBoxes[i].min.toArray().map(n => n.toFixed(4)),
      b.obstacleBoxes[i].min.toArray().map(n => n.toFixed(4)),
      `obstacle ${i} landed somewhere else`
    );
  }
  const c = createHeadlessGame({ seed: 100 });
  assert.notDeepEqual(
    a.obstacleBoxes[0].min.toArray(),
    c.obstacleBoxes[0].min.toArray(),
    'a different seed produced the same arena'
  );
});

test('the simulation advances without a renderer', () => {
  const g = createHeadlessGame({ seed: 7 });
  const before = g.npcs[0].root.position.clone();
  for (let i = 0; i < 120; i++) g.update(1 / 30);
  assert.ok(g.npcs[0].root.position.distanceTo(before) > 1, 'NPCs did not move');
  assert.ok(g.targets.some(t => t.wander), 'no drifting targets');
});

/* ----------------------------------------------------------------- room */
test('players join, appear in the snapshot, and leave', () => {
  const room = new Room({ seed: 1 });
  const a = room.join('ana');
  const b = room.join('bo');
  assert.equal(room.players.size, 2);

  const hello = room.hello(a);
  assert.equal(hello.seed, room.seed, 'hello did not carry the map seed');
  assert.equal(hello.id, a.id);
  assert.equal(hello.players.length, 1, 'hello should list the other player only');

  const snap = room.snapshot();
  assert.equal(snap.players.length, 2, 'snapshot player count');
  assert.equal(snap.npcs.length, room.game.npcs.length, 'snapshot NPC count');
  assert.equal(snap.targets.length, room.game.targets.length, 'snapshot target count');

  room.leave(b.id);
  assert.equal(room.snapshot().players.length, 1, 'a leaver stayed in the snapshot');
});

test('a normal move is accepted', () => {
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  const t0 = Date.now();
  p.lastStateAt = t0;
  const res = room.applyState(p.id, {
    x: 0.5, y: 1.7, z: 0.2, yaw: 1, pitch: 0.1, moving: true, grounded: true, vy: 0,
  }, t0 + 100);
  assert.ok(res.ok, res.reason);
  assert.equal(p.x, 0.5);
  assert.equal(p.violations, 0);
});

test('a teleport is rejected and corrected', () => {
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  const t0 = Date.now();
  p.lastStateAt = t0;
  const res = room.applyState(p.id, {
    x: 25, y: 1.7, z: 25, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
  }, t0 + 50);
  assert.ok(!res.ok, 'a 35u jump in 50ms was accepted');
  assert.ok(/moved/.test(res.reason), res.reason);
  assert.equal(p.x, 0, 'the server took the claimed position anyway');
  assert.equal(p.violations, 1, 'the violation was not counted');
  assert.equal(res.correction.t, 'correction');
  assert.equal(res.correction.x, 0);
});

test('sprinting flat out is still allowed', () => {
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  const cfg = room.game.cfg;
  let t = Date.now();
  let x = 0;
  p.lastStateAt = t;
  for (let i = 0; i < 20; i++) {
    t += 100;
    x += cfg.sprint * 0.1;                          // exactly sprint speed
    const res = room.applyState(p.id, {
      x, y: cfg.eye, z: 0, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
    }, t);
    assert.ok(res.ok, `sprint step ${i} rejected: ${res.reason}`);
  }
});

test('positions outside the arena are rejected', () => {
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  const outside = room.game.cfg.arena;
  p.lastStateAt = Date.now() - 1000;
  const res = room.applyState(p.id, {
    x: outside, y: 1.7, z: 0, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
  });
  assert.ok(!res.ok, 'a position outside the walls was accepted');
  assert.ok(/arena/.test(res.reason), res.reason);
});

test('nonsense values are rejected rather than poisoning the room', () => {
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  for (const bad of [
    { x: NaN, y: 1.7, z: 0, yaw: 0, pitch: 0 },
    { x: 1, y: Infinity, z: 0, yaw: 0, pitch: 0 },
    { x: 1, y: 1.7, z: 0, yaw: 'left', pitch: 0 },
    { x: 1, y: 1.7, z: 0, yaw: 0, pitch: 99 },
    { x: 1, y: 900, z: 0, yaw: 0, pitch: 0 },
  ]) {
    const res = room.applyState(p.id, bad);
    assert.ok(!res.ok, `accepted ${JSON.stringify(bad)}`);
  }
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'the player position went bad');
});

test('the room ticks and emits snapshots at the snapshot rate', () => {
  const sent = [];
  const room = new Room({ seed: 1, onBroadcast: m => sent.push(m) });
  room.join('ana');
  for (let i = 0; i < 30; i++) room.step(1000 / 30);   // one second of ticks
  assert.equal(room.tick, 30, 'tick count');
  assert.ok(sent.length >= 18 && sent.length <= 22, `expected ~20 snapshots, got ${sent.length}`);
  assert.equal(sent[0].t, 'snapshot');
  assert.ok(sent[0].players.length === 1);
});

test('snapshots stay small enough to send 20 times a second', () => {
  const room = new Room({ seed: 1 });
  for (let i = 0; i < 8; i++) room.join('p' + i);
  const bytes = Buffer.byteLength(JSON.stringify(room.snapshot()));
  assert.ok(bytes < 4000, `snapshot is ${bytes} bytes with 8 players`);
});

/* --------------------------------------------------------------- server */
test('the http server serves the client and a health check', async () => {
  process.env.PORT = '0';
  const { server, room } = require('../server/index.js');
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;

  const health = await get(port, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.ok(/<title>Paintball/.test(page.body), 'index.html was not served');

  const script = await get(port, '/src/game.js');
  assert.equal(script.status, 200);
  assert.ok(/createGame/.test(script.body));

  // no reaching outside the served directories
  const escape = await get(port, '/../package.json');
  assert.notEqual(escape.status, 200, 'path traversal was served');
  const hidden = await get(port, '/node_modules/ws/package.json');
  assert.equal(hidden.status, 404, 'node_modules is reachable');

  room.stop();
  server.close();
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
