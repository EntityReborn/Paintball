/* Server-side tests: the headless engine and the room's rules.
 *
 *   node --test tests/server.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHeadlessGame } = require('../server/engine.js');
const { Room, SIM_HZ, SNAPSHOT_HZ, MAX_REWIND_MS, MOVE_BURST, CHAT_MAX, CHAT_BURST,
        GRACE_MS } = require('../server/room.js');

/* ------------------------------------------------------------- headless */
test('the browser engine runs in node with no renderer or DOM', () => {
  const g = createHeadlessGame({ seed: 4242 });
  assert.equal(g.renderer, null, 'headless built a renderer');
  assert.equal(g.domElement, null, 'headless built a canvas');
  assert.ok(g.obstacleMeshes.length > 15, 'no obstacles');
  assert.equal(g.aliveCount(), 10, 'no targets');
  assert.equal(g.npcsAlive(), g.cfg.npcsPerLevel + g.cfg.hunters, 'no NPCs');
  assert.equal(g.hunters().length, g.cfg.hunters, 'the level has no hunter in it');
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
/* A shot message aimed at a point. `claim` is what a real client would have
 * put in it after its own raycast — the server checks that rather than
 * searching for something to credit, so a test that omits it is testing the
 * claimless path on purpose. */
function aimedAt(room, player, point, claim) {
  const THREE = globalThis.THREE;
  const origin = new THREE.Vector3(player.x, player.y, player.z);
  const dir = point.clone().sub(origin).normalize();
  const msg = { t: 'shot', origin: { x: origin.x, y: origin.y, z: origin.z },
                dir: { x: dir.x, y: dir.y, z: dir.z } };
  if (claim) msg.claim = claim;
  return msg;
}

// stand somewhere with a clear line to a point
/* Put the player somewhere with a clear line to `point`.
 *
 * The bound used to be a hard-coded ±26, which was inside a sixty-unit arena
 * and is a ring of dead ground in an eighty-unit one: every spot around an NPC
 * out towards the edge was rejected for being outside a limit that had nothing
 * to do with the arena any more, and the whole rewind suite skipped itself for
 * want of a line of sight. It comes off the arena now, and there is more than
 * one distance to try. */
function standClear(room, player, point) {
  const THREE = globalThis.THREE;
  const g = room.game;
  const lim = g.cfg.arena / 2 - 4;
  for (const reach of [4, 7, 11]) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const eye = new THREE.Vector3(
        point.x + Math.sin(a) * reach, g.cfg.eye, point.z + Math.cos(a) * reach);
      if (Math.abs(eye.x) > lim || Math.abs(eye.z) > lim) continue;
      if (!g.hasLineOfSight(eye, point)) continue;
      player.x = eye.x; player.y = g.cfg.eye; player.z = eye.z;
      return true;
    }
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
  // a wanderer, not the hunter: this is about a round putting an ordinary
  // NPC down, and a hunter takes several — it has tests of its own
  const npc = room.game.npcs.find(n => n.alive && n.grounded && !n.hunter);
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
  // a wanderer, not the hunter: this is about a round putting an ordinary
  // NPC down, and a hunter takes several — it has tests of its own
  const npc = room.game.npcs.find(n => n.alive && n.grounded && !n.hunter);
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
  const set = ranOnFrom(room, p);
  assert.ok(set, 'the NPC never left the line of fire, test proves nothing');

  const shot = aimedAt(room, p, set.seen, { kind: 'npc', index: set.index });
  shot.lag = set.elapsed;
  const res = room.applyShot(p.id, shot, set.now);
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'npc', 'the rewind did not credit the hit');
  assert.ok(!set.npc.alive, 'the NPC survived');
});

/* Set an NPC running until it is well clear of the spot the shooter aimed at,
 * so a shot at that spot is a genuine miss against the live world and only the
 * rewind can credit it.
 *
 * The room is stepped on an explicit clock: the loop runs far faster than real
 * time, and on Date.now() every history frame lands on the same millisecond,
 * which quietly makes any test of *when* a shot is judged prove nothing.
 * Returns null when the arena will not cooperate. */
