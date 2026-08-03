/* Server-side tests: the headless engine and the room's rules.
 *
 *   node --test tests/server.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHeadlessGame } = require('../server/engine.js');
const { Room, SIM_HZ, SNAPSHOT_HZ, REWIND_MS, MAX_REWIND_MS, MOVE_BURST } =
  require('../server/room.js');

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
  p.x = 0; p.z = 0;                                  // the server spawns us somewhere clear
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
  p.x = 0; p.z = 0;                                  // the server spawns us somewhere clear
  p.settleUntil = 0;                                 // and past the grace for arriving
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
  p.x = 0; p.z = 0;                                  // the server spawns us somewhere clear
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
  const snaps = sent.filter(m => m.t === 'snapshot');
  assert.ok(snaps.length >= SNAPSHOT_HZ - 2 && snaps.length <= SNAPSHOT_HZ + 2,
            `expected ~${SNAPSHOT_HZ} snapshots, got ${snaps.length}`);
  assert.equal(sent[0].t, 'snapshot');
  assert.ok(sent[0].players.length === 1);
});

test('snapshots leave the server evenly spaced', () => {
  /* They used to come 33ms apart, then 67ms, then 33ms: a 20Hz snapshot rate
   * does not divide into a 30Hz tick, so the accumulator fired on alternate
   * ticks. Clients size their buffer on the gap between snapshots, and that
   * wobble was enough to empty it — the other player froze and then jumped. */
  const at = [];
  let clock = 0;
  const room = new Room({ seed: 1, onBroadcast: m => { if (m.t === 'snapshot') at.push(clock); } });
  room.join('ana');
  for (let i = 0; i < 60; i++) { clock += 1000 / SIM_HZ; room.step(1000 / SIM_HZ); }

  const gaps = at.slice(1).map((v, i) => v - at[i]);
  const worst = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(worst < 5, `snapshot spacing wanders by ${worst.toFixed(1)}ms: ${gaps.join(', ')}`);
});

test('snapshots stay small enough to send 20 times a second', () => {
  const room = new Room({ seed: 1 });
  for (let i = 0; i < 8; i++) room.join('p' + i);
  const bytes = Buffer.byteLength(JSON.stringify(room.snapshot()));
  assert.ok(bytes < 4000, `snapshot is ${bytes} bytes with 8 players`);
});

/* -------------------------------------------------------------- shooting */
function aimedAt(room, player, point) {
  const THREE = globalThis.THREE;
  const origin = new THREE.Vector3(player.x, player.y, player.z);
  const dir = point.clone().sub(origin).normalize();
  return { t: 'shot', origin: { x: origin.x, y: origin.y, z: origin.z },
           dir: { x: dir.x, y: dir.y, z: dir.z } };
}

// stand somewhere with a clear line to a point
function standClear(room, player, point) {
  const THREE = globalThis.THREE;
  const g = room.game;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    const eye = new THREE.Vector3(point.x + Math.sin(a) * 4, g.cfg.eye, point.z + Math.cos(a) * 4);
    if (Math.abs(eye.x) > 26 || Math.abs(eye.z) > 26) continue;
    if (!g.hasLineOfSight(eye, point)) continue;
    player.x = eye.x; player.y = g.cfg.eye; player.z = eye.z;
    return true;
  }
  return false;
}

test('server raycasts hit the real arena, not geometry stuck at the origin', () => {
  // three.js only refreshes world matrices while rendering, and the server
  // never renders: without an explicit update every wall and crate sits
  // unrotated at 0,0,0 and every shot hits a phantom.
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  p.x = 0; p.y = room.game.cfg.eye; p.z = 0;

  const down = room.applyShot(p.id, {
    t: 'shot', origin: { x: 0, y: 1.7, z: 0 }, dir: { x: 0, y: -1, z: 0 },
  });
  assert.ok(down.ok, down.reason);
  assert.equal(down.event.kind, 'miss');
  assert.ok(Math.abs(down.event.point.y) < 0.05,
            `a shot at the floor landed at y=${down.event.point.y}`);

  // the symptom this caused: an invisible barrier across the middle of the
  // arena that stopped bullets while the player walked through it, because
  // every obstacle sat unrotated at the origin and the floor stood on its edge
  p.x = 0; p.z = 6;                                  // stand where we shoot from
  const level = room.applyShot(p.id, {
    t: 'shot', origin: { x: 0, y: 1.7, z: 6 }, dir: { x: 0, y: 0, z: -1 },
  }, Date.now() + 5000);
  assert.ok(level.ok, level.reason);
  const stoppedAt = Math.hypot(level.event.point.x - 0, level.event.point.z - 6);
  assert.ok(stoppedAt > 8,
            `a level shot stopped after ${stoppedAt.toFixed(1)}u — invisible wall at the origin`);

  const THREE = globalThis.THREE;
  const g = room.game;
  // and a piece of cover really is where the client thinks it is
  const box = g.obstacleBoxes[0];
  const centre = box.getCenter(new THREE.Vector3());
  assert.ok(centre.length() > 3, 'the first obstacle is sitting at the origin');
  const mesh = g.obstacleMeshes[0];
  const meshPos = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
  assert.ok(meshPos.distanceTo(mesh.position) < 0.001,
            'the obstacle mesh has no world matrix');
});

test('a shot at an NPC puts it down and scores the shooter', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  const npc = room.game.npcs.find(n => n.alive && n.grounded);
  const chest = npc.root.position.clone().setY(1.0);
  assert.ok(standClear(room, p, chest), 'no clear line to an NPC');

  const res = room.applyShot(p.id, aimedAt(room, p, chest));
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'npc', `hit a ${res.event.kind} instead`);
  assert.ok(!npc.alive, 'the NPC survived a server-side hit');
  assert.equal(p.score, room.game.cfg.scoreNpc, 'the shooter was not paid');
  assert.equal(p.stats.npcsDown, 1);
  assert.equal(res.event.by, p.id, 'the event does not name the shooter');
});

test('a downed NPC stays down across ticks and snapshots', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  const npc = room.game.npcs.find(n => n.alive && n.grounded);
  const chest = npc.root.position.clone().setY(1.0);
  assert.ok(standClear(room, p, chest));
  room.applyShot(p.id, aimedAt(room, p, chest));

  const index = room.game.npcs.indexOf(npc);
  for (let i = 0; i < 120; i++) room.step(1000 / 30);      // four seconds
  assert.ok(!npc.alive, 'the NPC got back up');
  assert.equal(room.snapshot().npcs[index][4], 0, 'the snapshot still says it is alive');
});

test('a shot at a target breaks it and scores the shooter', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  const target = room.game.targets.find(t => t.alive);
  assert.ok(standClear(room, p, target.mesh.position), 'no clear line to a target');

  const res = room.applyShot(p.id, aimedAt(room, p, target.mesh.position));
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'target');
  assert.ok(!target.alive, 'the target survived');
  assert.equal(p.score, room.game.cfg.scoreTarget);
});

