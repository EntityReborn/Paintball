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

/* Most a player may move in one go having stood still long enough to earn it.
 * Roughly a third of a second of running: enough to swallow a bunch of state
 * messages arriving together, far too little to cross the map with. */
const MOVE_BURST = 2.5;

class Room {
  constructor(opts = {}) {
    // A pinned seed is for tuning and for tests that need the same arena every
    // time; without one every fresh match gets a new map.
    this.pinnedSeed = opts.seed || null;
    this.gameOptions = opts.game || {};
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
    this.matches = 0;

    this.buildWorld(this.pinnedSeed);
  }

  /* Build a world and hang the room's wiring off it. Called again whenever a
   * fresh match starts, so everything that points at the old game has to be
   * re-attached here. */
  buildWorld(seed) {
    this.seed = seed || (Math.random() * 1e9) | 0;
    this.game = createHeadlessGame(Object.assign({ seed: this.seed }, this.gameOptions));
    this.history.length = 0;
    this.sinceSnapshot = 0;
    this.matches++;

    // when the world moves on to the next level, everyone has to be told
    this.game.on('level', () => this.onBroadcast(this.levelMessage()));
    return this.seed;
  }

  /* ------------------------------------------------------------- players */
  join(name) {
    /* An empty room means the last match is over. Rebuild before letting the
     * first player in, so they arrive on a fresh map at level one rather than
     * inheriting whatever the previous session left behind — a half-cleared
     * arena, a level count from someone else's game, perks on the ground. */
    if (this.players.size === 0) this.buildWorld(this.pinnedSeed);

    const id = this.nextId++;
    const player = {
      id,
      name: (name || 'player').toString().slice(0, 16),
      x: 0, y: this.game.cfg.eye, z: 0,
      yaw: 0, pitch: 0,
      moving: false, grounded: true, vy: 0,
      lastStateAt: Date.now(),
      lastShotAt: 0,
      moveCredit: MOVE_BURST,        // distance they may move right now
      settleUntil: 0,                // grace while a teleport is in flight
      violations: 0,
      joinedAt: Date.now(),
      score: 0,
      health: 0,                 // set from the world's config just below
      deadUntil: 0,              // waiting to respawn
      healAt: 0,                 // when the next point of health is due
      kills: 0,
      deaths: 0,
      perks: {},
      stats: { shotsFired: 0, shotsHit: 0, misses: 0, targetsBroken: 0, npcsDown: 0 },
    };
    player.health = this.game.cfg.playerHealth;
    player.healAt = Date.now() + this.game.cfg.healEvery * 1000;
    this.players.set(id, player);
    // arrive somewhere of your own; `hello` carries it back to the client
    const at = this.clearSpot(player);
    player.x = at.x;
    player.z = at.z;
    // anything sent before that hello landed describes the client's own idea
    // of where it started, which is not their fault either
    player.settleUntil = player.lastStateAt + 1000;
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
    return {
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
      score: p.score, health: p.health, maxHealth: this.game.cfg.playerHealth,
    };
  }

  /* ---------------------------------------------------------- being shot */
  /* A player is a box standing on their feet. Square in plan on purpose: the
   * figure turns with its owner, and a box that turned with it would make you
   * easier or harder to hit depending on which way you happened to be facing. */
  playerBox(p, out) {
    const feet = p.y - this.game.cfg.eye;
    out.min.set(p.x - 0.36, feet, p.z - 0.36);
    out.max.set(p.x + 0.36, feet + 1.8, p.z + 0.36);
    return out;
  }

  // Nearest player the shot would hit right now, ignoring whoever fired it.
  playerHit(origin, dir, maxDistance, exceptId) {
    const THREE = globalThis.THREE;
    const ray = new THREE.Ray(origin, dir);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    let best = null;
    for (const p of this.players.values()) {
      if (p.id === exceptId || p.deadUntil) continue;
      this.playerBox(p, box);
      if (!ray.intersectBox(box, point)) continue;
      const d = origin.distanceTo(point);
      if (d <= maxDistance && (!best || d < best.distance)) {
        best = { kind: 'player', entity: p, distance: d, point: point.clone() };
      }
    }
    return best;
  }