function ranOnFrom(room, player) {
  const g = room.game;
  const THREE = globalThis.THREE;
  const stepMs = 1000 / 30;
  const gapWanted = globalThis.PB.HIT.half * 4;    // two clear box widths

  for (const npc of g.npcs.filter(n => n.alive && n.grounded)) {
    const seen = npc.root.position.clone().setY(1.0);
    if (!standClear(room, player, seen)) continue;

    let t = Date.now();
    const t0 = t;
    room.recordHistory(t0);
    const origin = new THREE.Vector3(player.x, player.y, player.z);
    const dir = seen.clone().sub(origin).normalize();

    for (let s = 0; s < 12; s++) { t += stepMs; room.step(stepMs, t); }

    const gap = npc.root.position.clone().setY(1.0).distanceTo(seen);
    if (gap < gapWanted) continue;
    const live = g.traceShot(origin, dir);
    if (live.npc === npc) continue;
    /* And the spot they left has to still be in the clear. The arena has
     * sliding cover in it: one that moved across the line while the NPC was
     * running makes the rewind refuse for a reason that has nothing to do with
     * what is being tested — a rewind never reaches through a wall. */
    if (live.distance !== undefined && live.distance < origin.distanceTo(seen)) continue;
    return { npc, index: g.npcs.indexOf(npc), seen, origin, dir,
             t0, now: t, elapsed: t - t0 };
  }
  return null;
}

test('a round that lands in a running NPC\'s wake is not credited', () => {
  /* The bug this replaced: the server searched every history frame inside the
   * rewind window and kept whatever it found, so a moving figure was not a box
   * but a smear as long as its own travel — about 1.8u at a run. A shot well
   * behind somebody scored as a kill.
   *
   * Judged at the moment the client says it was looking, the old position is
   * simply not there any more. Same ray, same history, two different claimed
   * moments: one credits, one does not. */
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  const set = ranOnFrom(room, p);
  assert.ok(set, 'the NPC never left the line of fire, test proves nothing');

  const claim = { kind: 'npc', index: set.index };

  // "I was looking at the world as it was when I fired" — the rewind holds
  const behind = room.verifyClaim(claim, set.origin, set.dir, 300, set.now, set.elapsed, p.id);
  assert.ok(behind, 'the rewind refused a shot at where the NPC actually was');

  // "I was looking at the world as it is now" — that ground is empty
  const live = room.verifyClaim(claim, set.origin, set.dir, 300, set.now, 0, p.id);
  assert.equal(live, null, 'a round in the wake of a running NPC was credited');
});

test('a shot the client did not see land is a miss', () => {
  // no claim, no hit: the server does not go looking for something to award
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  const set = ranOnFrom(room, p);
  assert.ok(set, 'the NPC never left the line of fire, test proves nothing');

  const shot = aimedAt(room, p, set.seen);        // deliberately claimless
  shot.lag = set.elapsed;
  const res = room.applyShot(p.id, shot, set.now);
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.kind, 'miss', 'a claimless shot was credited anyway');
  assert.ok(set.npc.alive, 'the NPC went down to a shot nobody claimed');
});

