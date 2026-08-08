/* A match: one headless world, the players in it, and the tick loops.
 *
 * Authority is hybrid — clients own where they are, the server owns everything
 * else (NPCs, targets, scoring later) and sanity-checks every position it is
 * told about. A client that claims to have moved further than it possibly
 * could gets snapped back.
 */
'use strict';

const { createHeadlessGame, load } = require('./engine.js');

/* The engine's shared namespace, loaded now rather than on the first room.
 *
 * The rules about who may hurt whom are in src/options.js, and the server reads
 * that table rather than keeping a second copy of it — a mode that means one
 * thing in the menu and another on the server is a bug nobody would ever find
 * by reading either half. Same reason the name sanitiser is shared. */
load();
const PB = globalThis.PB;

const SIM_HZ = 30;

/* One snapshot per simulation tick.
 *
 * It used to be 20Hz, which does not divide into a 30Hz tick: the accumulator
 * fired on alternate ticks and snapshots left here 33ms apart, then 67ms, then
 * 33ms. Clients hold a buffer sized for the gap between snapshots, and that
 * built-in wobble was enough to empty it — the other player froze for a frame
 * or two and then jumped. Matching the tick makes the spacing exactly even,
 * which is worth more than the bandwidth it costs. */
const SNAPSHOT_HZ = SIM_HZ;

/* How far back a shot may be judged. A client reports how far behind it was
 * drawing when it aimed and the shot is placed at that moment, so there is no
 * default window to pick — only a ceiling. A slow client legitimately aims at
 * an older world than a fast one; beyond this, a claim is not a late packet,
 * it is someone shooting at ghosts. */
const MAX_REWIND_MS = 700;

/* Most a player may move in one go having stood still long enough to earn it.
 *
 * Sized to match the rewind window: the server is already willing to believe a
 * client is 350ms behind when it shoots, so it has to be willing to believe
 * the same client's movement arrived 350ms late. At a sprint that is about
 * four units. Tighter than this and a client that stalls for a couple of
 * frames — which a busy machine does — gets snapped back mid-stride. It is
 * still nowhere near enough to cross a sixty-unit arena with. */
const MOVE_BURST = 4;

/* How often the scoreboard goes out. A table of names and totals that moves a
 * few times a match does not need the snapshot rate; once a second is faster
 * than anybody can read it. */
const SCORES_MS = 1000;

/* How much chat one player may put on everyone else's screen. Three in hand
 * and one back every two seconds: a burst is conversation, a stream is not. */
const CHAT_BURST = 3;
const CHAT_REFILL_MS = 2000;
const CHAT_MAX = 120;

/* How long a seat is kept for somebody whose socket dropped. Long enough to
 * cover a lid closing, a tunnel, or a redeploy of this very server; short
 * enough that a name nobody is behind any more leaves the scoreboard while the
 * match is still the same match. */