test('a shot that hits nothing costs the shooter points, floored at zero', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  p.score = 40;
  const down = { t: 'shot', origin: { x: p.x, y: p.y, z: p.z }, dir: { x: 0, y: -1, z: 0 } };
  const res = room.applyShot(p.id, down);
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'miss');
  assert.equal(p.score, 40 + room.game.cfg.scoreMiss, 'the miss did not cost anything');

  p.score = 5;
  p.lastShotAt = 0;
  room.applyShot(p.id, down, Date.now() + 1000);
  assert.equal(p.score, 0, 'the score went below zero');
});

test('firing faster than the weapon allows is rejected', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  const down = { t: 'shot', origin: { x: p.x, y: p.y, z: p.z }, dir: { x: 0, y: -1, z: 0 } };
  const t0 = Date.now();
  assert.ok(room.applyShot(p.id, down, t0).ok, 'the first shot was blocked');
  const second = room.applyShot(p.id, down, t0 + 20);
  assert.ok(!second.ok, 'a shot 20ms later was allowed');
  assert.ok(/rate of fire/.test(second.reason), second.reason);
  assert.ok(room.applyShot(p.id, down, t0 + 200).ok, 'a shot after the cooldown was blocked');
});

test('shooting from somewhere the player is not is rejected', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  const npc = room.game.npcs.find(n => n.alive);
  const chest = npc.root.position.clone().setY(1.0);
  // the player never moved from the origin, but claims to shoot point blank
  const res = room.applyShot(p.id, {
    t: 'shot',
    origin: { x: chest.x + 1, y: 1.7, z: chest.z },
    dir: { x: -1, y: 0, z: 0 },
  });
  assert.ok(!res.ok, 'a shot from across the map was accepted');
  assert.ok(/away from the player/.test(res.reason), res.reason);
  assert.ok(npc.alive, 'the NPC went down anyway');
});

test('malformed shots are rejected', () => {
  const room = new Room({ seed: 31 });
  const p = room.join('ana');
  for (const bad of [
    {},
    { origin: { x: 0, y: 1.7, z: 0 } },
    { origin: { x: 0, y: 1.7, z: 0 }, dir: { x: NaN, y: 0, z: 1 } },
    { origin: { x: 0, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: 0 } },
  ]) {
    const res = room.applyShot(p.id, Object.assign({ t: 'shot' }, bad), Date.now() + 99999);
    assert.ok(!res.ok, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the level needs both the NPCs and the targets cleared', () => {
  const room = new Room({ seed: 31 });
  room.join('watcher');                // the first join builds a fresh world
  const g = room.game;
  const level0 = g.state.level;

  g.npcs.slice().forEach(n => { if (n.alive) g.knockDownNPC(n); });
  assert.equal(g.npcsAlive(), 0, 'NPCs still standing');
  assert.equal(g.state.level, level0, 'the level ended with targets still up');

  g.targets.slice().forEach(t => {
    if (t.alive) { g.breakTarget(t, new globalThis.THREE.Vector3(0, 1, 0)); }
  });
  g.checkLevel();
  assert.equal(g.state.level, level0 + 1, 'clearing both did not finish the level');
});

test('a shot judged against where the NPC was still counts', () => {
  // the client aims at where it sees an NPC, one interpolation window behind
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  const THREE = globalThis.THREE;
  const npc = room.game.npcs.find(n => n.alive && n.grounded);

  const seen = npc.root.position.clone().setY(1.0);
  assert.ok(standClear(room, p, seen), 'no clear line');
  room.recordHistory(Date.now());

  // let it run on while the shot is "in flight"
  for (let i = 0; i < 6; i++) room.step(1000 / 30);
  const moved = npc.root.position.distanceTo(seen.clone().setY(npc.root.position.y));
  assert.ok(moved > 0.15, `the NPC barely moved (${moved.toFixed(2)}u), test proves nothing`);

  const res = room.applyShot(p.id, aimedAt(room, p, seen));
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'npc', 'the rewind did not credit the hit');
  assert.ok(!npc.alive, 'the NPC survived');
});

test('the rewind does not reach back further than its window', () => {
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  const npc = room.game.npcs.find(n => n.alive && n.grounded);
  const seen = npc.root.position.clone().setY(1.0);
  assert.ok(standClear(room, p, seen));
  const t0 = Date.now();
  room.recordHistory(t0);

  // ask about that position long after the window has closed
  const origin = new globalThis.THREE.Vector3(p.x, p.y, p.z);
  const dir = seen.clone().sub(origin).normalize();
  const stale = room.rewoundHit(origin, dir, 300, t0 + REWIND_MS + 500);
  assert.equal(stale, null, 'a shot from a second ago was still credited');
});

test('a client cannot ask for unlimited rewind', () => {
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  const npc = room.game.npcs.find(n => n.alive && n.grounded);
  const seen = npc.root.position.clone().setY(1.0);
  assert.ok(standClear(room, p, seen));
  room.recordHistory(Date.now() - MAX_REWIND_MS - 400);   // a very old sighting

  const shot = aimedAt(room, p, seen);
  shot.lag = 60000;                                        // "I saw it a minute ago"
  const res = room.applyShot(p.id, shot);
  assert.ok(res.ok, res.reason);
  // it may legitimately hit where the NPC stands now, but it must not be
  // credited from a sighting older than the ceiling
  if (res.event.kind === 'npc') {
    const moved = npc.root.position.distanceTo(seen.clone().setY(npc.root.position.y));
    assert.ok(moved < 1, 'a minute-old sighting was credited');
  }
});

test('the rewind cannot reach through cover', () => {
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  const g = room.game;
  const THREE = globalThis.THREE;

  // stand on the far side of a wall from the middle of the arena
  p.x = 0; p.y = g.cfg.eye; p.z = 0;
  room.recordHistory(Date.now());
  const origin = new THREE.Vector3(p.x, p.y, p.z);

  // fire at a wall: whatever is behind it must not be credited
  const dir = new THREE.Vector3(0, 0, -1);
  const wallHit = g.traceShot(origin, dir);
  const beyond = room.rewoundHit(origin, dir, wallHit.distance, Date.now());
  if (beyond) {
    assert.ok(beyond.distance <= wallHit.distance + 0.01,
              'the rewind credited something behind cover');
  }
});

test('the level turns over when a shot breaks the last target', () => {
  // the NPC path checks the level for itself; the target path did not, so an
  // arena cleared by breaking the last target just sat there empty
  const room = new Room({ seed: 55 });
  const p = room.join('ana');          // the first join builds a fresh world
  const g = room.game;
  const level0 = g.state.level;
  const THREE = globalThis.THREE;

  g.npcs.slice().forEach(n => { if (n.alive) g.knockDownNPC(n); });
  assert.equal(g.npcsAlive(), 0, 'NPCs still up');
  assert.equal(g.state.level, level0, 'ended before the targets were cleared');

  // break all but one by hand, then shoot the last one through the server
  const last = g.targets.filter(t => t.alive).pop();
  g.targets.forEach(t => {
    if (t.alive && t !== last) g.breakTarget(t, new THREE.Vector3(0, 1, 0));
  });
  assert.equal(g.aliveCount(), 1, 'expected one target left');

  assert.ok(standClear(room, p, last.mesh.position), 'no clear line to the last target');
  const res = room.applyShot(p.id, aimedAt(room, p, last.mesh.position));
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'target', `hit a ${res.event.kind}`);
  assert.equal(g.state.level, level0 + 1, 'the last target did not finish the level');
  assert.equal(g.npcsAlive(), g.npcs.length, 'the new level has bodies in it');
  assert.equal(g.aliveCount(), g.cfg.targetsPerLevel, 'the new level has no targets');
});