test('a client cannot ask for unlimited rewind', () => {
  const room = new Room({ seed: 77 });
  const p = room.join('ana');
  // a wanderer, not the hunter: this is about a round putting an ordinary
  // NPC down, and a hunter takes several — it has tests of its own
  const npc = room.game.npcs.find(n => n.alive && n.grounded && !n.hunter);
  const i = room.game.npcs.indexOf(npc);
  const seen = npc.root.position.clone().setY(1.0);
  assert.ok(standClear(room, p, seen));
  room.recordHistory(Date.now() - MAX_REWIND_MS - 400);   // a very old sighting

  const shot = aimedAt(room, p, seen, { kind: 'npc', index: i });
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

  // fire at a wall: whatever is behind it must not be credited, however
  // confidently the client claims it
  const dir = new THREE.Vector3(0, 0, -1);
  const wallHit = g.traceShot(origin, dir);
  for (let i = 0; i < g.npcs.length; i++) {
    const beyond = room.verifyClaim({ kind: 'npc', index: i }, origin, dir,
                                    wallHit.distance, Date.now(), 0, p.id);
    if (beyond) {
      assert.ok(beyond.distance <= wallHit.distance + 0.01,
                'the rewind credited something behind cover');
    }
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
  const res = room.applyShot(ana.id, Object.assign(
    { lag: 120, claim: { kind: 'player', id: bo.id } }, aimed));
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

test('a hunter takes several rounds, and only the last one pays', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const g = room.game;
  const enemy = g.hunters()[0];
  assert.ok(enemy, 'no hunter in the level');
  assert.equal(enemy.health, g.cfg.hunterHealth, 'it did not start whole');

  // stand where it can be shot, and fire at its chest
  const THREE = globalThis.THREE;
  const chest = enemy.root.position.clone().setY(1.0);
  assert.ok(standClear(room, ana, chest), 'no clear line to the hunter');
  const shoot = () => {
    const o = { x: ana.x, y: ana.y, z: ana.z };
    const d = new THREE.Vector3(chest.x - o.x, chest.y - o.y, chest.z - o.z).normalize();
    return room.applyShot(ana.id, { t: 'shot', origin: o, dir: { x: d.x, y: d.y, z: d.z } },
                          Date.now() + 5000 * ++shoot.n);
  };
  shoot.n = 0;

  const before = ana.score;
  for (let i = 1; i < g.cfg.hunterHealth; i++) {
    const res = shoot();
    assert.ok(res.ok, res.reason);
    assert.equal(res.event.kind, 'npc', `round ${i} missed`);
    assert.equal(res.event.killed, false, `round ${i} finished it`);
    assert.equal(res.event.npcHealth, g.cfg.hunterHealth - i, 'the wrong amount came off');
    assert.ok(enemy.alive, 'it went down early');
    assert.equal(ana.score, before, 'a hit that did not finish it paid out');
    assert.equal(ana.stats.npcsDown, 0, 'it was counted before it went down');
  }

  const last = shoot();
  assert.ok(last.event.killed, 'the last round did not finish it');
  assert.ok(last.event.hunter, 'the room was not told which kind it was');
  assert.ok(!enemy.alive, 'it survived every round it has');
  assert.equal(ana.score - before, g.cfg.scoreHunter, 'the wrong payout');
  assert.equal(ana.stats.npcsDown, 1, 'it was not counted');
});

test('a wanderer still goes down to one round', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const g = room.game;
  const wanderer = g.npcs.filter(n => !n.hunter && n.alive)[0];
  assert.ok(wanderer, 'no wanderer');
  assert.equal(wanderer.maxHealth, 1, 'a wanderer now takes more than one round');

  const THREE = globalThis.THREE;
  const chest = wanderer.root.position.clone().setY(1.0);
  assert.ok(standClear(room, ana, chest), 'no clear line to a wanderer');
  const o = { x: ana.x, y: ana.y, z: ana.z };
  const d = new THREE.Vector3(chest.x - o.x, chest.y - o.y, chest.z - o.z).normalize();
  const res = room.applyShot(ana.id, { t: 'shot', origin: o, dir: { x: d.x, y: d.y, z: d.z } });
  assert.equal(res.event.kind, 'npc', 'missed');
  assert.ok(res.event.killed, 'one round no longer puts a wanderer down');
  assert.equal(ana.score, g.cfg.scoreNpc, 'a wanderer paid a hunter\'s price');
});

test('the snapshot carries what is left of every NPC', () => {
  const room = new Room({ seed: 4242 });
  room.join('ana');
  const g = room.game;
  const enemy = g.hunters()[0];
  g.hitNPC(enemy, 1);

  const entry = room.snapshot().npcs[g.npcs.indexOf(enemy)];
  assert.equal(entry[8], g.cfg.hunterHealth - 1, 'the health did not travel');
  assert.equal(entry[9], g.cfg.hunterHealth, 'nor did what it started with');
});

test('the levels bring more hunters, the same way on both sides', () => {
  const room = new Room({ seed: 4242 });
  const g = room.game;
  const seen = {};
  for (const level of [1, 4, 5, 9, 40]) {
    g.startLevel(level);
    seen[level] = g.hunters().length;
    // and always the first NPCs of the level, which is the whole agreement:
    // a client rebuilds a level from a count and works the rest out itself
    g.hunters().forEach((h, i) => assert.equal(g.npcs[i], h, `level ${level} order`));
  }
  assert.equal(seen[1], g.cfg.hunters);
  assert.equal(seen[4], g.cfg.hunters, 'it grew early');
  assert.equal(seen[5], g.cfg.hunters + 1, 'it never grew');
  assert.equal(seen[9], g.cfg.hunters + 2);
  assert.equal(seen[40], g.cfg.hunterMax, 'it grew past its ceiling');

  // the level message says how many NPCs there are, which is what a client
  // rebuilds from — the split between hunters and wanderers is derived
  g.startLevel(5);
  assert.equal(room.levelMessage().npcs, g.npcs.length, 'the count sent is wrong');
});

/* ---------------------------------------------------------- the hunter */
/* The room owns the players, so it is the room that says who the level's own
 * enemy may come after and what its rounds land on. */

// Stand a player where the hunter is looking, and hand back the shot it would
// have taken at them.
function hunterOn(room, player, gap = 10) {
  const g = room.game;
  const enemy = g.hunters()[0];
  player.x = 0;
  player.z = 0;
  player.y = g.cfg.eye;
  enemy.root.position.set(0, 0, -gap);
  enemy.heading = 0;                       // (sin h, cos h) is +Z: straight at them
  enemy.mark = null;
  enemy.quarry = null;
  enemy.sawAt = -1e9;
  enemy.sightSince = 0;
  enemy.nextShot = 0;
  enemy.root.updateMatrixWorld(true);
  return enemy;
}

test('the room tells the hunter who is worth coming after', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  bo.pvp = false;

  const list = room.huntable();
  assert.equal(list.length, 2, 'somebody was left off the list');
  const forAna = list.find(t => t.id === ana.id);
  assert.equal(forAna.health, ana.health, 'health did not travel with them');
  assert.equal(forAna.y, ana.y, 'a target is not at eye height');
  // opting out of PvP is an agreement between players, not with the level
  assert.ok(list.some(t => t.id === bo.id), 'a player out of PvP was left off');

  bo.deadUntil = Date.now() + 1000;
  assert.equal(room.huntable().length, 1, 'it was offered somebody on the floor');
});

