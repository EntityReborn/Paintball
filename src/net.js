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

PB.createNet = function (opts) {
  var THREE = global.THREE;
  var url = opts.url;
  var name = opts.name || 'player';

  var socket = null;
  var self = { id: null, seed: null, connected: false, error: null };
  var listeners = {};
  var snapshots = [];           // {at, players, npcs, targets}
  var remotes = new Map();      // id -> {fig, phase, name, last}
  var game = null;
  var sendTimer = null;
  var figureGeo = null;
  var stats = { sent: 0, received: 0, corrections: 0, lastLatency: 0 };

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
      emit('hello', msg);
      return;
    }
    if (msg.t === 'snapshot') {
      stats.received++;
      snapshots.push({ at: now(), players: msg.players, npcs: msg.npcs, targets: msg.targets });
      var cutoff = now() - BUFFER_MS;
      while (snapshots.length > 2 && snapshots[0].at < cutoff) snapshots.shift();
      return;
    }
    if (msg.t === 'joined') { emit('joined', msg.player); return; }
    if (msg.t === 'left') {
      dropRemote(msg.id);
      emit('left', msg);
      return;
    }
    if (msg.t === 'correction') {
      stats.corrections++;
      if (game) game.teleport(msg.x, msg.y, msg.z);
      emit('correction', msg);
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
    sendTimer = null;
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
    var hue = (id * 0.37 + 0.55) % 1;
    var fig = PB.buildFigure({
      geo: figureGeo, shadows: !!game.cfg.shadows, name: 'remote',
      color: new THREE.Color().setHSL(hue, 0.6, 0.55),
      trim: new THREE.Color().setHSL(hue, 0.7, 0.36),
    });
    game.scene.add(fig.root);
    r = { fig: fig, phase: 0, last: null };
    remotes.set(id, r);
    return r;
  }

  function dropRemote(id) {
    var r = remotes.get(id);
    if (!r) return;
    game.scene.remove(r.fig.root);
    r.fig.materials.forEach(function (m) { m.dispose(); });
    remotes.delete(id);
  }

  /* Called every frame by the client: pose everyone else from the snapshot
   * buffer, and drop the local player's own entry (we draw ourselves through
   * the camera). */
  function update(dt) {
    if (!game || snapshots.length === 0) return;
    var pair = bracket(now() - INTERP_MS);
    if (!pair) return;

    var seen = new Set();
    for (var i = 0; i < pair.b.players.length; i++) {
      var pb = pair.b.players[i];
      var id = pb[0];
      if (id === self.id) continue;
      seen.add(id);

      var pa = findPlayer(pair.a.players, id) || pb;
      var r = remoteFor(id);
      var x = lerp(pa[1], pb[1], pair.f);
      var y = lerp(pa[2], pb[2], pair.f);
      var z = lerp(pa[3], pb[3], pair.f);

      if (r.last) {
        var moved = Math.hypot(x - r.last.x, z - r.last.z);
        r.phase += moved * 2.4;              // legs keep step with the ground
      }
      r.last = { x: x, y: y, z: z };

      r.fig.root.position.set(x, y - game.cfg.eye, z);
      r.fig.root.rotation.y = lerpAngle(pa[4], pb[4], pair.f) + Math.PI;
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
      n.root.position.set(
        lerp(na[0], nb[0], pair.f),
        lerp(na[1], nb[1], pair.f),
        lerp(na[2], nb[2], pair.f)
      );
      n.root.rotation.y = lerpAngle(na[3], nb[3], pair.f);
      n.alive = !!nb[4];
      n.grounded = !!nb[5];
      n.vy = nb[6];
      if (n.fig) {
        var stepped = Math.hypot(nb[0] - na[0], nb[2] - na[2]);
        n.netPhase = (n.netPhase || 0) + stepped * 2.4;
        PB.poseFigure(n.fig, {
          phase: n.netPhase, grounded: n.grounded, moving: stepped > 0.0005, vy: n.vy,
        });
      }
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
      if (!tb[3] && t.alive) { t.alive = false; t.mesh.visible = false; }
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
  };
  return api;
};

})(typeof window !== 'undefined' ? window : globalThis);
