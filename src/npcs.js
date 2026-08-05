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

  /* Which of a level's NPCs is the hunter.
   *
   * Index 0, every level, on both sides of the wire. The client rebuilds a
   * level from a count rather than from a list, so the rule for which one comes
   * back red has to be something both sides can work out from the index alone —
   * anything else and the server's hunter is a wanderer on your screen. */
  function isHunterIndex(i) {
    return cfg.hunters > 0 && i < cfg.hunters;
  }

  function makeNPC(i) {
    var hunter = isHunterIndex(i);
    /* Red, and only ever red. NPCs stay in the warm half of the wheel and the
     * cool band is reserved for players, so the two can never end up the same
     * colour; the hunter is pulled out of that scheme entirely and given the
     * one hue nothing else may use, plus a player's kit so it reads as
     * something that shoots back rather than more scenery. */
    var hue = hunter ? 0 : (0.06 + (i * 0.19) % 1 * 0.28);
    var fig = PB.buildFigure({
      geo: npcGeo, shadows: cfg.shadows, name: hunter ? 'hunter' : 'npc',
      variant: hunter ? 'player' : undefined,
      color: new THREE.Color().setHSL(hue, hunter ? 0.85 : 0.45, hunter ? 0.46 : 0.52),
      trim: new THREE.Color().setHSL(hue, hunter ? 0.8 : 0.55, hunter ? 0.24 : 0.34),
      accent: hunter ? 0xff3b30 : undefined,
    });
    scene.add(fig.root);

    var npc = {
      root: fig.root, torso: fig.torso, head: fig.head,
      armL: fig.armL, armR: fig.armR, legL: fig.legL, legR: fig.legR,
      fig: fig, hitbox: fig.hitbox, alive: true, downFor: 0,
      phase: rand() * 6.28, speed: hunter ? cfg.hunterSpeed : 3.4 + rand() * 1.8,
      heading: rand() * 6.28, vy: 0, y: 0, grounded: true,
      think: rand(), jumpIn: 2 + rand() * 5,

      /* A hunter carries what it believes rather than what is true; see
       * huntThink. `quarry` is who it has decided to kill, `mark` is the last
       * place it actually saw them and which way they were going, and `sawAt`
       * is when — everything else is worked out from those. */
      hunter: hunter,
      quarry: null, mark: null, sawAt: -1e9, sightSince: 0,
      nextShot: 0, hold: false, veer: rand() < 0.5 ? -1 : 1,
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

  /* ------------------------------------------------------------- hunters */
  /* The red one. It comes looking for you and shoots, and it is deliberately
   * not a machine about it.
   *
   * What it knows is a memory, not a feed: it only learns where somebody is
   * while it can actually see them, and once they break line of sight it works
   * from where they were and which way they were going. That memory ages out.
   * Its aim is a cone rather than a line and it does not lead a moving target,
   * so being shot at is a reason to move rather than a death sentence.
   *
   * Whose it is comes from ctx.hunterTargets, because the answer is different
   * on each side: offline the only target is the player at the camera, and on
   * the server it is the room's list of live players. The engine has no idea
   * which it is looking at, and does not need one. */
  var HUNTER_EYE = 1.55;        // shoots from the head, near enough
  var HUNTER_CHEST = 1.15;      // and aims at the middle of a body
  var HUNTER_TURN = 4.5;        // radians a second — it cannot spin on the spot
  var HUNTER_SWITCH = 0.72;     // how much easier a new target has to look

  var _seeFrom = new THREE.Vector3();
  var _seeTo = new THREE.Vector3();
  var _seeDir = new THREE.Vector3();

  function eyeOf(npc, out) {
    return out.set(npc.root.position.x,
                   npc.root.position.y + HUNTER_EYE,
                   npc.root.position.z);
  }

  /* Targets arrive at eye height, the way both a player's own position and the
   * server's copy of one are kept. The body hangs below that. */
  function chestOf(t, out) {
    return out.set(t.x, t.y - cfg.eye + HUNTER_CHEST, t.z);
  }

  function canSee(npc, t) {
    eyeOf(npc, _seeFrom);
    chestOf(t, _seeTo);
    _seeDir.copy(_seeTo).sub(_seeFrom);
    var dist = _seeDir.length();
    if (dist < 0.001 || dist > cfg.hunterSight) return false;
    _seeDir.divideScalar(dist);

    // no eyes in the back of its head
    var flat = Math.hypot(_seeDir.x, _seeDir.z) || 1;
    var facing = (_seeDir.x / flat) * Math.sin(npc.heading) +
                 (_seeDir.z / flat) * Math.cos(npc.heading);
    if (facing < Math.cos(cfg.hunterFov)) return false;

    npcRay.set(_seeFrom, _seeDir);
    npcRay.far = dist - 0.25;              // stop short of the body itself
    var hits = npcRay.intersectObjects(solidMeshes, false);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].object !== floor && hits[i].object !== npc.hitbox) return false;
    }
    return true;
  }

  /* How easy somebody looks to finish, lower being easier: how far away they
   * are, plus what is left of them. A hurt player across the room can be worth
   * turning to before a healthy one nearby. */
  function easeOf(npc, t) {
    var d = Math.hypot(t.x - npc.root.position.x, t.z - npc.root.position.z);
    var health = typeof t.health === 'number' ? t.health : cfg.playerHealth;
    return d + health * 2.5;
  }

  function huntTargets() {
    var list = ctx.hunterTargets ? ctx.hunterTargets() : null;
    return list && list.length ? list : null;
  }

  /* Everything it can see, and which one it has settled on.
   *
   * Having seen somebody it stays on them: swapping to whoever is nearest each
   * time one of them steps behind a crate makes it fight nobody. A new target
   * has to look clearly easier — HUNTER_SWITCH of the current one — before it
   * is worth turning away from the one already being worn down. */
  function pickQuarry(npc) {
    var list = huntTargets();
    if (!list) return null;
    var chosen = null, chosenEase = Infinity;
    var held = null, heldEase = Infinity;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!canSee(npc, t)) continue;
      var ease = easeOf(npc, t);
      if (npc.quarry !== null && t.id === npc.quarry) { held = t; heldEase = ease; }
      if (ease < chosenEase) { chosen = t; chosenEase = ease; }
    }
    if (held && (!chosen || chosenEase > heldEase * HUNTER_SWITCH)) return held;
    return chosen;
  }

  /* Where it will act as though they are. Straight from the sighting while it
   * has one; after that, on along their last known heading for a couple of
   * seconds, and then simply the spot it last saw them — which is a guess, and
   * is meant to be. */
  function guessAt(npc, out) {
    if (!npc.mark) return null;
    var age = state.elapsed - npc.sawAt;
    if (age > cfg.hunterMemory) return null;
    var lead = Math.min(age, cfg.hunterGuess);
    var lim = half - 2;
    out.x = Math.max(-lim, Math.min(lim, npc.mark.x + npc.mark.vx * lead));
    out.z = Math.max(-lim, Math.min(lim, npc.mark.z + npc.mark.vz * lead));
    return out;
  }

  // Ease the heading round rather than snapping it: a figure that pivots
  // instantly reads as a turret, and it is the shoulders the player sees.
  function turnTowards(npc, x, z, dt) {
    var want = Math.atan2(x - npc.root.position.x, z - npc.root.position.z);
    var diff = want - npc.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    var most = HUNTER_TURN * dt;
    npc.heading += Math.max(-most, Math.min(most, diff));
    return Math.abs(diff);
  }

  var _shotFrom = new THREE.Vector3();
  var _shotAt = new THREE.Vector3();
  var _shotDir = new THREE.Vector3();
  var _shotSide = new THREE.Vector3();
  var UP = new THREE.Vector3(0, 1, 0);

  /* Average aim: a cone around the middle of the body, and no allowance at all
   * for a target that is moving. Two samples rather than one so the error piles
   * up around the middle instead of being flat across the cone — most rounds
   * are close, a few are wild, which is what shooting badly looks like. */
  function aimError() {
    return (rand() + rand() - 1) * cfg.hunterSpread;
  }

  function fireAt(npc, t) {
    eyeOf(npc, _shotFrom);
    chestOf(t, _shotAt);
    _shotDir.copy(_shotAt).sub(_shotFrom);
    if (_shotDir.lengthSq() < 1e-6) return null;
    _shotDir.normalize();

    // spread it off the line: sideways around up, then up and down around the
    // axis that came out of the first turn
    _shotDir.applyAxisAngle(UP, aimError());
    _shotSide.copy(_shotDir).cross(UP);
    if (_shotSide.lengthSq() > 1e-6) {
      _shotDir.applyAxisAngle(_shotSide.normalize(), aimError());
    }

    /* Where the round stops on the world. Players are not in the world the
     * engine raycasts — offline the player is the camera, and on the server
     * they belong to the room — so whoever is listening tests them against
     * this reach and decides what was hit. */
    var blocked = ctx.traceShot(_shotFrom, _shotDir);
    var shot = {
      npc: npc,
      index: npcs.indexOf(npc),
      origin: { x: _shotFrom.x, y: _shotFrom.y, z: _shotFrom.z },
      dir: { x: _shotDir.x, y: _shotDir.y, z: _shotDir.z },
      point: { x: blocked.point.x, y: blocked.point.y, z: blocked.point.z },
      distance: blocked.distance === undefined ? 300 : blocked.distance,
      at: t.id === undefined ? null : t.id,
    };
    emit('npcShot', shot);
    return shot;
  }

  var _goal = { x: 0, z: 0 };

  function huntThink(npc, dt) {
    var now = state.elapsed;
    var seen = pickQuarry(npc);

    if (seen) {
      npc.quarry = seen.id === undefined ? null : seen.id;
      if (!npc.sightSince) npc.sightSince = now;
      /* Keep a running idea of which way they are going, eased rather than
       * taken frame by frame: a single frame of a strafing player is mostly
       * noise, and the guess is only worth making from the trend. */
      if (npc.mark) {
        var gap = now - npc.mark.t;
        if (gap > 0.001) {
          var vx = (seen.x - npc.mark.x) / gap;
          var vz = (seen.z - npc.mark.z) / gap;
          var k = Math.min(1, gap * 3);
          var cap = cfg.sprint;
          npc.mark.vx += (Math.max(-cap, Math.min(cap, vx)) - npc.mark.vx) * k;
          npc.mark.vz += (Math.max(-cap, Math.min(cap, vz)) - npc.mark.vz) * k;
          npc.mark.x = seen.x;
          npc.mark.z = seen.z;
          npc.mark.t = now;
        }
      } else {
        npc.mark = { x: seen.x, z: seen.z, vx: 0, vz: 0, t: now };
      }
      npc.sawAt = now;
    } else {
      npc.sightSince = 0;
    }

    var goal = guessAt(npc, _goal);
    if (!goal) {
      // nothing left worth chasing: forget them and go back to patrolling
      npc.quarry = null;
      npc.mark = null;
      npc.hold = false;
      wanderThink(npc, dt);
      return;
    }

    var range = Math.hypot(goal.x - npc.root.position.x, goal.z - npc.root.position.z);
    turnTowards(npc, goal.x, goal.z, dt);

    /* Close the distance, but not all of it — a hunter that walks into the
     * player's face is one you cannot help but shoot. It stops short of where
     * it believes they are whether or not it can see them at that moment:
     * judging this on sight alone had it strolling to arm's length any time
     * cover broke the line on the way in. Standing off the spot it last saw
     * them, watching it, is the better answer to not knowing. */
    npc.hold = range < cfg.hunterRange;

    if (!npc.hold) {
      // cover in the way is walked around rather than turned away from: it has
      // somewhere to be, and each hunter has a side it prefers
      var blocked = npcBlocked(npc, 2.2);
      if (blocked) {
        if (npc.grounded && blocked.point.y < 1.4 && rand() < 0.35) {
          npc.vy = 7.4;
          npc.grounded = false;
        } else {
          npc.heading += npc.veer * (0.5 + rand() * 0.5);
        }
      }
    }

    if (seen && now >= npc.sightSince + cfg.hunterReaction && now >= npc.nextShot) {
      npc.nextShot = now + cfg.hunterFireEvery * (0.8 + rand() * 0.4);
      fireAt(npc, seen);
    }
  }

  // steering: pick a new heading when blocked, and now and then anyway
  function wanderThink(npc, dt) {
    npc.think -= dt;
    if (npc.think > 0) return;
    npc.think = 0.25 + rand() * 0.25;
    var hit = npcBlocked(npc, 2.6);
    if (hit) {
      // hop low cover, otherwise turn away
      if (npc.grounded && hit.object !== null && hit.point.y < 1.4 && rand() < 0.5) {
        npc.vy = 7.4;
        npc.grounded = false;
      } else {
        npc.heading += (rand() < 0.5 ? -1 : 1) * (1.1 + rand() * 1.4);
      }
    } else if (rand() < 0.06) {
      npc.heading += (rand() - 0.5) * 0.9;
    }
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

      if (n.hunter) huntThink(n, dt);
      else wanderThink(n, dt);

      // wanderers hop about for the look of it; a hunter only leaves the
      // ground to get over something in its way
      if (!n.hunter) {
        n.jumpIn -= dt;
        if (n.jumpIn <= 0 && n.grounded) {
          n.jumpIn = 3 + rand() * 5;
          n.vy = 7.0;
          n.grounded = false;
        }
      }

      // move — a hunter standing its ground to shoot covers no distance
      var step = (n.hold ? 0 : n.speed) * dt;
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
      PB.faceHeading(n.root, n.heading);

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