test('a hunter\'s round takes health off the player it hits', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  ana.shieldUntil = 0;
  const enemy = hunterOn(room, ana, 8);

  // fire it by hand rather than waiting for the AI to choose its moment
  const shots = [];
  room.game.on('npcShot', s => shots.push(s));
  let landed = null;
  for (let i = 0; i < 200 && !landed; i++) {
    enemy.nextShot = 0;
    enemy.sightSince = -1e9;
    room.step(1000 / 30, Date.now());
    while (shots.length) {
      const event = room.applyNpcShot(shots.shift());
      if (event && event.kind === 'player') landed = event;
    }
    // hold both of them still: this is about the round, not the chase
    enemy.root.position.set(0, 0, -8);
    enemy.root.updateMatrixWorld(true);
    ana.health = Math.min(ana.health, room.game.cfg.playerHealth);
  }
  assert.ok(landed, 'nothing it fired ever landed');
  assert.equal(landed.by, 0, 'the round was credited to a player');
  assert.equal(landed.victim, ana.id, 'it hit the wrong player');
  assert.equal(landed.killerName, 'THE HUNTER', 'the victim is not told what hit them');
  assert.ok(ana.health < room.game.cfg.playerHealth, 'no damage was done');
  assert.equal(ana.score, 0, 'being shot at moved the score');
});

test('a hunter cannot hurt the shielded, the dead, or anyone through cover', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const enemy = hunterOn(room, ana, 8);
  const THREE = globalThis.THREE;
  const from = { x: 0, y: 1.55, z: -8 };
  const shot = {
    npc: enemy, index: 0, origin: from, dir: { x: 0, y: -0.05, z: 1 },
    point: { x: 0, y: 1.15, z: 0 }, distance: 8,
  };

  ana.shieldUntil = Date.now() + 5000;
  let event = room.applyNpcShot(shot);
  assert.equal(event.blocked, 'shield', 'a shielded player was hurt');
  assert.equal(ana.health, room.game.cfg.playerHealth, 'health came off anyway');

  ana.shieldUntil = 0;
  ana.deadUntil = Date.now() + 5000;
  event = room.applyNpcShot(shot);
  assert.equal(event.kind, 'miss', 'it shot somebody who is already down');

  // and a round that the world stopped first reaches nobody
  ana.deadUntil = 0;
  event = room.applyNpcShot(Object.assign({}, shot, { distance: 2 }));
  assert.equal(event.kind, 'miss', 'a round stopped by cover still hit somebody');
  assert.equal(ana.health, room.game.cfg.playerHealth, 'damage through cover');
});