  /* Take a hit off somebody, and hand out the kill if that was the last one. */
  damage(victim, shooter, now = Date.now()) {
    if (victim.deadUntil) return null;
    victim.health -= 1;
    victim.healAt = now + this.game.cfg.healEvery * 1000;

    if (victim.health > 0) {
      return { killed: false, health: victim.health };
    }

    victim.health = 0;
    victim.deaths++;
    victim.deadUntil = now + this.game.cfg.respawnDelay * 1000;
    if (shooter && shooter !== victim) {
      shooter.kills++;
      this.award(shooter, this.game.cfg.scoreKill);
    }
    return { killed: true, health: 0 };
  }

  /* Somewhere clear, well away from whoever is still standing. Used both to
   * come back from a death and to arrive in the first place — a player who
   * joined at the origin would spawn inside whoever was already there. */
  clearSpot(player) {
    const g = this.game;
    const lim = g.cfg.arena / 2 - 4;
    let best = null;
    let bestGap = -1;
    for (let tries = 0; tries < 40; tries++) {
      const x = (Math.random() - 0.5) * 2 * lim;
      const z = (Math.random() - 0.5) * 2 * lim;
      const probe = new globalThis.THREE.Vector3(x, g.cfg.eye, z);
      if (g.obstacleBoxes.some(b => b.distanceToPoint(probe) < 1.5)) continue;

      let gap = Infinity;
      for (const other of this.players.values()) {
        if (other.id === player.id || other.deadUntil) continue;
        gap = Math.min(gap, Math.hypot(other.x - x, other.z - z));
      }
      if (gap > bestGap) { bestGap = gap; best = { x, z }; }
      if (gap > 15) break;                       // far enough, stop looking
    }
    return best || { x: 0, z: 0 };
  }

  respawn(player) {
    const g = this.game;
    const at = this.clearSpot(player);
    player.x = at.x;
    player.y = g.cfg.eye;
    player.z = at.z;
    player.health = g.cfg.playerHealth;
    player.deadUntil = 0;
    player.lastStateAt = Date.now();
    player.moveCredit = MOVE_BURST;
    /* States sent before the client heard about the respawn still describe the
     * spot they died on. Those are refused — the server owns where they came
     * back — but they are not the player's fault, so they are not held
     * against them. */
    player.settleUntil = player.lastStateAt + 1000;
    return at;
  }

