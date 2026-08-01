/* A match: one headless world, the players in it, and the tick loops.
 *
 * Authority is hybrid — clients own where they are, the server owns everything
 * else (NPCs, targets, scoring later) and sanity-checks every position it is
 * told about. A client that claims to have moved further than it possibly
 * could gets snapped back.
 */
'use strict';

const { createHeadlessGame } = require('./engine.js');

const SIM_HZ = 30;
const SNAPSHOT_HZ = 20;

/* How far back a shot may be judged. Covers the client's interpolation window
 * plus a normal round trip; anything beyond this is not a late packet, it is
 * someone shooting at ghosts. */
const REWIND_MS = 350;

/* A slow client legitimately aims at an older world than a fast one, so it may
 * ask for more rewind than the default. This is the ceiling on that request —
 * beyond it, a claim is not a late packet, it is someone shooting at ghosts. */
const MAX_REWIND_MS = 700;

class Room {
  constructor(opts = {}) {
    this.seed = opts.seed || (Math.random() * 1e9) | 0;
    this.game = createHeadlessGame(Object.assign({ seed: this.seed }, opts.game || {}));
    this.players = new Map();
    this.tick = 0;
    this.nextId = 1;
    this.simMs = 1000 / SIM_HZ;
    this.snapshotMs = 1000 / SNAPSHOT_HZ;
    this.sinceSnapshot = 0;
    this.timers = null;
    this.history = [];              // recent entity positions, for lag compensation
    this.onBroadcast = opts.onBroadcast || function () {};
    this.onSend = opts.onSend || function () {};

    // when the world moves on to the next level, everyone has to be told
    this.game.on('level', () => this.onBroadcast(this.levelMessage()));
  }

  /* ------------------------------------------------------------- players */
  join(name) {
    const id = this.nextId++;
    const player = {
      id,
      name: (name || 'player').toString().slice(0, 16),
      x: 0, y: this.game.cfg.eye, z: 0,
      yaw: 0, pitch: 0,
      moving: false, grounded: true, vy: 0,
      lastStateAt: Date.now(),
      lastShotAt: 0,
      violations: 0,
      joinedAt: Date.now(),
      score: 0,
      perks: {},
      stats: { shotsFired: 0, shotsHit: 0, misses: 0, targetsBroken: 0, npcsDown: 0 },
    };
    this.players.set(id, player);
    return player;
  }

  leave(id) {
    return this.players.delete(id);
  }

  /* Exactly what is in the level, so a client can build the same one. The
   * seed alone is not enough past the first level: the two random streams
   * diverge as soon as either side spawns anything of its own. */
  levelMessage() {
    return {
      t: 'levelStart',
      level: this.game.state.level,
      npcs: this.game.npcs.length,
      targets: this.game.targets.map(t => ([
        round(t.mesh.position.x), round(t.base), round(t.mesh.position.z),
        t.wander ? 1 : 0,
      ])),
    };
  }

  hello(player) {
    return {
      t: 'hello',
      arena: this.game.arenaFingerprint(),
      level: this.levelMessage(),
      id: player.id,
      seed: this.seed,
      simHz: SIM_HZ,
      snapshotHz: SNAPSHOT_HZ,
      you: this.publicPlayer(player),
      players: [...this.players.values()]
        .filter(p => p.id !== player.id)
        .map(p => this.publicPlayer(p)),
    };
  }