test('a hunter kills without crediting anybody', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  ana.shieldUntil = 0;
  ana.score = 500;
  bo.score = 500;
  hunterOn(room, ana, 8);

  const shot = {
    npc: room.game.hunters()[0], index: 0,
    origin: { x: 0, y: 1.55, z: -8 }, dir: { x: 0, y: -0.05, z: 1 },
    point: { x: 0, y: 1.15, z: 0 }, distance: 8,
  };
  let event = null;
  for (let i = 0; i < room.game.cfg.playerHealth; i++) event = room.applyNpcShot(shot);

  assert.ok(event.killed, 'ten rounds did not put them down');
  assert.ok(ana.deadUntil, 'they are not waiting to respawn');
  assert.equal(ana.deaths, 1, 'the death was not counted');
  assert.equal(bo.score, 500, 'somebody was paid for a kill they did not make');
  assert.equal(ana.score, 500, 'the score moved for being killed');
});

/* ------------------------------------------------- losing the connection */
test('a dropped socket keeps the seat, and comes out of the world', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  ana.score = 700;
  ana.kills = 2;

  const hello = room.hello(ana);
  assert.ok(hello.token && hello.token.length >= 16, 'no token to come back with');

  const now = Date.now();
  assert.ok(room.disconnect(ana.id, now), 'the drop was not registered');
  assert.ok(room.players.has(ana.id), 'the seat was given up immediately');
  assert.ok(!room.here(ana), 'they still count as being here');

  // out of the world: no body to draw, to shoot, or for a hunter to aim at
  const snap = room.snapshot();
  assert.ok(!snap.players.some(p => p[0] === ana.id), 'a body was left standing');
  assert.ok(!room.huntable().some(t => t.id === ana.id), 'the hunter still has them');
  assert.ok(!room.playerHit(
    new globalThis.THREE.Vector3(ana.x, ana.y, ana.z - 5),
    new globalThis.THREE.Vector3(0, 0, 1), 40, bo.id), 'their body still stopped a round');

  // but still on the scoreboard, marked as away, with everything intact
  const row = room.scoreboard().players.find(r => r[0] === ana.id);
  assert.ok(row, 'they fell off the scoreboard');
  assert.equal(row[2], 700, 'their score went with the connection');
  assert.equal(row[3], 2, 'their kills went with the connection');
  assert.equal(row[6], 1, 'the table does not show them as away');
});

test('coming back with the token picks the same seat up', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  ana.score = 1234;
  ana.kills = 3;
  ana.deaths = 1;
  const token = room.hello(ana).token;

  const now = Date.now();
  room.disconnect(ana.id, now);
  const back = room.resume(token, 'ana', now + 5000);
  assert.ok(back, 'the seat was not there to pick up');
  assert.equal(back.id, ana.id, 'they came back as somebody else');
  assert.equal(back.score, 1234, 'the score was not kept');
  assert.equal(back.kills, 3);
  assert.equal(back.deaths, 1);
  assert.ok(room.here(back), 'still counted as away');
  assert.ok(room.shielded(back, now + 5000), 'came back with no protection');
  assert.ok(room.snapshot().players.some(p => p[0] === ana.id), 'no body came back');

  // and a name changed while away comes back with them
  room.disconnect(ana.id, now + 6000);
  const renamed = room.resume(token, 'anastasia', now + 7000);
  assert.equal(renamed.name, 'anastasia', 'the new name was not taken');
});