  /* Health comes back a point at a time, and the dead come back whole. */
  updateHealth(now = Date.now()) {
    const events = [];
    const cfg = this.game.cfg;
    for (const p of this.players.values()) {
      if (p.deadUntil) {
        if (now >= p.deadUntil) {
          const at = this.respawn(p);
          events.push({ t: 'respawn', id: p.id, x: r3(at.x), y: r3(cfg.eye), z: r3(at.z),
                        health: p.health });
        }
        continue;
      }
      if (p.health >= cfg.playerHealth) continue;
      if (now < p.healAt) continue;
      p.health = Math.min(cfg.playerHealth, p.health + 1);
      p.healAt = now + cfg.healEvery * 1000;
    }
    return events;
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
      players: [...this.players.values()].map(p => (p.deadUntil
        ? null
        : [p.id, p.x, p.y, p.z])),
    });
    const cutoff = now - MAX_REWIND_MS - 200;
    while (this.history.length > 2 && this.history[0].t < cutoff) this.history.shift();
  }

  // Nearest entity the shot would have hit anywhere in the rewind window.
  rewoundHit(origin, dir, maxDistance, now = Date.now(), windowMs = REWIND_MS, exceptId = null) {
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

      for (let k = 0; k < (frame.players || []).length; k++) {
        const rec = frame.players[k];
        if (!rec) continue;
        const player = this.players.get(rec[0]);
        if (!player || player.deadUntil || rec[0] === exceptId) continue;
        // swept the same way the NPCs are — a sprinting player covers most of
        // their own width between two samples
        const was = (older && older.players
          && older.players.find(o => o && o[0] === rec[0])) || rec;
        const feet = Math.min(rec[2], was[2]) - this.game.cfg.eye;
        box.min.set(Math.min(rec[1], was[1]) - 0.36, feet, Math.min(rec[3], was[3]) - 0.36);
        box.max.set(Math.max(rec[1], was[1]) + 0.36,
                    Math.max(rec[2], was[2]) - this.game.cfg.eye + 1.8,
                    Math.max(rec[3], was[3]) + 0.36);
        if (!ray.intersectBox(box, point)) continue;
        const d = origin.distanceTo(point);
        if (d <= maxDistance && (!best || d < best.distance)) {
          best = { kind: 'player', entity: player, distance: d, point: point.clone() };
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

    if (player.deadUntil) return { ok: false, reason: 'waiting to respawn' };

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

    // other players are shootable too, and they are not part of the world the
    // engine raycasts, so they are tested here
    const onPlayer = this.playerHit(origin, dir, hit.distance || 300, id);
    if (onPlayer && (!hit.distance || onPlayer.distance < hit.distance)) {
      hit = { point: onPlayer.point, player: onPlayer.entity, distance: onPlayer.distance };
    }

    /* If the shot did not land on an entity where it stands right now, judge it
     * against where the entities were while the round was in flight — but never
     * through cover, so the rewind can only reach as far as the first wall. */
    if (!hit.target && !hit.npc && !hit.player) {
      const reach = hit.distance || 300;
      const asked = typeof msg.lag === 'number' && isFinite(msg.lag) ? msg.lag : 0;
      const windowMs = Math.min(MAX_REWIND_MS, Math.max(REWIND_MS, asked + 120));
      const rewound = this.rewoundHit(origin, dir, reach, now, windowMs, id);
      if (rewound) {
        if (rewound.kind === 'npc') {
          hit = { point: rewound.point, npc: rewound.entity, distance: rewound.distance };
        } else if (rewound.kind === 'player') {
          hit = { point: rewound.point, player: rewound.entity, distance: rewound.distance };
        } else {
          hit = { point: rewound.point, target: rewound.entity, distance: rewound.distance };
        }
      }
    }

    const event = {
      t: 'hit', by: id,
      level: g.state.level,        // so a client that has moved on can ignore it
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
    } else if (hit.player) {
      const victim = hit.player;
      const outcome = this.damage(victim, player, now);
      event.kind = 'player';
      event.victim = victim.id;
      event.victimHealth = victim.health;
      event.killed = !!(outcome && outcome.killed);
      player.stats.shotsHit++;
      if (event.killed) {
        event.victimName = victim.name;
        event.killerName = player.name;
      }
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

    /* Horizontal budget, kept as a running allowance rather than a per-packet
     * one. State messages do not arrive evenly: a hiccup anywhere along the
     * way delivers three or four of them in the same millisecond, and judging
     * each against the gap since the last one would find an honest player
     * moving 0.8u "in 0.001s" and snap them back. The allowance fills at
     * sprint speed, so nobody outruns the game over any stretch of time, and
     * a short burst simply spends what the quiet moment before it earned. */
    const dt = Math.min(1.0, Math.max(0, (now - player.lastStateAt) / 1000));
    // a speed perk legitimately moves the player faster, so it fills faster
    // and holds more — the burst is a third of a second either way
    const boost = this.game.perkSystem.factor(player, 'speed');
    player.moveCredit = Math.min(MOVE_BURST * boost,
      player.moveCredit + cfg.sprint * boost * dt * 1.35);

    const moved = Math.hypot(msg.x - player.x, msg.z - player.z);
    if (moved > player.moveCredit + 0.05) {
      return {
        ok: false,
        reason: `moved ${moved.toFixed(2)}u on ${player.moveCredit.toFixed(2)}u of credit`,
      };
    }
    player.moveCredit = Math.max(0, player.moveCredit - moved);
    return { ok: true };
  }

  // `now` is injectable so the rules can be tested on a clock we control.
  applyState(id, msg, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'unknown player' };

    if (player.deadUntil) {
      // they are on the floor waiting; the server owns where they come back
      player.lastStateAt = now;
      return { ok: false, reason: 'waiting to respawn' };
    }

    const verdict = this.checkMove(player, msg, now);
    if (!verdict.ok) {
      if (now >= player.settleUntil) player.violations++;
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
        p.score, p.health, p.deadUntil ? 1 : 0,
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
    for (const msg of this.updateHealth(now)) this.onBroadcast(msg);

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

module.exports = { Room, SIM_HZ, SNAPSHOT_HZ, REWIND_MS, MAX_REWIND_MS, MOVE_BURST };
