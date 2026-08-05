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

var SEND_HZ = 60;             // our own position, upstream

/* How far behind the newest snapshot everyone else is drawn.
 *
 * This has to cover the gap between snapshots plus however unevenly they turn
 * up, or the buffer runs dry and a remote player freezes until the next one
 * lands. It used to be a flat 110ms, picked for the worst case and paid for by
 * everybody all the time. Now it is measured: the floor is one snapshot
 * interval, and the rest is whatever jitter the connection is actually
 * showing. On a quiet local network that settles near the floor. */
var MIN_DELAY_MS = 45;
var MAX_DELAY_MS = 180;
var JITTER_MARGIN = 2.5;      // multiples of measured jitter to keep in hand

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

  var pvp = opts.pvp !== false;

  var socket = null;
  var self = { id: null, seed: null, connected: false, error: null, arenaMatch: null };
  var listeners = {};
  var snapshots = [];           // {at, players, npcs, targets}
  var remotes = new Map();      // id -> {fig, phase, name, last}
  var departed = new Set();     // ids that have left, so a stale snapshot cannot revive them
  var names = new Map();        // id -> display name, for the tags over their heads
  var scores = [];              // the room's scoreboard, newest the server sent
  var showNames = true;
  var maxHealth = 10;
  var lastArrival = 0;          // when the last snapshot turned up
  var arrivalGap = 33;          // and how far apart they have been coming
  var arrivalJitter = 6;        // and how much that wanders
  var renderClock = null;       // the time we draw everyone else at
  var game = null;
  var sendTimer = null;
  var statsTimer = null;
  var lastUpdateAt = 0;
  var figureGeo = null;
  var stats = { sent: 0, received: 0, corrections: 0, lastCorrection: null,
                lastLatency: 0, transit: 0, frames: 0,
                hits: 0, shots: 0, rejected: 0, lastRejection: null };

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
      send({ t: 'join', name: name, pvp: pvp });
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

  function sendPrefs() {
    if (!self.id) return false;         // it will travel with the join instead
    return send({ t: 'prefs', name: name, pvp: pvp });
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
      /* How long the snapshot took to reach us and be picked up. The server
       * stamps it with Date.now(); on one machine that is directly
       * comparable, and across machines the clock offset is constant so the
       * variation is still meaningful. Worth watching: a client that is busy
       * drawing takes its own sweet time getting round to the socket, and
       * that shows up here rather than in any of the rates. */
      if (typeof msg.time === 'number') {
        var transit = Date.now() - msg.time;
        stats.transit = stats.transit
          ? stats.transit + (transit - stats.transit) * 0.1
          : transit;
      }
      noteArrival(msg.at);
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
    /* Somebody renamed themselves, or stepped in or out of the fight. Redraw
     * the tag over their head there and then rather than waiting for them to
     * leave and come back. */
    if (msg.t === 'prefs') {
      names.set(msg.id, msg.name);
      var who = remotes.get(msg.id);
      if (who) {
        if (who.tag) who.tag.set(msg.name);
        setRemotePvp(who, msg.pvp !== false);
      }
      emit('prefs', msg);
      return;
    }
    if (msg.t === 'medkit') {
      if (game) {
        if (msg.by === self.id) game.setHealth(msg.health, maxHealth);
        game.sfx.wave();
      }
      emit('medkit', { index: msg.index, by: msg.by, mine: msg.by === self.id });
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
        game.setShield(game.cfg.spawnShield);
      }
      emit('respawn', msg);
      return;
    }
    /* The room's own table of who is doing what to whom. Kept whole rather
     * than merged into what we already know: the server sorted it, and every
     * client showing the same order matters more than saving the copy. */
    if (msg.t === 'scores') {
      scores = msg.players || [];
      (msg.players || []).forEach(function (row) { names.set(row[0], row[1]); });
      emit('scores', msg);
      return;
    }
    if (msg.t === 'chat') {
      emit('chat', msg);
      return;
    }
    if (msg.t === 'chatRejected') {
      emit('chatRejected', msg);
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

    /* Every shot goes to the server for adjudication, carrying what we saw it
     * hit and how far behind the server our view was when we aimed. The server
     * puts that one entity back where it was that long ago and checks it,
     * rather than searching the whole window for something to credit — which
     * used to hand out kills for rounds that landed in a running figure's
     * wake. A shot that hit nothing carries no claim and is simply a miss. */
    game.on('shotFired', function (d) {
      stats.shots++;
      /* However far behind we were actually drawing when we aimed — the
       * measured delay, not a constant. Now that it moves with the connection,
       * quoting a fixed number here would ask the server to rewind to a moment
       * we were not looking at. */
      var behind = targetDelay() + Math.min(400, now() - lastUpdateAt);
      stats.lastLag = Math.round(behind);
      send({
        t: 'shot', origin: d.origin, dir: d.dir,
        lag: Math.round(behind), claim: d.claim || null,
      });
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
  /* Everyone else is drawn at a time of our own keeping, a little way behind
   * the newest snapshot we hold. Two things are measured to decide how far:
   * how often snapshots arrive, and how unevenly. */
  function noteArrival(at) {
    if (lastArrival) {
      var gap = at - lastArrival;
      if (gap > 0 && gap < 1000) {
        // exponential averages: recent behaviour matters, old behaviour fades
        arrivalGap += (gap - arrivalGap) * 0.12;
        arrivalJitter += (Math.abs(gap - arrivalGap) - arrivalJitter) * 0.12;
      }
    }
    lastArrival = at;
  }

  function targetDelay() {
    var want = arrivalGap + arrivalJitter * JITTER_MARGIN;
    return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, want));
  }

  /* The clock we draw other people at. It runs at wall speed and is steered
   * gently towards where it ought to be, rather than being recomputed from the
   * newest arrival every frame: doing that hands every hitch in the network,
   * and every late packet, straight to the viewer as a stutter. */
  function advanceClock(dt) {
    var newest = snapshots[snapshots.length - 1].at;
    var want = newest - targetDelay();
    if (renderClock === null || Math.abs(want - renderClock) > 500) {
      renderClock = want;                 // first snapshot, or a real stall
      return renderClock;
    }
    renderClock += dt * 1000;
    // ease out any difference rather than snapping to it
    renderClock += (want - renderClock) * 0.1;
    // never draw ahead of what we hold, and never fall so far behind that the
    // buffer we are reading from has already been thrown away
    if (renderClock > newest) renderClock = newest;
    var oldest = snapshots[0].at;
    if (renderClock < oldest) renderClock = oldest;
    return renderClock;
  }

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

    // always build the tag: a rename can arrive before we ever hear a name
    r.tag = PB.createNameTag(names.get(id) || '', '#' + accent.getHexString());
    r.tag.sprite.visible = showNames;
    fig.root.add(r.tag.sprite);
    r.health = PB.createHealthBar();
    fig.root.add(r.health.sprite);
    r.pvp = true;

    /* Rounds are raycast against this box as well as drawn from it, so it has
     * to carry enough to name who was hit and to say whether they are in the
     * fight at all. Flat values rather than a link back to the remote: the box
     * hangs off the figure the remote owns, and pointing the two at each other
     * makes a cycle for anything that walks the scene graph to fall into. */
    if (fig.hitbox && game.debugHitboxes) {
      fig.hitbox.userData.remoteId = id;
      fig.hitbox.userData.pvp = true;
      game.debugHitboxes.push(fig.hitbox);
    }
    remotes.set(id, r);
    return r;
  }

  /* Somebody out of the fight is drawn see-through, so it is obvious at a
   * glance that shooting them is a waste of a round. */
  function setRemotePvp(r, on) {
    if (!r || r.pvp === on) return;
    r.pvp = on;
    // the raycast reads this off the box itself, not off the remote
    if (r.fig.hitbox) r.fig.hitbox.userData.pvp = on;
    r.fig.materials.forEach(function (m) {
      if (m.name === 'shieldMat') return;
      m.transparent = !on;
      m.opacity = on ? 1 : 0.34;
      m.needsUpdate = true;
    });
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
    var at = now();
    /* Advance the playback clock by the time that actually passed, not by the
     * frame delta handed in. The game clamps that to 50ms so a hitch cannot
     * fling the player through a wall, which is right for physics and wrong
     * for this: on a client drawing every 120ms the clock gained 50ms a frame,
     * fell behind real time by more than half, and then hit the half-second
     * resynchronisation below and snapped. On screen that is the other player
     * frozen for a third of a second and then jumping several metres — the
     * exact stutter the interpolation exists to prevent, on exactly the
     * machines that can least afford it. */
    var real = lastUpdateAt ? Math.min(500, at - lastUpdateAt) : dt * 1000;
    lastUpdateAt = at;
    var pair = bracket(advanceClock(real / 1000));
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
      if (r.fig.shield) r.fig.shield.visible = !down && pb.length > 11 && !!pb[11];
      if (pb.length > 12) setRemotePvp(r, !!pb[12]);
      // cheap when nothing changed, and it covers a name that arrived after
      // the body did
      if (r.tag) r.tag.set(names.get(id) || '');

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
    if (pair.b.kits) game.applyMedkits(pair.b.kits);
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
    /* Say something to the room. Nothing goes on our own screen here — it
     * comes back from the server like everybody else's, so what we see is
     * what was actually said rather than what we hoped to say. */
    say: function (text) {
      var said = String(text === undefined || text === null ? '' : text).trim();
      if (!said) return false;
      return send({ t: 'chat', text: said.slice(0, 200) });
    },
    // what the interpolation is currently costing, for the HUD and the tests
    delay: function () {
      return { target: targetDelay(), gap: arrivalGap, jitter: arrivalJitter };
    },
    close: function () { stopSending(); if (socket) socket.close(); },
    remoteCount: function () { return remotes.size; },
    names: names,
    // rows of [id, name, score, kills, deaths, waitingToRespawn]
    scores: function () { return scores.slice(); },
    setName: function (v) {
      name = (v || 'player').toString().slice(0, 16);
      // before joining this travels with the join; afterwards it goes out on
      // its own, so the tag over our head changes on everyone's screen at once
      sendPrefs();
      return name;
    },
    getName: function () { return name; },
    setPvp: function (v) {
      pvp = v !== false;
      sendPrefs();
      return pvp;
    },
    getPvp: function () { return pvp; },
    setShowNames: function (on) {
      showNames = !!on;
      remotes.forEach(function (r) { if (r.tag) r.tag.sprite.visible = showNames; });
      return showNames;
    },
  };
  return api;
};

})(typeof window !== 'undefined' ? window : globalThis);