test('a seat is not held forever, and not handed to a guess', () => {
  const sent = [];
  const room = new Room({ seed: 4242, onBroadcast: m => sent.push(m) });
  const ana = room.join('ana');
  const token = room.hello(ana).token;
  const now = Date.now();
  room.disconnect(ana.id, now);

  assert.equal(room.resume('not-the-token', 'ana', now + 1000), null,
               'a guessed token took somebody\'s seat');
  assert.equal(room.resume(token, 'ana', now + GRACE_MS + 1000), null,
               'the seat was still theirs long after they went');

  // the sweep gives it up and says so, with the name still attached
  room.step(1000 / 30, now + GRACE_MS + 1500);
  assert.ok(!room.players.has(ana.id), 'the seat was never given up');
  const left = sent.filter(m => m.t === 'left');
  assert.equal(left.length, 1, 'nobody was told they had gone');
  assert.equal(left[0].name, 'ana', 'the message does not say who left');
});

test('somebody who is away is left out of the running of the world', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const now = Date.now();
  ana.health = 4;
  ana.healAt = now - 1;
  room.disconnect(ana.id, now);

  room.updateHealth(now + 60000);
  assert.equal(ana.health, 4, 'they healed while nobody was driving them');
  assert.ok(!ana.deadUntil, 'they were respawned while away');

  // and they are not standing on anything to pick it up
  const kit = room.game.medkits[0];
  kit.ready = true;
  ana.x = kit.x;
  ana.z = kit.z;
  ana.y = room.game.cfg.eye;
  assert.equal(room.updateMedkits(now).length, 0, 'an absent player took a pack');
  assert.ok(kit.ready, 'the pack went with them');
});

/* ------------------------------------------------------- the controls */
test('a restart builds a new map and puts everybody back to nothing', () => {
  const room = new Room({ seed: null });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const seedBefore = room.seed;

  ana.score = 900; ana.kills = 3; ana.deaths = 1;
  ana.stats.shotsFired = 40;
  bo.score = 120;
  bo.health = 2;
  bo.deadUntil = Date.now() + 5000;
  room.game.startLevel(4);

  const out = room.restart(ana.id);
  assert.equal(out.t, 'restart');
  assert.equal(out.name, 'ana', 'the room is not told who did it');
  assert.notEqual(out.seed, seedBefore, 'the map did not change');
  assert.equal(room.game.state.level, 1, 'it did not go back to level one');

  for (const p of [ana, bo]) {
    assert.equal(p.score, 0, 'a score survived the restart');
    assert.equal(p.kills, 0, 'kills survived');
    assert.equal(p.deaths, 0, 'deaths survived');
    assert.equal(p.stats.shotsFired, 0, 'the figures survived');
    assert.equal(p.health, room.game.cfg.playerHealth, 'they came back hurt');
    assert.equal(p.deadUntil, 0, 'somebody is still waiting to respawn');
    assert.ok(room.shielded(p), 'they came back with no protection');
  }
  assert.ok(Math.hypot(ana.x - bo.x, ana.z - bo.z) > 2, 'two players in the same spot');

  // the hunters and the level's own wiring point at the new world
  assert.ok(room.game.hunters().length > 0, 'the new match has no hunter');
  assert.equal(room.game.hitNPC(room.game.hunters()[0], 99).killed, true,
               'the new world is not the one the room is running');
});

test('a restart keeps a pinned map pinned', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const out = room.restart(ana.id);
  assert.equal(out.seed, 4242, 'a pinned seed was thrown away by a restart');
});

test('the controls add to the level already running', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const g = room.game;
  const before = {
    targets: g.aliveCount(), npcs: g.npcs.length,
    hunters: g.hunters().length, perks: g.perks.length,
  };

  const added = room.addToLevel('hunter', 2, ana.id);
  assert.ok(added, 'nothing was added');
  assert.equal(added.made, 2, 'the wrong number arrived');
  assert.equal(added.note.name, 'ana', 'the room is not told who did it');
  assert.equal(g.hunters().length, before.hunters + 2, 'the hunters did not arrive');
  assert.equal(added.level.t, 'levelStart', 'the room was not sent the new contents');
  assert.equal(added.level.npcs, g.npcs.length, 'the contents do not match the level');

  assert.equal(room.addToLevel('target', 4, ana.id).made, 4);
  assert.equal(g.aliveCount(), before.targets + 4, 'the targets did not arrive');
  assert.equal(room.addToLevel('npc', 3, ana.id).made, 3);
  assert.equal(room.addToLevel('perk', 2, ana.id).made, 2);
  assert.equal(g.perks.length, before.perks + 2, 'the perks did not arrive');

  // and nothing else is accepted
  assert.equal(room.addToLevel('elephant', 1, ana.id), null, 'it added an elephant');
  assert.equal(room.addToLevel('npc', 0, ana.id), null, 'it added nothing and said so');
});