test('clearing the arena tells every client about the new level', () => {
  const sent = [];
  const room = new Room({ seed: 55, onBroadcast: m => sent.push(m) });
  const p = room.join('ana');          // the first join builds a fresh world
  const g = room.game;
  sent.length = 0;
  const THREE = globalThis.THREE;

  g.npcs.slice().forEach(n => { if (n.alive) g.knockDownNPC(n); });
  const last = g.targets.filter(t => t.alive).pop();
  g.targets.forEach(t => {
    if (t.alive && t !== last) g.breakTarget(t, new THREE.Vector3(0, 1, 0));
  });
  assert.ok(standClear(room, p, last.mesh.position));
  room.applyShot(p.id, aimedAt(room, p, last.mesh.position));

  const levelMsgs = sent.filter(m => m.t === 'levelStart');
  assert.equal(levelMsgs.length, 1, `expected one levelStart, got ${levelMsgs.length}`);
  assert.equal(levelMsgs[0].level, 2, 'wrong level number');
  assert.equal(levelMsgs[0].targets.length, g.cfg.targetsPerLevel, 'no targets in the message');
  assert.equal(levelMsgs[0].npcs, g.npcs.length, 'wrong NPC count in the message');
});

/* ---------------------------------------------------------------- perks */
test('the server owns the perks and hands them out', () => {
  const room = new Room({ seed: 88 });
  const p = room.join('ana');          // the first join builds a fresh world
  const g = room.game;

  g.perkSystem.clear();
  const perk = g.perkSystem.spawn({ kind: 'speed', x: 5, y: 1.1, z: 5 });
  assert.ok(perk, 'nothing spawned');

  p.x = 5; p.y = g.cfg.eye; p.z = 5;
  const picked = room.collectPerks();
  assert.equal(picked.length, 1, 'standing on it collected nothing');
  assert.equal(picked[0].kind, 'speed');
  assert.equal(picked[0].by, p.id, 'credited to the wrong player');
  assert.ok(g.perkSystem.held(p, 'speed'), 'the player did not get the effect');
  assert.equal(g.perkSystem.perks.length, 0, 'it was left on the ground');
});

test('a perk belongs to the player who reached it', () => {
  const room = new Room({ seed: 88 });
  const near = room.join('near');      // the first join builds a fresh world
  const far = room.join('far');
  const g = room.game;
  g.perkSystem.clear();
  g.perkSystem.spawn({ kind: 'clip', x: -8, y: 1.1, z: -8 });

  near.x = -8; near.z = -8; near.y = g.cfg.eye;
  far.x = 12; far.z = 12; far.y = g.cfg.eye;

  const picked = room.collectPerks();
  assert.equal(picked.length, 1, 'wrong number of pickups');
  assert.equal(picked[0].by, near.id, 'the wrong player got it');
  assert.ok(g.perkSystem.held(near, 'clip'), 'the collector has no perk');
  assert.ok(!g.perkSystem.held(far, 'clip'), 'the other player got it too');
});

test('a perk runs out on the server as well', () => {
  const room = new Room({ seed: 88 });
  const p = room.join('ana');          // the first join builds a fresh world
  const g = room.game;
  g.perkSystem.grant(p, 'fireRate');
  assert.ok(g.perkSystem.held(p, 'fireRate'));
  for (let i = 0; i < 30 * (g.cfg.perkDuration + 1); i++) room.step(1000 / 30);
  assert.ok(!g.perkSystem.held(p, 'fireRate'), 'it never expired');
});

test('rapid fire lets that player shoot faster, and only that player', () => {
  const room = new Room({ seed: 88 });
  const quick = room.join('quick');    // the first join builds a fresh world
  const plain = room.join('plain');
  const g = room.game;
  g.perkSystem.grant(quick, 'fireRate');

  const down = who => ({
    t: 'shot', origin: { x: who.x, y: who.y, z: who.z }, dir: { x: 0, y: -1, z: 0 },
  });
  const t0 = Date.now();
  assert.ok(room.applyShot(quick.id, down(quick), t0).ok, 'first shot blocked');
  assert.ok(room.applyShot(plain.id, down(plain), t0).ok, 'first shot blocked');

  // half the normal interval: allowed with the perk, refused without it
  const soon = t0 + Math.round(g.cfg.fireMs * 0.55);
  assert.ok(room.applyShot(quick.id, down(quick), soon).ok,
            'rapid fire was still rate limited');
  assert.ok(!room.applyShot(plain.id, down(plain), soon).ok,
            'a player without the perk fired too fast');
});

test('a bunch of state messages arriving together is not a teleport', () => {
  // packets do not arrive evenly; a hiccup delivers several in the same
  // millisecond, and each one still describes a legitimate 33ms of running
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  const cfg = room.game.cfg;
  p.x = 0; p.z = 0;
  const t0 = Date.now();
  p.lastStateAt = t0;

  // stand still for a moment, then four frames of running land at once
  let x = 0;
  for (let i = 0; i < 4; i++) {
    x += cfg.sprint / 30;
    const res = room.applyState(p.id, {
      x, y: cfg.eye, z: 0, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
    }, t0 + 300);                                  // all at the same instant
    assert.ok(res.ok, `packet ${i} refused: ${res.reason}`);
  }
  assert.ok(Math.abs(p.x - x) < 1e-9, 'the server did not take the moves');
});

