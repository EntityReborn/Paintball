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

class Room {
  constructor(opts = {}) {
    this.seed = opts.seed || (Math.random() * 1e9) | 0;
    this.game = createHeadlessGame({ seed: this.seed });
    this.players = new Map();
    this.tick = 0;
    this.nextId = 1;
    this.simMs = 1000 / SIM_HZ;
    this.snapshotMs = 1000 / SNAPSHOT_HZ;
    this.sinceSnapshot = 0;
    this.timers = null;
    this.onBroadcast = opts.onBroadcast || function () {};
    this.onSend = opts.onSend || function () {};
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
      violations: 0,
      joinedAt: Date.now(),
    };
    this.players.set(id, player);
    return player;
  }

  leave(id) {
    return this.players.delete(id);
  }

  hello(player) {
    return {
      t: 'hello',
      id: player.id,
      seed: this.seed,
      simHz: SIM_HZ,
      snapshotHz: SNAPSHOT_HZ,
      arena: this.game.cfg.arena,
      you: this.publicPlayer(player),
      players: [...this.players.values()]
        .filter(p => p.id !== player.id)
        .map(p => this.publicPlayer(p)),
    };
  }

  publicPlayer(p) {
    return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw };
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
    const budget = cfg.sprint * dt * 1.35 + 0.35;
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
      ])),
      npcs: g.npcs.map(n => ([
        round(n.root.position.x), round(n.root.position.y), round(n.root.position.z),
        round(n.heading), n.alive ? 1 : 0, n.grounded ? 1 : 0, round(n.vy),
      ])),
      targets: g.targets.map(t => ([
        round(t.mesh.position.x), round(t.mesh.position.y), round(t.mesh.position.z),
        t.alive ? 1 : 0,
      ])),
    };
  }

  /* ----------------------------------------------------------------- loop */
  step(dtMs) {
    this.tick++;
    this.game.update(dtMs / 1000);
    this.sinceSnapshot += dtMs;
    if (this.sinceSnapshot >= this.snapshotMs) {
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

module.exports = { Room, SIM_HZ, SNAPSHOT_HZ };