const GRACE_MS = 45000;

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
    this.sinceScores = 0;
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

    /* The hunters shoot at players, and players are not in the world the
     * engine simulates — they belong to the room. So the room says who is
     * worth aiming at, and settles what each round hit when it goes off. */
    this.game.setHunterTargets(() => this.huntable());
    this.game.on('npcShot', shot => {
      const event = this.applyNpcShot(shot);
      if (event) this.onBroadcast(event);
    });
    return this.seed;
  }

  /* Everyone a hunter may come after: alive, in the world, and open to being
   * come after. Positions are eye height, which is how a player is kept on
   * both sides.
   *
   * Health travels with them because the hunter weighs it — somebody nearly
   * finished is worth turning to.
   *
   * Peaceful players are not on this list at all, rather than being on it and
   * immune. A hunter that can see you, walks towards you and empties a magazine
   * at you has not left you alone in any sense that matters, whatever the
   * damage numbers say. PVE players are on it: that is what PVE is for. */
  huntable() {
    const out = [];
    for (const p of this.players.values()) {
      if (p.deadUntil || p.goneAt) continue;
      if (!PB.openToEnemies(p.mode)) continue;
      out.push({
        id: p.id, x: p.x, y: p.y, z: p.z,
        health: p.health, maxHealth: this.game.cfg.playerHealth,
      });
    }
    return out;
  }

  /* A round from the level's own enemy. Same test as a player's, with nobody
   * to credit: no score changes hands and the kill belongs to no one. */
  applyNpcShot(shot, now = Date.now()) {
    const THREE = globalThis.THREE;
    const g = this.game;
    const origin = new THREE.Vector3(shot.origin.x, shot.origin.y, shot.origin.z);
    const dir = new THREE.Vector3(shot.dir.x, shot.dir.y, shot.dir.z);
    if (dir.lengthSq() < 1e-6) return null;

    const event = {
      t: 'hit', by: 0, npc: shot.index,
      level: g.state.level,
      origin: { x: r3(shot.origin.x), y: r3(shot.origin.y), z: r3(shot.origin.z) },
      point: { x: r3(shot.point.x), y: r3(shot.point.y), z: r3(shot.point.z) },
      dir: { x: r3(dir.x), y: r3(dir.y), z: r3(dir.z) },
      kind: 'miss',
    };

    const onPlayer = this.playerHit(origin, dir, shot.distance, null);
    if (!onPlayer) return event;

    const victim = onPlayer.entity;
    const outcome = this.damage(victim, null, now);
    if (!outcome) return event;

    event.kind = 'player';
    event.point = { x: r3(onPlayer.point.x), y: r3(onPlayer.point.y), z: r3(onPlayer.point.z) };
    event.victim = victim.id;
    event.victimName = victim.name;
    event.killerName = 'THE HUNTER';
    event.victimHealth = victim.health;
    event.killed = !!outcome.killed;
    event.blocked = outcome.blocked || null;
    return event;
  }

  /* ------------------------------------------------------------- players */
  join(name) {
    /* An empty room means the last match is over. Rebuild before letting the
     * first player in, so they arrive on a fresh map at level one rather than
     * inheriting whatever the previous session left behind — a half-cleared
     * arena, a level count from someone else's game, perks on the ground.
     *
     * Somebody still inside their grace counts as being in the room: their
     * score is being kept for them, and rebuilding the world underneath it
     * would hand them back a match that no longer exists. */
    if (this.players.size === 0) this.buildWorld(this.pinnedSeed);

    const id = this.nextId++;
    const player = {
      id,
      name: cleanName(name),
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
      /* Who may hurt them: other players, the level's enemies, or nobody.
       * `pvp` is a readout of it, kept for clients from before there were
       * modes — PB.openToPlayers is what derives it. */
      mode: 'pvp',
      pvp: true,
      health: 0,                 // set from the world's config just below
      deadUntil: 0,              // waiting to respawn
      shieldUntil: 0,            // no damage until this passes
      healAt: 0,                 // when the next point of health is due
      kills: 0,
      deaths: 0,
      perks: {},
      stats: { shotsFired: 0, shotsHit: 0, misses: 0, targetsBroken: 0, npcsDown: 0 },
      /* What a returning socket proves itself with. A dropped connection is
       * ordinary — a laptop lid, a train tunnel, a redeploy — and coming back
       * as a stranger with nothing to your name is a worse answer to it than
       * holding the seat for a minute. Not guessable: it is the only thing
       * standing between somebody and another player's score. */
      token: newToken(),
      goneAt: 0,                 // when the socket dropped, 0 while connected
      fps: 0,                    // what their machine says it is drawing at
      ping: 0,                   // and the round trip it last measured to here
    };
    player.health = this.game.cfg.playerHealth;
    player.healAt = Date.now() + this.game.cfg.healEvery * 1000;
    // the same protection the dead come back with: nobody arrives in a room
    // they cannot see yet and gets shot before the first frame is drawn
    player.shieldUntil = Date.now() + this.game.cfg.spawnShield * 1000;
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

  /* --------------------------------------------------- losing the thread */
  /* A socket went away. The seat is kept, and everything in it — score, kills,
   * the lot — until the grace runs out.
   *
   * They come out of the world immediately, though. A body left standing where
   * somebody rage-quit is one that soaks up rounds and gets shot for points,
   * and a hunter would happily spend the next minute emptying itself into it. */
  disconnect(id, now = Date.now()) {
    const player = this.players.get(id);
    if (!player || player.goneAt) return null;
    player.goneAt = now;
    return player;
  }

  /* Prove who you were and pick the seat back up. The name comes with them
   * because it may have changed in the meantime — in the options panel, while
   * disconnected — and the token is what says it is the same person. */
  resume(token, name, now = Date.now()) {
    if (!token) return null;
    for (const p of this.players.values()) {
      if (p.token !== token || !p.goneAt) continue;
      if (now - p.goneAt > GRACE_MS) return null;      // the seat is not theirs
      p.goneAt = 0;
      if (typeof name === 'string' && name) p.name = cleanName(name);
      p.lastStateAt = now;
      p.moveCredit = MOVE_BURST;
      /* Back on the same terms as coming out of a respawn: a moment of
       * protection, and a moment where their own idea of where they are is
       * not held against them. They have been away; the world has not. */
      p.settleUntil = now + 1000;
      p.shieldUntil = now + this.game.cfg.spawnShield * 1000;
      p.healAt = now + this.game.cfg.healEvery * 1000;
      return p;
    }
    return null;
  }

  /* Whoever ran out of grace. Their seat goes, and the room is told properly
   * so the tags and the scoreboard let go of them. */
  sweepGone(now = Date.now()) {
    const left = [];
    for (const p of [...this.players.values()]) {
      if (!p.goneAt || now - p.goneAt <= GRACE_MS) continue;
      this.players.delete(p.id);
      left.push({ t: 'left', id: p.id, name: p.name });
    }
    return left;
  }

  // in the room, and on the end of a socket
  here(p) {
    return !!p && !p.goneAt;
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
      /* Which of them are hunters, said outright rather than left to be worked
       * out. The rule — the first few of a level, by level — holds for a level
       * as it is built and stops holding the moment one is added to a level
       * already running, because that one goes on the end. Saying it costs a
       * handful of numbers on a message that goes out when a level turns over. */
      hunters: this.game.npcs.reduce((at, n, i) => (n.hunter ? at.concat(i) : at), []),
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
      // what a dropped connection comes back with; see resume()
      token: player.token,
      seed: this.seed,
      simHz: SIM_HZ,
      snapshotHz: SNAPSHOT_HZ,
      you: this.publicPlayer(player),
      players: [...this.players.values()]
        .filter(p => p.id !== player.id && !p.goneAt)
        .map(p => this.publicPlayer(p)),
    };
  }

  publicPlayer(p) {
    return {
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
      score: p.score, health: p.health, maxHealth: this.game.cfg.playerHealth,
      mode: p.mode, pvp: p.pvp,
    };
  }

  /* What a player calls themselves, and whether they are in the fight. Both
   * change mid-match, and everyone else has to be told at once — a name over
   * somebody's head that is a match out of date is worse than none. */
  setPrefs(id, prefs) {
    const player = this.players.get(id);
    if (!player) return null;
    if (prefs && typeof prefs.name === 'string') {
      player.name = cleanName(prefs.name);
    }
    /* A mode wins over the boolean when both turn up, and the boolean is still
     * read on its own so that a client from before modes existed keeps working.
     * PB.modeFrom is what decides, on both sides of the wire. */
    if (prefs && (typeof prefs.mode === 'string' || typeof prefs.pvp === 'boolean')) {
      player.mode = PB.modeFrom(prefs);
      player.pvp = PB.openToPlayers(player.mode);
    }
    return { t: 'prefs', id: player.id, name: player.name,
             mode: player.mode, pvp: player.pvp };
  }

  /* Can `shooter` hurt `victim` at all? Either one being out of PvP is enough,
   * and peaceful is out of everything. */
  canHurt(shooter, victim) {
    if (!shooter || !victim || shooter === victim) return false;
    return PB.openToPlayers(shooter.mode) && PB.openToPlayers(victim.mode);
  }

  /* Somebody has stepped on a corner pad and wants to be somewhere else.
   *
   * The client asks rather than moves, because the server owns where everybody
   * is for the purposes of being shot at, and forty metres in one frame is
   * exactly what the move-credit check exists to reject. Checked here: they
   * have to actually be standing on the pad they claim, and not have used one
   * a moment ago. The move is applied to the server's copy and the instruction
   * goes back, so both sides agree about where they now are.
   */
  warp(id, from, now = Date.now()) {
    const player = this.players.get(id);
    if (!player || player.deadUntil || player.goneAt) return null;
    if (now < (player.warpUntil || 0)) return null;

    const pads = this.game.warps;
    const pad = pads && pads[from];
    if (!pad) return null;
    // where they say they are is where they have to be
    const feet = player.y - this.game.cfg.eye;
    if (Math.hypot(pad.x - player.x, pad.z - player.z) > this.game.cfg.warpRadius + 1) {
      return null;
    }
    if (Math.abs(feet) > 1.5) return null;

    const dest = this.game.warpDestination(pad);
    const inward = Math.hypot(dest.x, dest.z) || 1;
    const off = this.game.cfg.warpRadius + 0.9;
    player.x = dest.x - (dest.x / inward) * off;
    player.z = dest.z - (dest.z / inward) * off;
    player.y = this.game.cfg.eye;
    player.vy = 0;
    player.warpUntil = now + this.game.cfg.warpCooldown * 1000;
    /* The same grace a respawn gets, and for the same reason: states already
     * on their way here describe the corner they left from, and refusing those
     * as impossible moves would be holding a warp against the person who took
     * it. The credit is spent rather than refilled — a full budget on arrival
     * would let the next few frames cover the distance the warp just did. */
    player.moveCredit = 0;
    player.settleUntil = now + 1000;
    return {
      t: 'warp', id: player.id, to: dest.index,
      x: r3(player.x), y: r3(player.y), z: r3(player.z),
    };
  }

  shielded(player, now = Date.now()) {
    return now < player.shieldUntil ||
           this.game.perkSystem.held(player, 'shield');
  }

  /* ---------------------------------------------------------- being shot */
  /* A player is a box standing on their feet, the same box the client hangs on
   * the figure it draws — PB.HIT is where both of them get it from, so the two
   * cannot drift apart. */
  playerBox(p, out) {
    const feet = p.y - this.game.cfg.eye;
    return hitBoxAt(p.x, feet, p.z, out);
  }

  // Nearest player the shot would hit right now, ignoring whoever fired it.
  playerHit(origin, dir, maxDistance, exceptId) {
    const THREE = globalThis.THREE;
    const ray = new THREE.Ray(origin, dir);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    const shooter = this.players.get(exceptId);
    let best = null;
    for (const p of this.players.values()) {
      if (p.id === exceptId || p.deadUntil || p.goneAt) continue;
      /* Somebody out of the fight is not in the way of it either: the round
       * carries on to whatever is behind them. Only a player's round, though —
       * with no shooter this is the level's own enemy firing, and opting out of
       * PvP is an agreement between players. */
      if (shooter && !this.canHurt(shooter, p)) continue;
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
  /* `shooter` is null when the round came from the level itself rather than
   * from another player: nobody is credited, and the PvP opt-out does not
   * apply — it is an agreement between players. */
  damage(victim, shooter, now = Date.now()) {
    if (victim.deadUntil) return null;
    if (shooter && !this.canHurt(shooter, victim)) {
      return { blocked: 'pvp', killed: false, health: victim.health };
    }
    /* No shooter means the level's own enemy fired it, and the mode says
     * whether that reaches them. Checked here as well as in huntable(), because
     * a round already in flight when somebody switched to peaceful must not
     * land — and because this is the one place damage is actually taken off. */
    if (!shooter && !PB.openToEnemies(victim.mode)) {
      return { blocked: 'peaceful', killed: false, health: victim.health };
    }
    if (this.shielded(victim, now)) {
      return { blocked: 'shield', killed: false, health: victim.health };
    }
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
        if (other.id === player.id || other.deadUntil || other.goneAt) continue;
        gap = Math.min(gap, Math.hypot(other.x - x, other.z - z));
      }
      if (gap > bestGap) { bestGap = gap; best = { x, z }; }
      if (gap > 15) break;                       // far enough, stop looking
    }
    return best || { x: 0, z: 0 };
  }

  respawn(player, now = Date.now()) {
    const g = this.game;
    const at = this.clearSpot(player);
    player.x = at.x;
    player.y = g.cfg.eye;
    player.z = at.z;
    player.health = g.cfg.playerHealth;
    player.deadUntil = 0;
    player.lastStateAt = now;
    /* A moment of protection on the way back in. Without it the player who
     * killed you is still standing where they were, looking at the spot you
     * are about to appear in, and a respawn is a free second kill. */
    player.shieldUntil = player.lastStateAt + g.cfg.spawnShield * 1000;
    player.moveCredit = MOVE_BURST;
    /* States sent before the client heard about the respawn still describe the
     * spot they died on. Those are refused — the server owns where they came
     * back — but they are not the player's fault, so they are not held
     * against them. */
    player.settleUntil = player.lastStateAt + 1000;
    return at;
  }

  /* Health packs. The arena is seeded, so every client already knows where the
   * two of them stand; the server owns whether one is there to be taken and
   * who took it. */
  updateMedkits(now = Date.now()) {
    const g = this.game;
    const events = [];
    for (const kit of g.medkits) {
      if (!kit.ready && now >= kit.backAt) kit.ready = true;
    }
    for (const p of this.players.values()) {
      if (p.goneAt || p.deadUntil || p.health >= g.cfg.playerHealth) continue;
      const kit = g.medkitAt(p.x, p.z, p.y - g.cfg.eye);
      if (!kit) continue;
      kit.ready = false;
      kit.backAt = now + g.cfg.medkitRespawn * 1000;
      p.health = g.cfg.playerHealth;
      p.healAt = now + g.cfg.healEvery * 1000;
      events.push({ t: 'medkit', by: p.id, index: kit.index, health: p.health });
    }
    return events;
  }

  /* Health comes back a point at a time, and the dead come back whole. */
  updateHealth(now = Date.now()) {
    const events = [];
    const cfg = this.game.cfg;
    for (const p of this.players.values()) {
      if (p.goneAt) continue;
      if (p.deadUntil) {
        if (now >= p.deadUntil) {
          const at = this.respawn(p, now);
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

  /* The two samples either side of a moment. A claim is checked against where
   * things were *then* — not against everywhere they have been since. */
  framesAround(t) {
    const n = this.history.length;
    if (!n) return null;
    if (n === 1) return [this.history[0], this.history[0]];
    for (let h = n - 1; h > 0; h--) {
      if (this.history[h - 1].t <= t) return [this.history[h - 1], this.history[h]];
    }
    return [this.history[0], this.history[1]];
  }

  /* Check the one thing the client says it hit, against where that thing was
   * when the client was looking at it.
   *
   * This replaces a search, and the difference is the whole point. The old
   * version walked every frame in the rewind window and kept the nearest hit
   * found in any of them, so a moving figure was not a box but a smear as long
   * as its own travel over that window — at 30Hz history and a 350ms window,
   * an NPC at a run left about 1.8u of trail that still scored. Shots that
   * landed well behind somebody were credited as kills.
   *
   * The client already raycasts the same boxes, so it knows what it hit. It
   * says so, and this checks that one entity at that one moment. */
  verifyClaim(claim, origin, dir, maxDistance, now = Date.now(), lagMs = 0, exceptId = null) {
    if (!claim || typeof claim !== 'object') return null;
    const at = now - Math.max(0, Math.min(MAX_REWIND_MS, lagMs));
    const pair = this.framesAround(at);
    if (!pair) return null;
    const [older, newer] = pair;

    const THREE = globalThis.THREE;
    const ray = new THREE.Ray(origin, dir);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();

    /* Still swept between the two samples: a figure at a run covers most of
     * its own width in the 33ms between them, and testing either sample alone
     * leaves a gap to slip through. One interval, not the whole window. */
    if (claim.kind === 'npc') {
      const i = claim.index | 0;
      const npc = this.game.npcs[i];
      const p = newer.npcs[i];
      if (!npc || !npc.alive || !p) return null;
      const q = (older && older.npcs[i]) || p;
      sweptHitBox(p[0], p[1], p[2], q[0], q[1], q[2], box);
      if (!ray.intersectBox(box, point)) return null;
      const d = origin.distanceTo(point);
      if (d > maxDistance) return null;
      return { kind: 'npc', index: i, entity: npc, distance: d, point: point.clone() };
    }

    if (claim.kind === 'player') {
      const victim = this.players.get(claim.id);
      const shooter = this.players.get(exceptId);
      if (!victim || victim.id === exceptId || victim.deadUntil) return null;
      // somebody out of the fight was never in the way of the round
      if (!this.canHurt(shooter, victim)) return null;
      const rec = (newer.players || []).find(r => r && r[0] === victim.id);
      if (!rec) return null;
      const was = (older && older.players
        && older.players.find(r => r && r[0] === victim.id)) || rec;
      // their y is an eye height; the box is built from the feet
      const eye = this.game.cfg.eye;
      sweptHitBox(rec[1], rec[2] - eye, rec[3], was[1], was[2] - eye, was[3], box);
      if (!ray.intersectBox(box, point)) return null;
      const d = origin.distanceTo(point);
      if (d > maxDistance) return null;
      return { kind: 'player', entity: victim, distance: d, point: point.clone() };
    }

    if (claim.kind === 'target') {
      const j = claim.index | 0;
      const target = this.game.targets[j];
      const p = newer.targets[j];
      if (!target || !target.alive || !p) return null;
      const q = (older && older.targets[j]) || p;
      box.min.set(Math.min(p[0], q[0]) - 0.62, Math.min(p[1], q[1]) - 0.62, Math.min(p[2], q[2]) - 0.62);
      box.max.set(Math.max(p[0], q[0]) + 0.62, Math.max(p[1], q[1]) + 0.62, Math.max(p[2], q[2]) + 0.62);
      if (!ray.intersectBox(box, point)) return null;
      const d = origin.distanceTo(point);
      if (d > maxDistance) return null;
      return { kind: 'target', index: j, entity: target, distance: d, point: point.clone() };
    }

    return null;
  }

  /* ---------------------------------------------------------------- perks */
  /* The server owns what is on the ground and who got it. A client that walks
   * over a perk does not grant itself anything — it waits to be told. */
  collectPerks(now = Date.now()) {
    const g = this.game;
    const picked = [];
    for (const player of this.players.values()) {
      if (player.goneAt) continue;
      const perk = g.perkSystem.pickUpAt(player.x, player.z, player.y - g.cfg.eye);
      if (!perk) continue;
      g.perkSystem.grant(player, perk.kind);
      g.perkSystem.remove(perk);
      picked.push({
        t: 'perk', by: player.id, kind: perk.kind, id: perk.id,
        label: perk.def.label, duration: g.perkSystem.durationOf(perk.kind),
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

    /* If the shot did not land on an entity where it stands right now, check
     * what the client says it hit, where that was while the round was in
     * flight — but never through cover, so the rewind reaches no further than
     * the first wall.
     *
     * No claim means no hit. The client runs the same raycast against the same
     * boxes before it sends anything, so a round it did not see land is a
     * miss; the server does not go looking for something to award. */
    if (!hit.target && !hit.npc && !hit.player && msg.claim) {
      const reach = hit.distance || 300;
      const asked = typeof msg.lag === 'number' && isFinite(msg.lag) ? msg.lag : 0;
      const lagMs = Math.min(MAX_REWIND_MS, Math.max(0, asked));
      const rewound = this.verifyClaim(msg.claim, origin, dir, reach, now, lagMs, id);
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
      event.victimName = victim.name;
      event.killerName = player.name;
      event.victimHealth = victim.health;
      event.killed = !!(outcome && outcome.killed);
      // a round that hit a shield landed, but it did nothing
      event.blocked = (outcome && outcome.blocked) || null;
      if (!event.blocked) player.stats.shotsHit++;
    } else if (hit.npc && hit.npc.alive) {
      /* A hunter takes several rounds. Only the one that finishes it pays out
       * and counts, and the room is told which kind this was so every screen
       * can show a hit that landed differently from one that ended it. */
      const npc = hit.npc;
      const down = g.hitNPC(npc, 1, dir);
      event.kind = 'npc';
      event.index = g.npcs.indexOf(npc);
      event.hunter = !!npc.hunter;
      event.killed = down.killed;
      event.npcHealth = down.health;
      event.npcMaxHealth = npc.maxHealth;
      player.stats.shotsHit++;
      if (down.killed) {
        player.stats.npcsDown++;
        this.award(player, npc.hunter ? cfg.scoreHunter : cfg.scoreNpc);
      }
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
      // somebody whose socket dropped is not in the world at all: no body to
      // draw, to shoot, or to walk into
      players: [...this.players.values()].filter(p => !p.goneAt).map(p => ([
        p.id,
        round(p.x), round(p.y), round(p.z),
        round(p.yaw), p.moving ? 1 : 0, p.grounded ? 1 : 0, round(p.vy),
        p.score, p.health, p.deadUntil ? 1 : 0,
        this.shielded(p) ? 1 : 0, PB.modeIndex(p.mode),
      ])),
      npcs: g.npcs.map(n => ([
        round(n.root.position.x), round(n.root.position.y), round(n.root.position.z),
        round(n.heading), n.alive ? 1 : 0, n.grounded ? 1 : 0, round(n.vy),
        /* How far through falling over it is, and which way it is going —
         * both only mean anything once it is down. The direction never changes
         * after the round that caused it, but it has to ride along: a client
         * that joined afterwards was never told about the shot. */
        round(n.topple || 0), round(n.fallDir || 0),
        // what is left of it, so a hurt hunter wears it where everyone sees
        n.health, n.maxHealth,
      ])),
      targets: g.targets.map(t => ([
        round(t.mesh.position.x), round(t.mesh.position.y), round(t.mesh.position.z),
        t.alive ? 1 : 0,
      ])),
      // the sliders are a pure function of this, so the clock is all that
      // has to travel for every client to have them in the same place
      wt: round(g.state.worldTime),
      perks: g.perkSystem.describe(),
      // where the packs are is seeded; only whether they are there travels
      kits: g.medkits.map(k => (k.ready ? 1 : 0)),
    };
  }

  /* How a client says it is doing: what it is drawing at, and the round trip
   * it last measured to here. Both are its own word for itself — the server
   * cannot see somebody else's frame rate, and the round trip is only
   * measurable from the end that started it — so both are held to a sane range
   * and treated as what they are: numbers for the scoreboard that no rule
   * depends on. */
  reportFps(id, fps, ping) {
    const player = this.players.get(id);
    if (!player) return null;
    const f = Math.round(Number(fps));
    if (isFinite(f) && f >= 0) player.fps = Math.min(999, f);
    const p = Math.round(Number(ping));
    if (isFinite(p) && p >= 0) player.ping = Math.min(9999, p);
    return player.fps;
  }

  /* ------------------------------------------------------ the controls */
  /* Start the whole thing again: a new map, level one, and everybody back to
   * nothing. Every client's arena was generated from the old seed and cannot
   * be regenerated in place, so what goes out is the new seed and the fact of
   * it — the clients reload onto the new match, which is the same path a
   * player already takes when they come back from a drop to find the room
   * rebuilt underneath them.
   *
   * Anyone in the room may do this. There is no host here, and a note in the
   * chat naming whoever did it is the whole of the accountability. */
  restart(by, now = Date.now()) {
    const seed = this.buildWorld(this.pinnedSeed === null ? null : this.pinnedSeed);
    for (const p of this.players.values()) {
      p.score = 0;
      p.kills = 0;
      p.deaths = 0;
      p.stats = { shotsFired: 0, shotsHit: 0, misses: 0, targetsBroken: 0, npcsDown: 0 };
      p.clientStats = null;
      p.perks = {};
      p.health = this.game.cfg.playerHealth;
      p.deadUntil = 0;
      p.healAt = now + this.game.cfg.healEvery * 1000;
      p.shieldUntil = now + this.game.cfg.spawnShield * 1000;
      p.lastStateAt = now;
      p.settleUntil = now + 1000;
      p.moveCredit = MOVE_BURST;
      const at = this.clearSpot(p);
      p.x = at.x;
      p.z = at.z;
      p.y = this.game.cfg.eye;
    }
    this.history.length = 0;
    const who = this.players.get(by);
    return { t: 'restart', seed, by: by || 0, name: who ? who.name : 'somebody' };
  }

  /* More of something, into the level already running. The level contents go
   * out afterwards so every client builds the same arena again — which is the
   * message they already handle when a level turns over. */
  addToLevel(what, count, by) {
    const kinds = ['target', 'npc', 'hunter', 'perk'];
    if (kinds.indexOf(what) === -1) return null;
    const made = this.game.addToLevel(what, count);
    if (!made) return null;
    const who = this.players.get(by);
    return {
      made, what,
      level: this.levelMessage(),
      note: { t: 'added', what, made, by: by || 0, name: who ? who.name : 'somebody' },
    };
  }

  /* --------------------------------------------------------------- chat */
  /* What somebody typed, cleaned up and stamped.
   *
   * Everything here is a rule about other people's text going onto everyone
   * else's screen, which is why none of it is left to the sender: length,
   * what characters may be in it, and how often. The client cleans and escapes
   * as well, but a client is only ever the first line of that.
   *
   * The stamp is the server's clock. Every screen renders it in its own local
   * time, which is what the reader wants to see — and taking it from the
   * server means two people in different places still see the same order. */
  chat(id, text, now = Date.now()) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: 'unknown player' };

    const said = cleanChat(text);
    if (!said) return { ok: false, reason: 'nothing to say' };

    /* An allowance rather than a gap between messages: a burst of three is
     * ordinary conversation, and a steady stream of them is not. Refills at
     * one every two seconds. */
    const since = Math.max(0, now - (player.chatAt || 0));
    player.chatCredit = Math.min(CHAT_BURST,
      (player.chatCredit === undefined ? CHAT_BURST : player.chatCredit) + since / CHAT_REFILL_MS);
    player.chatAt = now;
    if (player.chatCredit < 1) {
      return { ok: false, reason: 'too much at once' };
    }
    player.chatCredit -= 1;

    return {
      ok: true,
      event: { t: 'chat', from: player.id, name: player.name, text: said, at: now },
    };
  }

  /* --------------------------------------------------------- scoreboard */
  /* Who is in the room and how they are doing, on its own message rather than
   * in the snapshot.
   *
   * The snapshot already carries a score, but not a name, and not kills or
   * deaths — and those change a handful of times a match, so paying for them
   * thirty times a second to watch them not change would be silly. This goes
   * out once a second instead, which is as often as a table anybody is reading
   * needs to move.
   *
   * Kills and deaths are the server's own count, taken where the damage is
   * done. Clients send their own accounting too — see the `stats` message —
   * but that is their word for their own figures, and this table is the one
   * everybody sees.
   *
   * Sorted here, so every client shows the same order rather than each
   * inventing its own tie-break. */
  scoreboard() {
    const rows = [...this.players.values()]
      // somebody whose socket dropped stays on the table while their seat is
      // being kept: their score is still theirs, and the room can see that
      // they are away rather than watching them vanish and reappear
      .map(p => ([p.id, p.name, p.score, p.kills, p.deaths,
                  p.deadUntil ? 1 : 0, p.goneAt ? 1 : 0, p.fps || 0, p.ping || 0]))
      .sort((a, b) => b[2] - a[2] || b[3] - a[3] || a[1].localeCompare(b[1]));
    return { t: 'scores', players: rows };
  }

  /* ----------------------------------------------------------------- loop */
  step(dtMs, now = Date.now()) {
    this.tick++;
    const dt = dtMs / 1000;
    this.game.update(dt);

    for (const player of this.players.values()) {
      this.game.perkSystem.tickHolder(player, dt);
    }
    for (const msg of this.sweepGone(now)) this.onBroadcast(msg);
    for (const msg of this.collectPerks(now)) this.onBroadcast(msg);
    for (const msg of this.updateMedkits(now)) this.onBroadcast(msg);
    for (const msg of this.updateHealth(now)) this.onBroadcast(msg);

    this.sinceScores += dtMs;
    if (this.sinceScores >= SCORES_MS) {
      this.sinceScores -= SCORES_MS;
      if (this.players.size) this.onBroadcast(this.scoreboard());
    }

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

/* The only thing between somebody and another player's seat, so it comes from
 * the platform's own source of randomness rather than from Math.random. */
function newToken() {
  return require('crypto').randomBytes(16).toString('hex');
}
const r3 = round;

/* The one hit volume, straight off the client's own definition. Both a live
 * box and a rewound one are built through here, so neither can wander. */
function hitBoxAt(x, feetY, z, out) {
  const H = globalThis.PB.HIT;
  out.min.set(x - H.half, feetY + H.bottom, z - H.half);
  out.max.set(x + H.half, feetY + H.top, z + H.half);
  return out;
}

/* Swept between two samples: a figure at a run covers most of its own width
 * between snapshots, and testing the samples alone leaves gaps to slip
 * through. */
function sweptHitBox(ax, ay, az, bx, by, bz, out) {
  const H = globalThis.PB.HIT;
  out.min.set(Math.min(ax, bx) - H.half,
              Math.min(ay, by) + H.bottom,
              Math.min(az, bz) - H.half);
  out.max.set(Math.max(ax, bx) + H.half,
              Math.max(ay, by) + H.top,
              Math.max(az, bz) + H.half);
  return out;
}

/* What may go on everyone else's screen.
 *
 * Control characters out — a newline turns one line into two, and a stray
 * escape sequence can do worse to whatever is reading the server log. Runs of
 * whitespace collapse, because a message padded to the length limit is a way
 * of taking the whole log for yourself. The cap goes on what is left. */
function cleanChat(raw) {
  if (typeof raw !== 'string') return '';
    return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX);
}

/* The client's own sanitiser, run again here. Never trust the name a socket
 * sends: it goes over every other player's head, and the rule for what may be
 * in one lives in exactly one place. */
function cleanName(raw) {
  const PB = globalThis.PB;
  if (PB && PB.cleanOption) return PB.cleanOption('name', raw);
  return String(raw || 'player').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 16) || 'player';
}

module.exports = { Room, SIM_HZ, SNAPSHOT_HZ, MAX_REWIND_MS, MOVE_BURST,
                   CHAT_MAX, CHAT_BURST, GRACE_MS, cleanChat };