test('a burst does not add up to running faster than anybody can run', () => {
  const room = new Room({ seed: 1 });
  const p = room.join('ana');
  const cfg = room.game.cfg;
  p.x = 0; p.z = 0;
  let t = Date.now();
  p.lastStateAt = t;

  // twice sprint speed, sustained: the allowance runs dry and stays dry
  let claim = 0;
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    t += 33;
    claim += cfg.sprint * 2 / 30;                  // where a speed hack says it is
    const res = room.applyState(p.id, {
      x: claim, y: cfg.eye, z: 0, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
    }, t);
    if (!res.ok) refused++;
  }
  assert.ok(refused > 20, `only ${refused} of 40 over-speed moves were refused`);
  const seconds = 40 * 0.033;
  const honest = cfg.sprint * 1.35 * seconds + MOVE_BURST;
  assert.ok(p.x < honest,
            `covered ${p.x.toFixed(1)}u in ${seconds.toFixed(1)}s, ` +
            `honestly good for ${honest.toFixed(1)}u`);
});

test('a state sent before the respawn landed is refused but not held against them', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  let t = Date.now();
  for (let i = 0; i < room.game.cfg.playerHealth; i++) { room.applyShot(ana.id, shot(), t); t += 200; }
  const diedAt = { x: bo.x, z: bo.z };
  room.updateHealth(t + room.game.cfg.respawnDelay * 1000 + 50);

  const before = bo.violations;
  // a packet still in flight, describing the spot they fell on
  const res = room.applyState(bo.id, {
    x: diedAt.x, y: room.game.cfg.eye, z: diedAt.z, yaw: 0, pitch: 0,
    moving: false, grounded: true, vy: 0,
  }, Date.now());
  assert.ok(!res.ok, 'the server let them walk back to where they died');
  assert.equal(bo.violations, before, 'a stale packet was counted as cheating');
});

test('the speed perk widens the movement budget for that player', () => {
  /* The allowance is a rate now, not a per-message ceiling, so the perk shows
   * up over a stretch of running rather than in a single step: held flat out
   * at the boosted speed, the boosted player is never questioned and the
   * unboosted one runs out of credit and gets pulled up. */
  const room = new Room({ seed: 88 });
  const fast = room.join('fast');      // the first join builds a fresh world
  const slow = room.join('slow');
  const g = room.game;
  g.perkSystem.grant(fast, 'speed');

  const boost = g.perkSystem.factor(fast, 'speed');
  assert.ok(boost > 1, 'the speed perk does not actually speed anybody up');

  let t = Date.now();
  fast.x = 0; fast.z = 0; fast.settleUntil = 0; fast.lastStateAt = t;
  slow.x = 0; slow.z = 5; slow.settleUntil = 0; slow.lastStateAt = t;
  const step = g.cfg.sprint * boost * 0.1;          // boosted sprint, per 100ms

  let fastRefused = 0;
  let slowRefused = 0;
  let fx = 0;
  let sx = 0;
  let dir = 1;
  for (let i = 0; i < 60; i++) {
    t += 100;
    // run back and forth rather than out through the wall: the arena bound is
    // a different rule, and this test is about the speed one
    if (Math.abs(fx + step * dir) > 18) dir = -dir;
    fx += step * dir;
    sx += step * dir;
    if (!room.applyState(fast.id, {
      x: fx, y: g.cfg.eye, z: 0, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
    }, t).ok) fastRefused++;
    if (!room.applyState(slow.id, {
      x: sx, y: g.cfg.eye, z: 5, yaw: 0, pitch: 0, moving: true, grounded: true, vy: 0,
    }, t).ok) slowRefused++;
  }
  assert.equal(fastRefused, 0, `the boosted player was pulled up ${fastRefused} times`);
  assert.ok(slowRefused > 0, 'an unboosted player kept up with a boosted one');
});

test('snapshots carry the world clock and whatever perks are out', () => {
  const room = new Room({ seed: 88 });
  room.join('ana');
  room.game.perkSystem.clear();
  room.game.perkSystem.spawn({ kind: 'doubleJump', x: 3, y: 1.1, z: -3 });
  for (let i = 0; i < 10; i++) room.step(1000 / 30);

  const snap = room.snapshot();
  assert.ok(typeof snap.wt === 'number', 'no world clock in the snapshot');
  assert.ok(snap.wt > 0, 'the world clock is not running');
  assert.equal(snap.perks.length, 1, 'the perk is not in the snapshot');
  assert.equal(snap.perks[0][1], 'doubleJump', 'wrong perk kind');
});

test('the sliders are in the same place on the server as on a client', () => {
  const a = new Room({ seed: 4242 });
  const b = new Room({ seed: 4242 });
  a.game.setWorldTime(12.75);
  b.game.setWorldTime(12.75);
  assert.equal(a.game.movers.length, b.game.movers.length, 'slider counts differ');
  for (let i = 0; i < a.game.movers.length; i++) {
    const pa = a.game.movers[i].mesh.position;
    const pb = b.game.movers[i].mesh.position;
    assert.ok(pa.distanceTo(pb) < 1e-9, `slider ${i} is somewhere else`);
  }
});

test('the balcony exists server-side and stops bullets', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('ana');          // the first join builds a fresh world
  const g = room.game;
  assert.ok(g.balcony, 'no balcony on the server');
  const deck = g.balcony.parts.find(p => p.mesh.name === 'balconyDeck');
  assert.ok(deck, 'no deck');

  // fire up into the underside of the deck
  const c = deck.box.getCenter(new globalThis.THREE.Vector3());
  p.x = c.x; p.y = g.cfg.eye; p.z = c.z;
  const res = room.applyShot(p.id, {
    t: 'shot', origin: { x: c.x, y: g.cfg.eye, z: c.z }, dir: { x: 0, y: 1, z: 0 },
  });
  assert.ok(res.ok, res.reason);
  assert.ok(res.event.point.y < deck.box.max.y + 0.1,
            'the shot went through the balcony');
});

/* ----------------------------------------------------------- fresh maps */
test('the first player into an empty room gets a new map', () => {
  const room = new Room({});
  const atBoot = room.seed;
  const player = room.join('ana');
  assert.notEqual(room.seed, atBoot, 'the map was not rebuilt on the first join');
  assert.equal(room.game.state.level, 1, 'the new match did not start at level one');
  assert.equal(room.hello(player).seed, room.seed, 'hello carried the old seed');
});

test('a second player joins the map already in play', () => {
  const room = new Room({});
  room.join('ana');
  const seed = room.seed;
  const arena = room.game.arenaFingerprint();
  room.join('bo');
  assert.equal(room.seed, seed, 'the second join rebuilt the world underneath the first');
  assert.equal(room.game.arenaFingerprint(), arena, 'the arena changed underneath them');
});

test('the room empties and the next session starts somewhere new', () => {
  const room = new Room({});
  const a = room.join('ana');
  const b = room.join('bo');
  const played = room.seed;

  room.leave(a.id);
  assert.equal(room.seed, played, 'the map changed while somebody was still in it');
  room.leave(b.id);
  assert.equal(room.seed, played, 'the map changed before anyone rejoined');

  room.join('cara');
  assert.notEqual(room.seed, played, 'the next session inherited the old map');
});

