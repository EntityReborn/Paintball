/* Low-poly figures: build, wander, run and jump animation, knockdown.
 *
 * Part of the Paintball engine. Classic script, no modules: the game has to
 * run straight off the filesystem, where Chrome refuses to load ES modules.
 * Every builder takes the shared context created by createGame and returns
 * the handful of things the rest of the engine needs.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createNPCs = function (ctx) {
  var PB = global.PB;
  var THREE = global.THREE;
  var cfg = ctx.cfg, rand = ctx.rand, half = ctx.half, scene = ctx.scene;
  var state = ctx.state, emit = ctx.emit;
  var solidMeshes = ctx.solidMeshes, obstacleBoxes = ctx.obstacleBoxes, floor = ctx.floor;
  var addScore = ctx.addScore, checkLevel = function () { return ctx.checkLevel(); };
  var _v = new THREE.Vector3();

  /* --------------------------------------------------------------- NPCs */
  /* Low-poly figures built from boxes with limbs on pivots, animated
   * procedurally: a run cycle driven by a phase, and a tuck while airborne.
   * They wander the arena, hop obstacles, and can be shot for points. */
  var npcs = [];
  var NPC_HEIGHT = 1.8;
  var npcGeo = PB.figureGeometry();
  var NPC_HEIGHT = PB.FIGURE_HEIGHT;

  function makeNPC(i) {
    var hue = (i * 0.27 + 0.08) % 1;
    var fig = PB.buildFigure({
      geo: npcGeo, shadows: cfg.shadows, name: 'npc',
      color: new THREE.Color().setHSL(hue, 0.45, 0.52),
      trim: new THREE.Color().setHSL(hue, 0.55, 0.34),
    });
    scene.add(fig.root);

    var npc = {
      root: fig.root, torso: fig.torso, head: fig.head,
      armL: fig.armL, armR: fig.armR, legL: fig.legL, legR: fig.legR,
      fig: fig, hitbox: fig.hitbox, alive: true, downFor: 0,
      phase: rand() * 6.28, speed: 3.4 + rand() * 1.8,
      heading: rand() * 6.28, vy: 0, y: 0, grounded: true,
      think: rand(), jumpIn: 2 + rand() * 5,
    };
    fig.hitbox.userData.npc = npc;
    solidMeshes.push(fig.hitbox);
    placeNPC(npc);
    fig.root.updateMatrixWorld(true);
    return npc;
  }

  function placeNPC(npc) {
    var lim = half - 3;
    for (var tries = 0; tries < 60; tries++) {
      var x = (rand() - 0.5) * 2 * lim;
      var z = (rand() - 0.5) * 2 * lim;
      if (Math.hypot(x, z) < 6) continue;                     // not on the player
      _v.set(x, 0.9, z);
      var clear = obstacleBoxes.every(function (b) { return b.distanceToPoint(_v) > 1.2; });
      if (!clear) continue;
      npc.root.position.set(x, 0, z);
      npc.y = 0;
      npc.vy = 0;
      npc.grounded = true;
      npc.heading = rand() * 6.28;
      npc.root.updateMatrixWorld(true);
      return true;
    }
    npc.root.position.set(0, 0, -lim + 2);
    return false;
  }

  var _npcAhead = new THREE.Vector3();
  var _npcDir = new THREE.Vector3();
  var npcRay = new THREE.Raycaster();

  function npcBlocked(npc, distance) {
    _npcDir.set(Math.sin(npc.heading), 0, Math.cos(npc.heading));
    _npcAhead.copy(npc.root.position);
    _npcAhead.y = 0.9;
    npcRay.set(_npcAhead, _npcDir);
    npcRay.far = distance;
    var hits = npcRay.intersectObjects(solidMeshes, false);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].object !== floor && hits[i].object !== npc.hitbox) return hits[i];
    }
    return null;
  }

  function npcsAlive() {
    var n = 0;
    for (var i = 0; i < npcs.length; i++) if (npcs[i].alive) n++;
    return n;
  }

  // NPCs stay down: they are the level objective, not respawning scenery.
  function knockDownNPC(npc) {
    if (!npc.alive) return 0;
    npc.alive = false;
    npc.downFor = 0;
    npc.vy = 3.0;

    // a body is no longer a bullet stop
    var idx = solidMeshes.indexOf(npc.hitbox);
    if (idx !== -1) solidMeshes.splice(idx, 1);

    var where = npc.root.position.clone();
    where.y = 1.3;
    var gained = addScore(cfg.scoreNpc, where);
    emit('npcDown', { npc: npc, score: state.score, left: npcsAlive() });
    checkLevel();
    return gained;
  }

  function updateNPCs(dt) {
    for (var i = 0; i < npcs.length; i++) {
      var n = npcs[i];
      var p = n.root.position;

      if (!n.alive) {
        // topple over and stay down for the rest of the level
        n.downFor += dt;
        n.vy -= cfg.gravity * dt;
        n.y = Math.max(0, n.y + n.vy * dt);
        p.y = n.y;
        n.root.rotation.x = Math.min(Math.PI / 2, n.root.rotation.x + dt * 4.5);
        n.torso.rotation.x = 0;
        n.root.updateMatrixWorld(true);
        continue;
      }

      // steering: pick a new heading when blocked, and now and then anyway
      n.think -= dt;
      if (n.think <= 0) {
        n.think = 0.25 + rand() * 0.25;
        var hit = npcBlocked(n, 2.6);
        if (hit) {
          // hop low cover, otherwise turn away
          if (n.grounded && hit.object !== null && hit.point.y < 1.4 && rand() < 0.5) {
            n.vy = 7.4;
            n.grounded = false;
          } else {
            n.heading += (rand() < 0.5 ? -1 : 1) * (1.1 + rand() * 1.4);
          }
        } else if (rand() < 0.06) {
          n.heading += (rand() - 0.5) * 0.9;
        }
      }

      n.jumpIn -= dt;
      if (n.jumpIn <= 0 && n.grounded) {
        n.jumpIn = 3 + rand() * 5;
        n.vy = 7.0;
        n.grounded = false;
      }

      // move
      var step = n.speed * dt;
      p.x += Math.sin(n.heading) * step;
      p.z += Math.cos(n.heading) * step;

      var lim = half - 1.6;
      if (p.x < -lim || p.x > lim || p.z < -lim || p.z > lim) {
        p.x = Math.max(-lim, Math.min(lim, p.x));
        p.z = Math.max(-lim, Math.min(lim, p.z));
        n.heading += Math.PI * (0.6 + rand() * 0.8);
      }

      // gravity
      if (!n.grounded || n.vy !== 0) {
        n.vy -= cfg.gravity * dt;
        n.y += n.vy * dt;
        if (n.y <= 0) { n.y = 0; n.vy = 0; n.grounded = true; }
      }
      p.y = n.y;
      n.root.rotation.y = n.heading;

      // keep the world matrix current: bullets raycast against the hitbox, and
      // three.js would otherwise only refresh it at render time, so shots would
      // register against where the figure was on the previous frame
      n.root.updateMatrixWorld(true);

      /* animation */
      if (n.grounded) n.phase += dt * n.speed * 2.4;
      PB.poseFigure(n.fig, { phase: n.phase, grounded: n.grounded, vy: n.vy });
    }
  }

  return {
    npcs: npcs, makeNPC: makeNPC, placeNPC: placeNPC,
    npcsAlive: npcsAlive, knockDownNPC: knockDownNPC, updateNPCs: updateNPCs,
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