  publicPlayer(p) {
    return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, score: p.score };
  }

  /* ------------------------------------------------------- lag compensation */
  /* Clients render everyone else an interpolation window behind the server, so
   * a player aims at where an NPC *was*. Keeping a short history of positions
   * lets a shot be judged against the world the shooter could actually see,
   * instead of punishing them for the trip time. */
  recordHistory(now = Date.now()) {
    const g = this.game;
    this.history.push({
      t: now,
      npcs: g.npcs.map(n => (n.alive
        ? [n.root.position.x, n.root.position.y, n.root.position.z]
        : null)),
      targets: g.targets.map(t => (t.alive
        ? [t.mesh.position.x, t.mesh.position.y, t.mesh.position.z]
        : null)),
    });
    const cutoff = now - MAX_REWIND_MS - 200;
    while (this.history.length > 2 && this.history[0].t < cutoff) this.history.shift();
  }

  // Nearest entity the shot would have hit anywhere in the rewind window.
  rewoundHit(origin, dir, maxDistance, now = Date.now(), windowMs = REWIND_MS) {
    const THREE = globalThis.THREE;
    const ray = new THREE.Ray(origin, dir);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    let best = null;

    for (let h = this.history.length - 1; h >= 0; h--) {
      const frame = this.history[h];
      if (now - frame.t > windowMs) break;

      const older = this.history[h - 1];

      for (let i = 0; i < frame.npcs.length; i++) {
        const p = frame.npcs[i];
        const npc = this.game.npcs[i];
        if (!p || !npc || !npc.alive) continue;
        // Sweep from the previous sample to this one. Testing the samples
        // alone leaves gaps a running figure slips through: at 5u/s a 50ms
        // snapshot step moves it a quarter of its own width.
        const q = (older && older.npcs[i]) || p;
        box.min.set(Math.min(p[0], q[0]) - 0.36, Math.min(p[1], q[1]), Math.min(p[2], q[2]) - 0.36);
        box.max.set(Math.max(p[0], q[0]) + 0.36, Math.max(p[1], q[1]) + 1.8, Math.max(p[2], q[2]) + 0.36);
        if (!ray.intersectBox(box, point)) continue;
        const d = origin.distanceTo(point);
        if (d <= maxDistance && (!best || d < best.distance)) {
          best = { kind: 'npc', index: i, entity: npc, distance: d, point: point.clone() };
        }
      }

      for (let j = 0; j < frame.targets.length; j++) {
        const p = frame.targets[j];
        const target = this.game.targets[j];
        if (!p || !target || !target.alive) continue;
        const q = (older && older.targets[j]) || p;
        box.min.set(Math.min(p[0], q[0]) - 0.62, Math.min(p[1], q[1]) - 0.62, Math.min(p[2], q[2]) - 0.62);
        box.max.set(Math.max(p[0], q[0]) + 0.62, Math.max(p[1], q[1]) + 0.62, Math.max(p[2], q[2]) + 0.62);
        if (!ray.intersectBox(box, point)) continue;
        const d = origin.distanceTo(point);
        if (d <= maxDistance && (!best || d < best.distance)) {
          best = { kind: 'target', index: j, entity: target, distance: d, point: point.clone() };
        }
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- perks */
  /* The server owns what is on the ground and who got it. A client that walks
   * over a perk does not grant itself anything — it waits to be told. */
  collectPerks(now = Date.now()) {
    const g = this.game;
    const picked = [];
    for (const player of this.players.values()) {
      const perk = g.perkSystem.pickUpAt(player.x, player.z, player.y - g.cfg.eye);
      if (!perk) continue;
      g.perkSystem.grant(player, perk.kind);
      g.perkSystem.remove(perk);
      picked.push({
        t: 'perk', by: player.id, kind: perk.kind, id: perk.id,
        label: perk.def.label, duration: g.cfg.perkDuration,
      });
    }
    return picked;
  }

  /* ------------------------------------------------------------- shooting */
  /* The server owns what a shot hit. It re-runs the same raycast the client
   * ran, against its own copy of the world, so a client cannot claim a kill
   * it did not make — and cannot be robbed of one it did. */
  applyShot(id, msg, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'unknown player' };

    const g = this.game;
    const cfg = g.cfg;
    const o = msg.origin, d = msg.dir;
    if (!o || !d) return { ok: false, reason: 'malformed shot' };
    const nums = [o.x, o.y, o.z, d.x, d.y, d.z];
    if (nums.some(n => typeof n !== 'number' || !isFinite(n))) {
      return { ok: false, reason: 'non-finite shot' };
    }

    // no firing faster than the weapon allows — rapid fire included
    const allowed = cfg.fireMs * g.perkSystem.factor(player, 'fireRate');
    if (now - player.lastShotAt < allowed * 0.75) {
      player.violations++;
      return { ok: false, reason: 'rate of fire' };
    }

    // and no shooting from somewhere you are not
    const away = Math.hypot(o.x - player.x, o.z - player.z);
    if (away > 2.5 || Math.abs(o.y - player.y) > 2.5) {
      player.violations++;
      return { ok: false, reason: `shot from ${away.toFixed(1)}u away from the player` };
    }

    const THREE = globalThis.THREE;
    const dir = new THREE.Vector3(d.x, d.y, d.z);
    if (dir.lengthSq() < 1e-6) return { ok: false, reason: 'zero direction' };
    dir.normalize();

    player.lastShotAt = now;
    player.stats.shotsFired++;

    const origin = new THREE.Vector3(o.x, o.y, o.z);
    let hit = g.traceShot(origin, dir);

    /* If the shot did not land on an entity where it stands right now, judge it
     * against where the entities were while the round was in flight — but never
     * through cover, so the rewind can only reach as far as the first wall. */
    if (!hit.target && !hit.npc) {
      const reach = hit.distance || 300;
      const asked = typeof msg.lag === 'number' && isFinite(msg.lag) ? msg.lag : 0;
      const windowMs = Math.min(MAX_REWIND_MS, Math.max(REWIND_MS, asked + 120));
      const rewound = this.rewoundHit(origin, dir, reach, now, windowMs);
      if (rewound) {
        hit = rewound.kind === 'npc'
          ? { point: rewound.point, npc: rewound.entity, distance: rewound.distance }
          : { point: rewound.point, target: rewound.entity, distance: rewound.distance };
      }
    }

    const event = {
      t: 'hit', by: id,
      origin: { x: r3(o.x), y: r3(o.y), z: r3(o.z) },   // so others can draw the tracer
      point: { x: r3(hit.point.x), y: r3(hit.point.y), z: r3(hit.point.z) },
      dir: { x: r3(dir.x), y: r3(dir.y), z: r3(dir.z) },
    };

    if (hit.target && hit.target.alive) {
      event.kind = 'target';
      event.index = g.targets.indexOf(hit.target);
      g.breakTarget(hit.target, dir);
      player.stats.shotsHit++;
      player.stats.targetsBroken++;
      this.award(player, cfg.scoreTarget);
      // The last target can be what finishes the level. knockDownNPC checks
      // this for itself; breaking a target here does not, and without this the
      // arena empties and nothing happens.
      g.checkLevel();
    } else if (hit.npc && hit.npc.alive) {
      event.kind = 'npc';
      event.index = g.npcs.indexOf(hit.npc);
      g.knockDownNPC(hit.npc);
      player.stats.shotsHit++;
      player.stats.npcsDown++;
      this.award(player, cfg.scoreNpc);
    } else {
      event.kind = 'miss';
      if (process.env.SHOT_DEBUG) {
        const THREE2 = globalThis.THREE;
        const near = [];
        for (let i = 0; i < g.npcs.length; i++) {
          const n = g.npcs[i];
          if (!n.alive) continue;
          const chest = n.root.position.clone().setY(1.0);
          const ray = new THREE2.Ray(origin, dir);
          near.push({
            npc: i,
            offRay: +ray.distanceToPoint(chest).toFixed(2),
            range: +origin.distanceTo(chest).toFixed(1),
          });
        }
        near.sort((a, b) => a.offRay - b.offRay);
        console.log('[shot-debug] miss:',
          'blockedAt', hit.distance ? hit.distance.toFixed(1) : 'none',
          'object', hit.object ? hit.object.name : '-',
          'lag', msg.lag,
          'history', this.history.length,
          'nearest', JSON.stringify(near.slice(0, 2)));
      }
      if (hit.normal) {
        event.normal = { x: r3(hit.normal.x), y: r3(hit.normal.y), z: r3(hit.normal.z) };
      }
      player.stats.misses++;
      this.award(player, cfg.scoreMiss);
    }

    event.score = player.score;
    return { ok: true, event };
  }

  award(player, points) {
    player.score = Math.max(0, player.score + points);
    return player.score;
  }

  /* --------------------------------------------------------- plausibility */
  /* Hybrid authority still has to hold clients to the movement rules, or a
   * position packet is just a wish. Anything faster than a sprinting player
   * could manage in the elapsed time, or outside the arena, is rejected. */
  checkMove(player, msg, now) {
    const cfg = this.game.cfg;
    const nums = [msg.x, msg.y, msg.z, msg.yaw, msg.pitch];
    if (nums.some(n => typeof n !== 'number' || !isFinite(n))) {
      return { ok: false, reason: 'non-finite' };
    }

    const limit = cfg.arena / 2 - 1;
    if (Math.abs(msg.x) > limit || Math.abs(msg.z) > limit) {
      return { ok: false, reason: 'outside the arena' };
    }
    if (msg.y < cfg.eye - 0.5 || msg.y > cfg.eye + 8) {
      return { ok: false, reason: 'impossible height' };
    }
    if (Math.abs(msg.pitch) > Math.PI / 2) {
      return { ok: false, reason: 'impossible pitch' };
    }

    // horizontal budget: sprint speed plus slack for a burst of dropped packets
    const dt = Math.min(1.0, Math.max(0.001, (now - player.lastStateAt) / 1000));
    // a speed perk legitimately moves the player faster, so the budget grows
    const boost = this.game.perkSystem.factor(player, 'speed');
    const budget = cfg.sprint * boost * dt * 1.35 + 0.35;
    const moved = Math.hypot(msg.x - player.x, msg.z - player.z);
    if (moved > budget) {
      return { ok: false, reason: `moved ${moved.toFixed(2)}u in ${dt.toFixed(3)}s` };
    }
    return { ok: true };
  }

  // `now` is injectable so the rules can be tested on a clock we control.
  applyState(id, msg, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'unknown player' };

    const verdict = this.checkMove(player, msg, now);
    if (!verdict.ok) {
      player.violations++;
      player.lastStateAt = now;
      return {
        ok: false,
        reason: verdict.reason,
        correction: { t: 'correction', x: player.x, y: player.y, z: player.z, reason: verdict.reason },
      };
    }

    player.x = msg.x;
    player.y = msg.y;
    player.z = msg.z;
    player.yaw = msg.yaw;
    player.pitch = msg.pitch;
    player.moving = !!msg.moving;
    player.grounded = msg.grounded !== false;
    player.vy = typeof msg.vy === 'number' ? msg.vy : 0;
    player.lastStateAt = now;
    return { ok: true };
  }

  /* ------------------------------------------------------------ snapshots */
  snapshot() {
    const g = this.game;
    return {
      t: 'snapshot',
      tick: this.tick,
      time: Date.now(),
      players: [...this.players.values()].map(p => ([
        p.id,
        round(p.x), round(p.y), round(p.z),
        round(p.yaw), p.moving ? 1 : 0, p.grounded ? 1 : 0, round(p.vy),
        p.score,
      ])),
      npcs: g.npcs.map(n => ([
        round(n.root.position.x), round(n.root.position.y), round(n.root.position.z),
        round(n.heading), n.alive ? 1 : 0, n.grounded ? 1 : 0, round(n.vy),
        round(n.root.rotation.x),        // toppling over when downed
      ])),
      targets: g.targets.map(t => ([
        round(t.mesh.position.x), round(t.mesh.position.y), round(t.mesh.position.z),
        t.alive ? 1 : 0,
      ])),
      // the sliders are a pure function of this, so the clock is all that
      // has to travel for every client to have them in the same place
      wt: round(g.state.worldTime),
      perks: g.perkSystem.describe(),
    };
  }

  /* ----------------------------------------------------------------- loop */
  step(dtMs, now = Date.now()) {
    this.tick++;
    const dt = dtMs / 1000;
    this.game.update(dt);

    for (const player of this.players.values()) {
      this.game.perkSystem.tickHolder(player, dt);
    }
    for (const msg of this.collectPerks(now)) this.onBroadcast(msg);

    this.sinceSnapshot += dtMs;
    if (this.sinceSnapshot >= this.snapshotMs) {
      this.recordHistory(now);
      // carry the remainder: zeroing it here quietly cost a quarter of the
      // snapshots whenever the tick rate did not divide the snapshot rate
      this.sinceSnapshot -= this.snapshotMs;
      this.onBroadcast(this.snapshot());
      return true;
    }
    return false;
  }

  start() {
    if (this.timers) return;
    let last = Date.now();
    this.timers = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(250, now - last);
      last = now;
      this.step(dt);
    }, this.simMs);
  }

  stop() {
    if (this.timers) clearInterval(this.timers);
    this.timers = null;
  }
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
const r3 = round;

module.exports = { Room, SIM_HZ, SNAPSHOT_HZ, REWIND_MS, MAX_REWIND_MS };