test('nothing from the last session leaks into the next one', () => {
  const room = new Room({});
  const first = room.join('ana');
  const g = room.game;

  // play a bit: clear the arena, collect a perk, run the clock on
  g.npcs.slice().forEach(n => { if (n.alive) g.knockDownNPC(n); });
  g.targets.slice().forEach(t => {
    if (t.alive) g.breakTarget(t, new globalThis.THREE.Vector3(0, 1, 0));
  });
  g.checkLevel();
  for (let i = 0; i < 60; i++) room.step(1000 / 30);
  assert.ok(room.game.state.level > 1, 'the test did not actually advance a level');
  const leftBehind = {
    level: room.game.state.level,
    worldTime: room.game.state.worldTime,
  };

  room.leave(first.id);
  room.join('bo');

  assert.equal(room.game.state.level, 1, `level carried over (${leftBehind.level})`);
  assert.equal(room.game.npcsAlive(), room.game.npcs.length, 'bodies carried over');
  assert.equal(room.game.aliveCount(), room.game.cfg.targetsPerLevel, 'broken targets carried over');
  assert.equal(room.game.perkSystem.perks.length, 0, 'perks were left on the ground');
  assert.ok(room.game.state.worldTime < leftBehind.worldTime,
            'the world clock carried over');
  assert.equal(room.history.length, 0, 'lag-compensation history carried over');
});

test('a pinned seed keeps the same arena but still starts a fresh match', () => {
  const room = new Room({ seed: 4242 });
  const a = room.join('ana');
  const arena = room.game.arenaFingerprint();
  assert.equal(room.seed, 4242, 'the pinned seed was ignored');

  room.game.npcs.slice().forEach(n => { if (n.alive) room.game.knockDownNPC(n); });
  room.leave(a.id);
  room.join('bo');

  assert.equal(room.seed, 4242, 'the pinned seed did not survive the rebuild');
  assert.equal(room.game.arenaFingerprint(), arena, 'the pinned arena came out different');
  assert.equal(room.game.npcsAlive(), room.game.npcs.length, 'the NPCs were still down');
});

test('the level broadcast still works after a rebuild', () => {
  const sent = [];
  const room = new Room({ onBroadcast: m => sent.push(m) });
  room.join('ana');            // rebuilds, and must re-attach the level listener
  sent.length = 0;

  const g = room.game;
  g.npcs.slice().forEach(n => { if (n.alive) g.knockDownNPC(n); });
  g.targets.slice().forEach(t => {
    if (t.alive) g.breakTarget(t, new globalThis.THREE.Vector3(0, 1, 0));
  });
  g.checkLevel();

  const levels = sent.filter(m => m.t === 'levelStart');
  assert.equal(levels.length, 1, `expected one levelStart, got ${levels.length}`);
  assert.equal(levels[0].level, 2, 'wrong level in the broadcast');
});

/* ------------------------------------------------------- shooting people */
// stand `shooter` a few metres from `victim`, facing them
function faceOff(room, shooter, victim, range = 6) {
  const g = room.game;
  victim.x = 0; victim.z = 0; victim.y = g.cfg.eye;
  shooter.x = range; shooter.z = 0; shooter.y = g.cfg.eye;
  // past the protection everybody arrives with: these are damage tests, and
  // the shield has tests of its own
  shooter.shieldUntil = 0;
  victim.shieldUntil = 0;
  return () => {
    const THREE = globalThis.THREE;
    const o = { x: shooter.x, y: shooter.y, z: shooter.z };
    const d = new THREE.Vector3(victim.x - o.x, (victim.y - 0.8) - o.y, victim.z - o.z)
      .normalize();
    return { t: 'shot', origin: o, dir: { x: d.x, y: d.y, z: d.z } };
  };
}

test('players arrive somewhere clear, not on top of each other', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const lim = room.game.cfg.arena / 2;
  for (const p of [ana, bo]) {
    assert.ok(Math.abs(p.x) < lim && Math.abs(p.z) < lim, 'spawned outside the arena');
    const probe = new globalThis.THREE.Vector3(p.x, room.game.cfg.eye, p.z);
    assert.ok(!room.game.obstacleBoxes.some(b => b.containsPoint(probe)),
              'spawned inside a piece of cover');
  }
  assert.ok(Math.hypot(ana.x - bo.x, ana.z - bo.z) > 2,
            'two players spawned in the same spot');
  // and the client is told where it landed
  assert.equal(room.hello(bo).you.x, bo.x, 'hello does not carry the spawn point');
});

test('a player starts on full health', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('ana');
  assert.equal(p.health, room.game.cfg.playerHealth, 'not on full health');
  assert.equal(room.hello(p).you.maxHealth, room.game.cfg.playerHealth,
               'hello does not say how much health there is');
});

test('shooting somebody takes a point off them', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);

  const res = room.applyShot(ana.id, shot());
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'player', `hit a ${res.event.kind}`);
  assert.equal(res.event.victim, bo.id, 'the wrong player was hit');
  assert.equal(bo.health, room.game.cfg.playerHealth - 1, 'no damage was done');
  assert.equal(res.event.killed, false, 'one hit killed them');
});

test('ten hits kill, and pay the shooter', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const max = room.game.cfg.playerHealth;

  let t = Date.now();
  let killed = null;
  for (let i = 1; i <= max; i++) {
    const res = room.applyShot(ana.id, shot(), t);
    t += 200;
    assert.ok(res.ok, `shot ${i} refused: ${res.reason}`);
    assert.equal(res.event.kind, 'player', `shot ${i} missed`);
    if (res.event.killed) killed = i;
  }
  assert.equal(killed, max, `died on hit ${killed}, expected ${max}`);
  assert.equal(ana.score, room.game.cfg.scoreKill, 'the kill did not pay');
  assert.equal(ana.kills, 1, 'the kill was not counted');
  assert.equal(bo.deaths, 1, 'the death was not counted');
  assert.ok(bo.deadUntil > 0, 'the victim is not down');
});

test('you cannot shoot yourself', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  ana.x = 0; ana.z = 0; ana.y = room.game.cfg.eye;
  // straight down through our own box
  const res = room.applyShot(ana.id, {
    t: 'shot', origin: { x: 0, y: ana.y, z: 0 }, dir: { x: 0, y: -1, z: 0 },
  });
  assert.ok(res.ok, res.reason);
  assert.notEqual(res.event.kind, 'player', 'shot ourselves');
  assert.equal(ana.health, room.game.cfg.playerHealth, 'we took damage from our own round');
});

