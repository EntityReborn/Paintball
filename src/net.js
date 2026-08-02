/* Client networking.
 *
 * Sends our own position on a fixed clock and renders everyone else from the
 * server's snapshots, held back by one interpolation window so the motion is
 * smooth rather than arriving in 20Hz steps. Local prediction is simply that
 * we keep playing our own game — the server only corrects us when a position
 * fails its plausibility check.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

var SEND_HZ = 30;
var INTERP_MS = 110;          // render remote motion this far behind arrival
var BUFFER_MS = 1200;

/* Radians of run cycle per unit travelled. An NPC deciding its own path uses
 * `dt * speed * 2.4`, and speed * dt is exactly the distance it covered, so
 * matching that here keeps a figure's stride identical whether it is being
 * simulated locally or followed over the wire. */
var PHASE_PER_UNIT = 2.4;

PB.createNet = function (opts) {
  var THREE = global.THREE;
  var url = opts.url;
  var name = opts.name || 'player';

  var socket = null;
  var self = { id: null, seed: null, connected: false, error: null, arenaMatch: null };
  var listeners = {};
  var snapshots = [];           // {at, players, npcs, targets}
  var remotes = new Map();      // id -> {fig, phase, name, last}
  var departed = new Set();     // ids that have left, so a stale snapshot cannot revive them
  var names = new Map();        // id -> display name, for the tags over their heads
  var showNames = true;
  var maxHealth = 10;
  var game = null;
  var sendTimer = null;
  var statsTimer = null;
  var lastUpdateAt = 0;
  var figureGeo = null;
  var stats = { sent: 0, received: 0, corrections: 0, lastCorrection: null,
                lastLatency: 0, hits: 0, shots: 0, rejected: 0, lastRejection: null };

  function on(evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); return api; }
  function emit(evt, data) {
    var subs = listeners[evt];
    if (!subs) return;
    for (var i = 0; i < subs.length; i++) subs[i](data);
  }

  function send(msg) {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function connect() {
    socket = new global.WebSocket(url);

    socket.onopen = function () {
      self.connected = true;
      send({ t: 'join', name: name });
    };

    socket.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }
      handle(msg);
    };

    socket.onclose = function () {
      self.connected = false;
      stopSending();
      emit('disconnected', {});
    };

    socket.onerror = function () {
      self.error = 'connection failed';
      emit('error', { message: self.error });
    };
  }

  function handle(msg) {
    if (msg.t === 'hello') {
      self.id = msg.id;
      self.seed = msg.seed;
      (msg.players || []).forEach(function (p) { names.set(p.id, p.name); });
      if (msg.you && msg.you.maxHealth) maxHealth = msg.you.maxHealth;
      if (game && msg.you) {
        game.setHealth(msg.you.health, maxHealth);
        // the server picked our spot, so we do not land on top of somebody
        game.teleport(msg.you.x, msg.you.y, msg.you.z);
      }
      emit('hello', msg);
      return;
    }
    if (msg.t === 'perk') {
      if (game) {
        if (msg.by === self.id) game.grantPerk(msg.kind);
        game.perkSystem.remove(game.perkSystem.byId(msg.id) || {});
      }
      emit('perk', msg);
      return;
    }
    if (msg.t === 'levelStart') {
      snapshots.length = 0;              // the old indices mean nothing now
      if (game) game.applyLevel(msg);
      emit('levelStart', msg);
      return;
    }
    if (msg.t === 'snapshot') {
      stats.received++;
      // keep every field the interpolation reads: picking out a few by hand is
      // how the world clock and the perk list went missing on the way in
      msg.at = now();
      snapshots.push(msg);
      var cutoff = now() - BUFFER_MS;
      while (snapshots.length > 2 && snapshots[0].at < cutoff) snapshots.shift();
      return;
    }
    if (msg.t === 'joined') {
      departed.delete(msg.player.id);
      names.set(msg.player.id, msg.player.name);
      emit('joined', msg.player);
      return;
    }
    if (msg.t === 'left') {
      departed.add(msg.id);
      dropRemote(msg.id);
      emit('left', msg);
      return;
    }
    if (msg.t === 'correction') {
      stats.corrections++;
      stats.lastCorrection = msg.reason || null;
      if (game) game.teleport(msg.x, msg.y, msg.z);
      emit('correction', msg);
      return;
    }
    if (msg.t === 'hit') {
      var mine = msg.by === self.id;
      stats.hits++;
      if (mine) stats.lastHit = msg.kind;
      if (game) {
        // the server decides outcomes; only our own shots move our score,
        // and only our own shots count towards our stats
        if (mine) game.setScore(msg.score);
        else game.showRemoteShot(msg);      // their tracer and the sound of it
        game.applyServerHit(msg, mine);
      }
      emit('hit', msg);
      return;
    }
    if (msg.t === 'respawn') {
      if (game && msg.id === self.id) {
        game.teleport(msg.x, msg.y, msg.z);
        game.setHealth(msg.health, maxHealth);
      }
      emit('respawn', msg);
      return;
    }
    if (msg.t === 'shotRejected') {
      stats.rejected++;
      stats.lastRejection = msg.reason;
      emit('shotRejected', msg);
      return;
    }
    if (msg.t === 'pong') {
      stats.lastLatency = now() - msg.c;
      return;
    }
  }

  function now() {
    return global.performance ? performance.now() : Date.now();
  }

  /* ------------------------------------------------------------- sending */
  function startSending(g) {
    game = g;
    figureGeo = PB.figureGeometry();

    /* Every shot goes to the server for adjudication, carrying how far behind
     * the server our view was when we aimed: the interpolation window plus
     * however long ago the last frame drew. The server rewinds by that much,
     * so a slow client is judged against the world it actually saw. */
    game.on('shotFired', function (d) {
      stats.shots++;
      var behind = INTERP_MS + Math.min(400, now() - lastUpdateAt);
      stats.lastLag = Math.round(behind);
      send({ t: 'shot', origin: d.origin, dir: d.dir, lag: Math.round(behind) });
    });

    // the client's own accounting, for the leaderboard work to come
    if (!statsTimer) {
      statsTimer = setInterval(function () {
        if (game && self.id) send({ t: 'stats', stats: game.stats() });
      }, 5000);
    }
    if (sendTimer) return;
    sendTimer = setInterval(function () {
      if (!game || !self.id) return;
      var p = game.state.pos;
      var speed = Math.hypot(game.state.vel.x, game.state.vel.z);
      var ok = send({
        t: 'state',
        x: round(p.x), y: round(p.y), z: round(p.z),
        yaw: round(game.yawObj.rotation.y),
        pitch: round(game.pitchObj.rotation.x),
        moving: speed > 0.5,
        grounded: game.state.grounded,
        vy: round(game.state.vy),
      });
      if (ok) stats.sent++;
    }, 1000 / SEND_HZ);
  }

  function stopSending() {
    if (sendTimer) clearInterval(sendTimer);
    if (statsTimer) clearInterval(statsTimer);
    sendTimer = null;
    statsTimer = null;
  }

  function round(n) { return Math.round(n * 1000) / 1000; }

  /* ------------------------------------------------------- interpolation */
  // the pair of snapshots bracketing the render time, plus the blend between
  function bracket(renderAt) {
    if (snapshots.length === 0) return null;
    if (snapshots.length === 1) return { a: snapshots[0], b: snapshots[0], f: 0 };
    for (var i = snapshots.length - 1; i > 0; i--) {
      if (snapshots[i - 1].at <= renderAt && snapshots[i].at >= renderAt) {
        var span = snapshots[i].at - snapshots[i - 1].at;
        return {
          a: snapshots[i - 1], b: snapshots[i],
          f: span > 0 ? (renderAt - snapshots[i - 1].at) / span : 0,
        };
      }
    }
    // behind or ahead of everything we hold: clamp to the nearest end
    if (renderAt < snapshots[0].at) return { a: snapshots[0], b: snapshots[0], f: 0 };
    var last = snapshots[snapshots.length - 1];
    return { a: last, b: last, f: 0 };
  }

  function lerp(a, b, f) { return a + (b - a) * f; }

  // yaw has to take the short way round
  function lerpAngle(a, b, f) {
    var d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    return a + (d < -Math.PI ? d + Math.PI * 2 : d) * f;
  }

  function remoteFor(id) {
    var r = remotes.get(id);
    if (r) return r;
    // players sit in a cool, high-contrast band; the NPCs get everything else
    var hue = 0.5 + ((id * 0.13) % 0.22);
    var accent = new THREE.Color().setHSL(hue, 0.9, 0.6);
    var fig = PB.buildFigure({
      geo: figureGeo, shadows: !!game.cfg.shadows, name: 'remote',
      variant: 'player',
      color: new THREE.Color().setHSL(hue, 0.75, 0.62),
      trim: new THREE.Color().setHSL(hue, 0.85, 0.4),
      accent: accent,
    });
    game.scene.add(fig.root);
    r = { fig: fig, phase: 0, last: null, tag: null };

    var label = names.get(id);
    if (label) {
      r.tag = PB.createNameTag(label, '#' + accent.getHexString());
      r.tag.sprite.visible = showNames;
      fig.root.add(r.tag.sprite);
    }
    r.health = PB.createHealthBar();
    fig.root.add(r.health.sprite);

    if (fig.hitbox) game.debugHitboxes && game.debugHitboxes.push(fig.hitbox);
    remotes.set(id, r);
    return r;
  }

  function dropRemote(id) {
    var r = remotes.get(id);
    if (!r) return;
    game.scene.remove(r.fig.root);
    r.fig.materials.forEach(function (m) { m.dispose(); });
    if (r.tag) {
      r.tag.material.dispose();
      r.tag.texture.dispose();
    }
    if (r.health) {
      r.health.material.dispose();
      r.health.texture.dispose();
    }
    if (game.debugHitboxes) {
      var at = game.debugHitboxes.indexOf(r.fig.hitbox);
      if (at !== -1) game.debugHitboxes.splice(at, 1);
    }
    remotes.delete(id);
  }

  /* Called every frame by the client: pose everyone else from the snapshot
   * buffer, and drop the local player's own entry (we draw ourselves through
   * the camera). */
  function update(dt) {
    if (!game || snapshots.length === 0) return;
    lastUpdateAt = now();
    var pair = bracket(now() - INTERP_MS);
    if (!pair) return;

    var seen = new Set();
    for (var i = 0; i < pair.b.players.length; i++) {
      var pb = pair.b.players[i];
      var id = pb[0];
      if (id === self.id) {
        // our own entry carries the health the server has for us
        if (pb.length > 9) game.setHealth(pb[9], maxHealth);
        continue;
      }
      if (departed.has(id)) continue;
      seen.add(id);

      var pa = findPlayer(pair.a.players, id) || pb;
      var r = remoteFor(id);
      var x = lerp(pa[1], pb[1], pair.f);
      var y = lerp(pa[2], pb[2], pair.f);
      var z = lerp(pa[3], pb[3], pair.f);

      if (r.last) {
        var moved = Math.hypot(x - r.last.x, z - r.last.z);
        r.phase += moved * PHASE_PER_UNIT;   // legs keep step with the ground
      }
      r.last = { x: x, y: y, z: z };

      // a player waiting to respawn is not in the world
      var down = pb.length > 10 && pb[10];
      r.fig.root.visible = !down;
      if (r.health && pb.length > 9) r.health.set(down ? 0 : pb[9], maxHealth);

      r.fig.root.position.set(x, y - game.cfg.eye, z);
      // a figure's front is its local -Z, which is also where a player yaw of
      // 0 looks: no half turn, or everyone runs about with the pack in front
      r.fig.root.rotation.y = lerpAngle(pa[4], pb[4], pair.f);
      PB.poseFigure(r.fig, {
        phase: r.phase,
        grounded: !!pb[6],
        moving: !!pb[5],
        vy: pb[7],
      });
      r.fig.root.updateMatrixWorld(true);
    }

    remotes.forEach(function (r, id) { if (!seen.has(id)) dropRemote(id); });

    applyEntities(pair);

    // the sliders and the perks on the ground both come from the server
    if (pair.b.wt !== undefined) {
      var wtA = pair.a.wt === undefined ? pair.b.wt : pair.a.wt;
      game.setWorldTime(lerp(wtA, pair.b.wt, pair.f));
    }
    if (pair.b.perks) game.perkSystem.applyList(pair.b.perks);
  }

  function findPlayer(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i];
    return null;
  }

  // NPCs and targets belong to the server; the local copies just follow.
  function applyEntities(pair) {
    var npcs = game.npcs;
    for (var i = 0; i < npcs.length && i < pair.b.npcs.length; i++) {
      var na = pair.a.npcs[i] || pair.b.npcs[i];
      var nb = pair.b.npcs[i];
      var n = npcs[i];
      var nx = lerp(na[0], nb[0], pair.f);
      var ny = lerp(na[1], nb[1], pair.f);
      var nz = lerp(na[2], nb[2], pair.f);
      n.root.position.set(nx, ny, nz);
      n.root.rotation.y = lerpAngle(na[3], nb[3], pair.f);
      n.alive = !!nb[4];
      n.grounded = !!nb[5];
      n.vy = nb[6];
      if (n.fig) {
        // Step the run cycle by what actually moved this frame. Using the gap
        // between the two snapshots instead advanced a whole snapshot's worth
        // of stride every frame, which ran the legs at about three times speed.
        var stepped = n.netLast
          ? Math.hypot(nx - n.netLast.x, nz - n.netLast.z)
          : 0;
        n.netLast = { x: nx, z: nz };
        n.netPhase = (n.netPhase || 0) + stepped * PHASE_PER_UNIT;
        PB.poseFigure(n.fig, {
          phase: n.netPhase, grounded: n.grounded, moving: stepped > 0.0008, vy: n.vy,
        });
      }
      if (nb.length > 7) n.root.rotation.x = nb[7];      // toppled when downed
      n.root.updateMatrixWorld(true);
    }

    var targets = game.targets;
    for (var j = 0; j < targets.length && j < pair.b.targets.length; j++) {
      var ta = pair.a.targets[j] || pair.b.targets[j];
      var tb = pair.b.targets[j];
      var t = targets[j];
      t.mesh.position.set(
        lerp(ta[0], tb[0], pair.f),
        lerp(ta[1], tb[1], pair.f),
        lerp(ta[2], tb[2], pair.f)
      );
      /* The server is the authority in both directions: break what it says is
       * gone, and put back anything this client broke that the server still
       * has standing. Only handling the first direction meant one wrong break
       * stranded a target — invisible here, alive there, and the level could
       * never be completed. */
      if (!tb[3] && t.alive) {
        // somebody else shot it: play the break rather than blinking it out
        game.breakTarget(t, new THREE.Vector3(0, 1, 0));
      } else if (tb[3] && !t.alive) {
        game.reviveTarget(t);
      }
      t.mesh.updateMatrixWorld(true);
    }
  }

  var api = {
    connect: connect,
    on: on,
    self: self,
    stats: stats,
    remotes: remotes,
    snapshots: snapshots,
    attach: startSending,
    update: update,
    bracket: bracket,
    ping: function () { send({ t: 'ping', c: now() }); },
    close: function () { stopSending(); if (socket) socket.close(); },
    remoteCount: function () { return remotes.size; },
    names: names,
    setName: function (v) {
      name = (v || 'player').toString().slice(0, 16);
      // a name set before joining travels with the join; afterwards it is the
      // label everyone else already has, so it only applies next time
      return name;
    },
    getName: function () { return name; },
    setShowNames: function (on) {
      showNames = !!on;
      remotes.forEach(function (r) { if (r.tag) r.tag.sprite.visible = showNames; });
      return showNames;
    },
  };
  return api;
};

})(typeof window !== 'undefined' ? window : globalThis);