test('nothing added to a level is sealed inside the arena', () => {
  const room = new Room({ seed: 4242 });
  const g = room.game;
  room.addToLevel('target', 20, 0);
  const sealed = g.targets.filter(t => t.alive &&
    g.insideAnything(t.mesh.position.x, t.mesh.position.z, t.mesh.position.y, 0));
  assert.equal(sealed.length, 0, 'a target was added inside a room');
  for (const t of g.targets) {
    const p = t.mesh.position;
    const lim = g.cfg.arena / 2;
    assert.ok(Math.abs(p.x) < lim && Math.abs(p.z) < lim, 'a target was added outside the arena');
  }
});

/* --------------------------------------------------------------- chat */
test('what somebody says comes back stamped, named, and cleaned up', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');

  const at = Date.now();
  const res = room.chat(ana.id, '  hello   there  ', at);
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.t, 'chat');
  assert.equal(res.event.from, ana.id);
  assert.equal(res.event.name, 'ana', 'the name did not travel with it');
  assert.equal(res.event.text, 'hello there', 'the runs of space were kept');
  assert.equal(res.event.at, at, 'it went out unstamped');

  // control characters cannot make one line into two, or reach a terminal
  const nasty = room.chat(ana.id, 'one' + String.fromCharCode(10) + 'two' +
                                  String.fromCharCode(27) + '[31m', at + 5000);
  assert.ok(nasty.ok, nasty.reason);
  assert.ok(!/[\r\n]/.test(nasty.event.text), 'a newline survived');
  assert.equal(nasty.event.text.indexOf(String.fromCharCode(27)), -1, 'an escape survived');

  // and nothing to say is not said
  assert.ok(!room.chat(ana.id, '   ', at + 10000).ok, 'whitespace was broadcast');
  assert.ok(!room.chat(ana.id, null, at + 12000).ok, 'a non-string was broadcast');
});

test('a long message is cut to length rather than refused', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const res = room.chat(ana.id, 'x'.repeat(CHAT_MAX * 3));
  assert.ok(res.ok, res.reason);
  assert.equal(res.event.text.length, CHAT_MAX, 'it was not cut to the limit');
});

test('one player cannot fill the log on their own', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  let t = Date.now();

  // a burst is conversation
  for (let i = 0; i < CHAT_BURST; i++) {
    assert.ok(room.chat(ana.id, 'line ' + i, t).ok, `message ${i} was refused`);
  }
  // and the next one, right behind it, is not
  const flood = room.chat(ana.id, 'and another', t);
  assert.ok(!flood.ok, 'the burst had no end');
  assert.equal(flood.reason, 'too much at once');

  // it comes back with the passing of time, and no faster
  assert.ok(!room.chat(ana.id, 'too soon', t + 500).ok, 'the allowance refilled too fast');
  t += 4000;
  assert.ok(room.chat(ana.id, 'later', t).ok, 'the allowance never came back');

  // and one player's flooding does not silence anybody else
  const bo = room.join('bo');
  assert.ok(room.chat(bo.id, 'hello', t).ok, 'a quiet player was rate limited');
});

test('somebody who is not in the room cannot say anything', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  room.leave(ana.id);
  const res = room.chat(ana.id, 'still here');
  assert.ok(!res.ok, 'a player who left was still able to talk');
  assert.equal(res.reason, 'unknown player');
});