test('a body does not stop bullets, and cannot shoot back', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  let t = Date.now();
  for (let i = 0; i < room.game.cfg.playerHealth; i++) { room.applyShot(ana.id, shot(), t); t += 200; }
  assert.ok(bo.deadUntil, 'not dead');

  const through = room.applyShot(ana.id, shot(), t);
  assert.ok(through.ok, through.reason);
  assert.notEqual(through.event.kind, 'player', 'a body was still shootable');

  const fromTheGrave = room.applyShot(bo.id, {
    t: 'shot', origin: { x: bo.x, y: bo.y, z: bo.z }, dir: { x: 0, y: -1, z: 0 },
  }, t);
  assert.ok(!fromTheGrave.ok, 'a dead player got a shot off');
});

test('cover stops a shot before it reaches somebody behind it', () => {
  const room = new Room({ seed: 4242 });
  const g = room.game;
  const ana = room.join('ana');
  const bo = room.join('bo');

  // put bo on the far side of a piece of cover, ana on the near side
  const box = g.obstacleBoxes.find(b => b.max.y > 1.8);
  assert.ok(box, 'no tall cover in this arena');
  const c = box.getCenter(new globalThis.THREE.Vector3());
  const size = box.getSize(new globalThis.THREE.Vector3());
  bo.x = c.x - size.x / 2 - 1.2; bo.z = c.z; bo.y = g.cfg.eye;
  ana.x = c.x + size.x / 2 + 1.2; ana.z = c.z; ana.y = g.cfg.eye;

  const THREE = globalThis.THREE;
  const d = new THREE.Vector3(bo.x - ana.x, 0, bo.z - ana.z).normalize();
  const res = room.applyShot(ana.id, {
    t: 'shot', origin: { x: ana.x, y: ana.y, z: ana.z }, dir: { x: d.x, y: d.y, z: d.z },
  });
  assert.ok(res.ok, res.reason);
  assert.notEqual(res.event.kind, 'player', 'the shot went through the cover');
  assert.equal(bo.health, g.cfg.playerHealth, 'they took damage through cover');
});

test('health comes back a point at a time', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const cfg = room.game.cfg;

  let t = Date.now();
  for (let i = 0; i < 3; i++) { room.applyShot(ana.id, shot(), t); t += 200; }
  t -= 200;                                    // the moment of the last hit
  assert.equal(bo.health, cfg.playerHealth - 3, 'wrong damage to start from');

  // not yet
  room.updateHealth(t + cfg.healEvery * 1000 - 100);
  assert.equal(bo.health, cfg.playerHealth - 3, 'healed early');

  // one point per interval, and no more
  room.updateHealth(t + cfg.healEvery * 1000 + 10);
  assert.equal(bo.health, cfg.playerHealth - 2, 'did not heal a point');
  room.updateHealth(t + cfg.healEvery * 1000 + 20);
  assert.equal(bo.health, cfg.playerHealth - 2, 'healed twice in one interval');
  room.updateHealth(t + cfg.healEvery * 2000 + 30);
  assert.equal(bo.health, cfg.playerHealth - 1, 'did not heal the second point');
});

test('healing stops at full health', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('ana');
  const cfg = room.game.cfg;
  for (let i = 0; i < 20; i++) room.updateHealth(Date.now() + i * cfg.healEvery * 1000);
  assert.equal(p.health, cfg.playerHealth, 'healed past full');
});

test('being shot restarts the wait for the next point of health', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const cfg = room.game.cfg;

  const t0 = Date.now();
  room.applyShot(ana.id, shot(), t0);
  // most of the way to a heal, then shot again
  room.updateHealth(t0 + cfg.healEvery * 1000 - 200);
  room.applyShot(ana.id, shot(), t0 + cfg.healEvery * 1000 - 100);
  room.updateHealth(t0 + cfg.healEvery * 1000 + 50);
  assert.equal(bo.health, cfg.playerHealth - 2, 'healed straight after being hit');
});

test('the dead come back whole, somewhere else', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const cfg = room.game.cfg;

  let t = Date.now();
  for (let i = 0; i < cfg.playerHealth; i++) { room.applyShot(ana.id, shot(), t); t += 200; }
  const diedAt = { x: bo.x, z: bo.z };

  const early = room.updateHealth(t + cfg.respawnDelay * 1000 - 500);
  assert.equal(early.length, 0, 'came back early');
  assert.ok(bo.deadUntil, 'no longer waiting');

  const events = room.updateHealth(t + cfg.respawnDelay * 1000 + 50);
  assert.equal(events.length, 1, 'no respawn was announced');
  assert.equal(events[0].t, 'respawn');
  assert.equal(events[0].id, bo.id);
  assert.equal(bo.health, cfg.playerHealth, 'came back hurt');
  assert.equal(bo.deadUntil, 0, 'still marked as dead');
  assert.ok(Math.hypot(bo.x - diedAt.x, bo.z - diedAt.z) > 1,
            'came back exactly where they died');
  assert.ok(Math.abs(bo.x) < cfg.arena / 2 && Math.abs(bo.z) < cfg.arena / 2,
            'came back outside the arena');
});

test('a dead player is left out of the world until they are back', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  let t = Date.now();
  for (let i = 0; i < room.game.cfg.playerHealth; i++) { room.applyShot(ana.id, shot(), t); t += 200; }

  const entry = room.snapshot().players.find(p => p[0] === bo.id);
  assert.ok(entry, 'the dead player vanished from the snapshot entirely');
  assert.equal(entry[10], 1, 'the snapshot does not say they are down');
  assert.equal(entry[9], 0, 'the snapshot does not show them at zero health');

  // and their claimed position is ignored while they wait
  const res = room.applyState(bo.id, {
    x: 5, y: room.game.cfg.eye, z: 5, yaw: 0, pitch: 0,
    moving: true, grounded: true, vy: 0,
  }, t);
  assert.ok(!res.ok, 'a dead player moved themselves');
});

test('health rides along in the snapshot', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  room.applyShot(ana.id, shot());

  const entry = room.snapshot().players.find(p => p[0] === bo.id);
  assert.equal(entry[9], room.game.cfg.playerHealth - 1, 'the snapshot has the wrong health');
});

test('a shot at where somebody was still counts', () => {
  // the same rewind the NPCs get, or nobody could ever hit a moving player
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const aimed = shot();

  room.recordHistory(Date.now());
  // bo has run on since the shot was aimed
  bo.x = 4; bo.z = 3;
  const res = room.applyShot(ana.id, Object.assign({ lag: 120 }, aimed));
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'player', 'the rewind did not credit the hit');
  assert.equal(bo.health, room.game.cfg.playerHealth - 1, 'no damage was done');
});

/* ------------------------------------------------------------ hit volume */
test('the box a shot is tested against is the box on the figure', () => {
  /* The client raycasts the mesh hung on the figure; the server builds its own
   * for a player. Written out separately they drift, and a drifted hitbox is a
   * shot that lands on one screen and not the other. */
  const room = new Room({ seed: 4242 });
  const g = room.game;
  const THREE = globalThis.THREE;
  const H = globalThis.PB.HIT;

  const npc = g.npcs[0];
  npc.root.position.set(4, 0, -3);
  npc.root.rotation.set(0, 0, 0);
  npc.root.updateMatrixWorld(true);
  const onFigure = new THREE.Box3().setFromObject(npc.hitbox);

  const player = room.join('ana');
  player.x = 4; player.z = -3; player.y = g.cfg.eye;      // same spot, feet at 0
  const onServer = room.playerBox(player, new THREE.Box3());

  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(onFigure.min[axis] - onServer.min[axis]) < 0.001,
              `${axis} min: figure ${onFigure.min[axis].toFixed(3)}, ` +
              `server ${onServer.min[axis].toFixed(3)}`);
    assert.ok(Math.abs(onFigure.max[axis] - onServer.max[axis]) < 0.001,
              `${axis} max: figure ${onFigure.max[axis].toFixed(3)}, ` +
              `server ${onServer.max[axis].toFixed(3)}`);
  }
  assert.ok(Math.abs(H.half * 2 - (onServer.max.x - onServer.min.x)) < 0.001,
            'the server box is not the width PB.HIT asks for');
});

test('the hit volume hugs the body rather than the pose', () => {
  const g = createHeadlessGame({ seed: 7 });
  const THREE = globalThis.THREE;
  const PB = globalThis.PB;
  const H = PB.HIT;

  const fig = PB.buildFigure({
    geo: PB.figureGeometry(), shadows: false, variant: 'player',
    color: new THREE.Color(1, 1, 1), trim: new THREE.Color(1, 1, 1),
    accent: new THREE.Color(1, 1, 1),
  });
  PB.poseFigure(fig, { phase: 0, grounded: true, moving: false });
  fig.root.updateMatrixWorld(true);

  // the torso and head are what a player aims at; both must be inside
  for (const part of [fig.torso, fig.head]) {
    const box = new THREE.Box3().setFromObject(part);
    assert.ok(box.min.x > -H.half && box.max.x < H.half,
              `${part.name || 'part'} sticks out sideways: ` +
              `${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} against ±${H.half}`);
    assert.ok(box.min.y > H.bottom && box.max.y < H.top,
              `${part.name || 'part'} sticks out vertically`);
  }

  // and no wasted air: the soles and the crown should be close to the edges
  const body = new THREE.Box3();
  fig.root.traverse(o => { if (o.isMesh && o.visible && o !== fig.hitbox) body.expandByObject(o); });
  assert.ok(H.bottom <= body.min.y + 0.03 && H.bottom > body.min.y - 0.06,
            `the floor of the box is at ${H.bottom}, the soles at ${body.min.y.toFixed(2)}`);
  assert.ok(H.top >= body.max.y - 0.03 && H.top < body.max.y + 0.08,
            `the roof of the box is at ${H.top}, the crown at ${body.max.y.toFixed(2)}`);
  assert.ok(g.npcs.length > 0, 'no NPCs to have built one for');
});

test('it is square in plan, so facing does not change how easy you are to hit', () => {
  const H = globalThis.PB.HIT;
  // the server's box does not turn with the figure; anything but square would
  // make a player broader from the side than from the front
  const room = new Room({ seed: 4242 });
  const THREE = globalThis.THREE;
  const p = room.join('ana');
  p.x = 0; p.z = 0; p.y = room.game.cfg.eye;
  const box = room.playerBox(p, new THREE.Box3());
  const width = box.max.x - box.min.x;
  const depth = box.max.z - box.min.z;
  assert.ok(Math.abs(width - depth) < 0.001, `${width.toFixed(2)} across, ${depth.toFixed(2)} deep`);
  assert.ok(width < 0.6, `${width.toFixed(2)} across is not what anyone would call tight`);
  assert.ok(H.height < 1.75 && H.height > 1.5, `${H.height.toFixed(2)} tall`);
});

/* -------------------------------------------------- shields and packs */
test('you arrive, and come back, under a shield', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const cfg = room.game.cfg;
  const shot = faceOff(room, ana, bo);

  // faceOff cleared it; put the arrival shield back the way joining leaves it
  const t0 = Date.now();
  bo.shieldUntil = t0 + cfg.spawnShield * 1000;
  assert.ok(room.shielded(bo, t0), 'not shielded on arrival');

  const res = room.applyShot(ana.id, shot(), t0);
  assert.equal(res.event.kind, 'player', 'the round did not reach them');
  assert.equal(res.event.blocked, 'shield', `blocked as ${res.event.blocked}`);
  assert.equal(bo.health, cfg.playerHealth, 'a shielded player took damage');
  assert.equal(ana.stats.shotsHit, 0, 'a blocked round was counted as a hit');

  // and it runs out
  const after = t0 + cfg.spawnShield * 1000 + 50;
  assert.ok(!room.shielded(bo, after), 'the shield never expired');
  const later = room.applyShot(ana.id, shot(), after);
  assert.equal(later.event.blocked, null, 'still blocking after it expired');
  assert.equal(bo.health, cfg.playerHealth - 1, 'no damage once it lapsed');
});

test('the shield perk stops damage for as long as it is held', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const g = room.game;

  g.perkSystem.grant(bo, 'shield');
  assert.ok(room.shielded(bo), 'the perk did not shield them');
  const res = room.applyShot(ana.id, shot());
  assert.equal(res.event.blocked, 'shield');
  assert.equal(bo.health, g.cfg.playerHealth, 'took damage through the perk');

  // it is deliberately shorter than the rest
  const def = g.perkSystem.kindByName('shield');
  assert.ok(def.duration < g.cfg.perkDuration,
            `shield lasts ${def.duration}s, the standard ${g.cfg.perkDuration}s`);
  g.perkSystem.tickHolder(bo, def.duration + 0.1);
  assert.ok(!room.shielded(bo), 'the perk never wore off');
});

test('the dead come back with a moment of protection', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const cfg = room.game.cfg;

  let t = Date.now();
  for (let i = 0; i < cfg.playerHealth; i++) { room.applyShot(ana.id, shot(), t); t += 200; }
  const back = t + cfg.respawnDelay * 1000 + 50;
  room.updateHealth(back);
  assert.ok(room.shielded(bo, back), 'came back with no protection at all');
  assert.ok(!room.shielded(bo, back + cfg.spawnShield * 1000 + 50), 'protection never ends');
});