/* --------------------------------------------------------- scoreboard */
test('the scoreboard carries what each machine says it is managing', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');

  room.reportFps(ana.id, 144, 12);
  room.reportFps(bo.id, 28, 180);
  const row = id => room.scoreboard().players.find(r => r[0] === id);
  assert.equal(row(ana.id)[7], 144, 'the frame rate did not reach the table');
  assert.equal(row(ana.id)[8], 12, 'the round trip did not reach the table');
  assert.equal(row(bo.id)[7], 28);
  assert.equal(row(bo.id)[8], 180);

  // it is their word for it, so it is held to something sane
  room.reportFps(ana.id, 1e9, 1e9);
  assert.equal(row(ana.id)[7], 999, 'an absurd frame rate went on the table');
  assert.equal(row(ana.id)[8], 9999, 'an absurd round trip went on the table');

  room.reportFps(ana.id, -5, -5);
  assert.equal(row(ana.id)[7], 999, 'a negative frame rate was taken');
  assert.equal(row(ana.id)[8], 9999, 'a negative round trip was taken');

  room.reportFps(ana.id, 'fast', null);
  assert.equal(row(ana.id)[7], 999, 'a frame rate that is not a number was taken');

  // and nobody can report for somebody who is not here
  assert.equal(room.reportFps(9999, 60, 10), null, 'a stranger reported a frame rate');
});

test('the scoreboard says who is in the room and how they are doing', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  ana.score = 900;
  bo.score = 250;

  const board = room.scoreboard();
  assert.equal(board.t, 'scores');
  assert.equal(board.players.length, 2, 'somebody is missing from the table');

  const [top, next] = board.players;
  assert.equal(top[0], ana.id, 'the table is not sorted by score');
  assert.equal(top[1], 'ana', 'a name did not travel');
  assert.equal(top[2], 900);
  assert.equal(next[0], bo.id);

  // and it follows the score rather than the joining order
  bo.score = 5000;
  assert.equal(room.scoreboard().players[0][0], bo.id, 'the lead did not change hands');
});

test('the scoreboard counts kills and deaths the server saw itself', () => {
  const room = new Room({ seed: 4242 });
  const ana = room.join('ana');
  const bo = room.join('bo');
  const shot = faceOff(room, ana, bo);
  bo.shieldUntil = 0;

  let t = Date.now();
  for (let i = 0; i < room.game.cfg.playerHealth; i++) {
    room.applyShot(ana.id, shot(), t);
    t += 200;
  }

  const row = id => room.scoreboard().players.find(r => r[0] === id);
  assert.equal(row(ana.id)[3], 1, 'the kill was not counted');
  assert.equal(row(ana.id)[4], 0, 'the killer was credited with a death');
  assert.equal(row(bo.id)[4], 1, 'the death was not counted');
  assert.equal(row(bo.id)[5], 1, 'the table does not show who is waiting to respawn');

  // a hunter's kill belongs to nobody, but the death is still theirs
  const ana2 = room.join('cass');
  ana2.shieldUntil = 0;
  for (let i = 0; i < room.game.cfg.playerHealth; i++) {
    room.applyNpcShot({
      npc: room.game.hunters()[0], index: 0,
      origin: { x: ana2.x, y: ana2.y + 6, z: ana2.z },
      dir: { x: 0, y: -1, z: 0 },
      point: { x: ana2.x, y: ana2.y - 2, z: ana2.z }, distance: 12,
    });
  }
  assert.equal(row(ana2.id)[4], 1, 'a death to the hunter was not counted');
  const kills = room.scoreboard().players.reduce((n, r) => n + r[3], 0);
  assert.equal(kills, 1, 'the hunter was credited with a kill');
});

test('the room sends the scoreboard on its own slower clock', () => {
  const sent = [];
  const room = new Room({ seed: 4242, onBroadcast: m => sent.push(m) });
  room.join('ana');

  const step = () => room.step(1000 / 30, Date.now());
  for (let i = 0; i < 30; i++) step();          // one second of ticks

  const boards = sent.filter(m => m.t === 'scores');
  const snapshots = sent.filter(m => m.t === 'snapshot');
  assert.equal(boards.length, 1, `${boards.length} scoreboards in a second`);
  assert.ok(snapshots.length > 25, 'the snapshots stopped');
  assert.ok(boards[0].players.length === 1, 'the table came out empty');
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

  /* Bo stands between ana and cid, and is out of the fight. All three inside
   * the disc the arena keeps clear around the spawn — cover is placed by its
   * whole extent now, and a line drawn further out than that can have a room
   * in the middle of it. */
  ana.x = 6; ana.z = 0; ana.y = g.cfg.eye;
  bo.x = 3; bo.z = 0; bo.y = g.cfg.eye;
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