test('the arena has two health packs, in the same places on both sides', () => {
  const a = createHeadlessGame({ seed: 321 });
  const b = createHeadlessGame({ seed: 321 });
  assert.equal(a.medkits.length, 2, `${a.medkits.length} packs`);
  for (let i = 0; i < a.medkits.length; i++) {
    assert.equal(+a.medkits[i].x.toFixed(4), +b.medkits[i].x.toFixed(4), `pack ${i} x`);
    assert.equal(+a.medkits[i].z.toFixed(4), +b.medkits[i].z.toFixed(4), `pack ${i} z`);
  }
  // and no pack buried inside a piece of cover
  const THREE = globalThis.THREE;
  for (const kit of a.medkits) {
    const probe = new THREE.Vector3(kit.x, 0.9, kit.z);
    assert.ok(!a.obstacleBoxes.some(box => box.distanceToPoint(probe) < 1),
              'a pack is inside the cover');
  }
});

test('walking over a pack puts a hurt player back to full', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const g = room.game;
  const cfg = g.cfg;

  let t = Date.now();
  for (let i = 0; i < 4; i++) { room.applyShot(ana.id, shot(), t); t += 200; }
  assert.equal(bo.health, cfg.playerHealth - 4, 'wrong damage to start from');

  const kit = g.medkits[0];
  bo.x = kit.x; bo.z = kit.z; bo.y = cfg.eye;
  const events = room.updateMedkits(t);
  assert.equal(events.length, 1, 'nothing was picked up');
  assert.equal(events[0].t, 'medkit');
  assert.equal(events[0].by, bo.id);
  assert.equal(bo.health, cfg.playerHealth, 'not put back to full');
  assert.equal(kit.ready, false, 'the pack is still standing there');

  // a second player cannot take the same one
  ana.x = kit.x; ana.z = kit.z; ana.y = cfg.eye;
  ana.health = 3;
  assert.equal(room.updateMedkits(t + 10).length, 0, 'took a pack that was gone');
  assert.equal(ana.health, 3, 'healed off a pack that had been taken');

  // and it comes back
  room.updateMedkits(t + cfg.medkitRespawn * 1000 + 10);
  assert.equal(kit.ready, false, 'the pack came back and was not taken again');
  assert.equal(ana.health, cfg.playerHealth, 'whoever was standing there missed it');
});

test('a player on full health walks straight over a pack', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('ana');
  const kit = room.game.medkits[0];
  p.x = kit.x; p.z = kit.z; p.y = room.game.cfg.eye;
  assert.equal(room.updateMedkits().length, 0, 'wasted a pack');
  assert.equal(kit.ready, true, 'the pack was taken for nothing');
});

test('which packs are standing rides along in the snapshot', () => {
  const room = new Room({ seed: 4242 });
  room.join('ana');
  assert.deepEqual(room.snapshot().kits, [1, 1], 'both packs should be out');
  room.game.medkits[0].ready = false;
  assert.deepEqual(room.snapshot().kits, [0, 1], 'a taken pack still reads as out');
});

/* ------------------------------------------------------------ preferences */
test('a rename reaches the whole room', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('ana');
  const out = room.setPrefs(p.id, { name: 'anastasia' });
  assert.equal(out.t, 'prefs');
  assert.equal(out.id, p.id);
  assert.equal(out.name, 'anastasia');
  assert.equal(p.name, 'anastasia', 'the room still has the old name');
  assert.equal(room.publicPlayer(p).name, 'anastasia');
});

test('a name is cleaned the same way on both sides', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('<script>alert(1)</script>');
  // stripped to the allow-list, then cut to length
  assert.equal(p.name, 'scriptalert1scri', `joined as ${p.name}`);
  assert.equal(room.setPrefs(p.id, { name: '  bo  bo  ' }).name, 'bo bo');
  assert.equal(room.setPrefs(p.id, { name: '!!!' }).name, 'player',
               'a name of nothing usable should fall back');
  const long = room.setPrefs(p.id, { name: 'abcdefghijklmnopqrstuvwxyz' }).name;
  assert.ok(long.length <= 16, `no length limit: got ${long.length}`);
});

test('a player who is out of the fight neither takes damage nor deals it', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  const cfg = room.game.cfg;

  room.setPrefs(bo.id, { pvp: false });
  assert.equal(bo.pvp, false);
  let res = room.applyShot(ana.id, shot());
  assert.notEqual(res.event.kind, 'player', 'shot somebody who is out of it');
  assert.equal(bo.health, cfg.playerHealth, 'they took damage anyway');

  // and the other way round: back in, but the shooter is out
  room.setPrefs(bo.id, { pvp: true });
  room.setPrefs(ana.id, { pvp: false });
  res = room.applyShot(ana.id, shot(), Date.now() + 500);
  assert.notEqual(res.event.kind, 'player', 'a player who is out of it still dealt damage');
  assert.equal(bo.health, cfg.playerHealth, 'damage was dealt by somebody who opted out');

  // both back in, and it works again
  room.setPrefs(ana.id, { pvp: true });
  ana.shieldUntil = 0; bo.shieldUntil = 0;
  res = room.applyShot(ana.id, shot(), Date.now() + 1000);
  assert.equal(res.event.kind, 'player', 'nobody could be hit after opting back in');
  assert.equal(bo.health, cfg.playerHealth - 1);
});

test('a player out of the fight does not stop other rounds either', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const cid = room.join('cid');
  const g = room.game;

  // bo stands between ana and cid, and is out of the fight
  ana.x = 12; ana.z = 0; ana.y = g.cfg.eye;
  bo.x = 6; bo.z = 0; bo.y = g.cfg.eye;
  cid.x = 0; cid.z = 0; cid.y = g.cfg.eye;
  ana.shieldUntil = 0; bo.shieldUntil = 0; cid.shieldUntil = 0;
  room.setPrefs(bo.id, { pvp: false });

  const THREE = globalThis.THREE;
  const o = { x: ana.x, y: ana.y, z: ana.z };
  const d = new THREE.Vector3(cid.x - o.x, (cid.y - 0.8) - o.y, cid.z - o.z).normalize();
  const res = room.applyShot(ana.id, { t: 'shot', origin: o, dir: { x: d.x, y: d.y, z: d.z } });
  assert.equal(res.event.kind, 'player', `hit a ${res.event.kind}`);
  assert.equal(res.event.victim, cid.id, 'the round stopped on the wrong player');
  assert.equal(bo.health, g.cfg.playerHealth, 'the bystander took the round');
});

test('the snapshot says who is shielded and who is out of the fight', () => {
  const room = new Room({ seed: 4242 });
  const p = room.join('ana');
  let entry = room.snapshot().players[0];
  assert.equal(entry[11], 1, 'a player who just arrived should be shielded');
  assert.equal(entry[12], 1, 'and in the fight');

  p.shieldUntil = 0;
  room.setPrefs(p.id, { pvp: false });
  entry = room.snapshot().players[0];
  assert.equal(entry[11], 0, 'still shielded');
  assert.equal(entry[12], 0, 'still in the fight');
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
