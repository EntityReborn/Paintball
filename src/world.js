/* Arena: floor, perimeter walls and scattered cover.
 *
 * Part of the Paintball engine. Classic script, no modules: the game has to
 * run straight off the filesystem, where Chrome refuses to load ES modules.
 * Every builder takes the shared context created by createGame and returns
 * the handful of things the rest of the engine needs.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createWorld = function (ctx) {
  var THREE = global.THREE;
  var cfg = ctx.cfg, rand = ctx.rand, half = ctx.half, scene = ctx.scene;
  var emit = ctx.emit, state = ctx.state;

  /* -------------------------------------------------------------- world */
  var colliders = [];        // Box3 list used by the player
  var solidMeshes = [];      // meshes bullets can stop against
  var obstacleBoxes = [];
  var obstacleMeshes = [];
  var wallMeshes = [];

  function floorTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var g = c.getContext('2d');
    g.fillStyle = '#2a2f38'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#323844';
    // Deliberately NOT the world RNG. These 900 speckles are pure decoration,
    // but drawing them from the shared stream advanced it by 1800 numbers on
    // the client and not on the headless server, so the two sides generated
    // completely different arenas from the same seed — cover the server could
    // see and the client could not.
    for (var i = 0; i < 900; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    g.strokeStyle = '#3d4552'; g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(cfg.arena / 4, cfg.arena / 4);
    t.anisotropy = 8;
    return t;
  }

  var floorMat = cfg.headless
    ? new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.95 })
    : new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95, metalness: 0.0 });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(cfg.arena, cfg.arena), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);
  solidMeshes.push(floor);

  var wallMat = new THREE.MeshStandardMaterial({ color: 0x5d6a7e, roughness: 0.85 });
  var wallDefs = [
    [0, cfg.wallHeight / 2, -half, cfg.arena, cfg.wallHeight, 1],
    [0, cfg.wallHeight / 2, half, cfg.arena, cfg.wallHeight, 1],
    [-half, cfg.wallHeight / 2, 0, 1, cfg.wallHeight, cfg.arena],
    [half, cfg.wallHeight / 2, 0, 1, cfg.wallHeight, cfg.arena],
  ];
  wallDefs.forEach(function (d, i) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(d[3], d[4], d[5]), wallMat);
    m.position.set(d[0], d[1], d[2]);
    m.castShadow = m.receiveShadow = true;
    m.name = 'wall' + i;
    scene.add(m);
    colliders.push(new THREE.Box3().setFromObject(m));
    solidMeshes.push(m);
    wallMeshes.push(m);
  });

  var obstacleMats = [
    new THREE.MeshStandardMaterial({ color: 0x6b5540, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: 0x51606f, roughness: 0.7, metalness: 0.25 }),
    new THREE.MeshStandardMaterial({ color: 0x3f4a58, roughness: 0.9 }),
  ];

  function addObstacle(x, z, w, h, d) {
    var m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      obstacleMats[Math.floor(rand() * obstacleMats.length)]
    );
    m.position.set(x, h / 2, z);

    /* Quarter turns only.
     *
     * The collider is an axis-aligned box fitted around the mesh, so any other
     * angle makes it bigger than the thing you can see — on average half again,
     * and worse than double for a long thin wall, which is a body's width of
     * cover you get stopped by without touching. A quarter turn just swaps
     * width and depth, so the box is exactly the obstacle.
     */
    m.rotation.y = Math.floor(rand() * 4) * (Math.PI / 2);
    m.castShadow = m.receiveShadow = true;
    m.name = 'obstacle';
    scene.add(m);

    // Nudge anything that ended up poking into a perimeter wall back inside.
    var box = new THREE.Box3().setFromObject(m);
    var lim = half - 0.6;
    var shift = new THREE.Vector3();
    if (box.min.x < -lim) shift.x = -lim - box.min.x;
    else if (box.max.x > lim) shift.x = lim - box.max.x;
    if (box.min.z < -lim) shift.z = -lim - box.min.z;
    else if (box.max.z > lim) shift.z = lim - box.max.z;
    if (shift.lengthSq() > 0) {
      m.position.add(shift);
      m.updateMatrixWorld(true);
      box.setFromObject(m);
    }

    colliders.push(box);
    obstacleBoxes.push(box);
    obstacleMeshes.push(m);
    solidMeshes.push(m);
    return m;
  }

  /* ------------------------------------------------------------ balcony */
  /* A raised deck along one wall with stairs up and a railing, so there is
   * somewhere to shoot from and somewhere to be shot from. */
  var balconyMat = new THREE.MeshStandardMaterial({ color: 0x4f5a68, roughness: 0.85 });
  var balconyParts = [];
  var keepClear = [];        // areas nothing else may be placed in

  function isClearOfKeepOuts(x, z, pad) {
    var margin = pad || 0;
    for (var i = 0; i < keepClear.length; i++) {
      var k = keepClear[i];
      if (x > k.min.x - margin && x < k.max.x + margin &&
          z > k.min.z - margin && z < k.max.z + margin) return false;
    }
    return true;
  }

  function addSolid(mat, x, y, z, w, h, d, name) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    m.name = name || 'structure';
    scene.add(m);
    m.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(m);
    colliders.push(box);
    solidMeshes.push(m);
    balconyParts.push({ mesh: m, box: box });
    return m;
  }

  var balcony = (function buildBalcony() {
    var deckY = cfg.balconyHeight;
    var zBack = -half + 0.5;                 // flush against the far wall
    var depth = cfg.balconyDepth;
    var width = cfg.balconyWidth;
    var zMid = zBack + depth / 2;

    // the deck itself
    addSolid(balconyMat, 0, deckY, zMid, width, 0.4, depth, 'balconyDeck');

    // pillars holding it up
    for (var i = -1; i <= 1; i++) {
      addSolid(balconyMat, i * (width / 2 - 1.5), deckY / 2, zMid + depth / 2 - 0.8,
               0.7, deckY, 0.7, 'balconyPillar');
    }

    // stairs up the left end: shallow enough to walk, no jumping needed
    var steps = Math.max(2, Math.round(deckY / cfg.stepHeight));
    var rise = deckY / steps;
    var run = 0.85;
    var stairX = -width / 2 + 1.2;

    /* Railing along the open edge, built in segments with two ways through:
     * a gap in the middle to drop from, and an opening where the stairs
     * arrive — a solid rail there walls off the top step. */
    var railY = deckY + 0.75;
    var zFront = zMid + depth / 2 - 0.15;
    var segW = 1.6;
    var segments = Math.floor(width / segW);
    for (var r = 0; r < segments; r++) {
      var cx = -width / 2 + segW * (r + 0.5);
      if (Math.abs(cx) < 2.2) continue;                  // the drop-through gap
      if (Math.abs(cx - stairX) < 1.9) continue;         // the way in from the stairs
      addSolid(balconyMat, cx, railY, zFront, segW * 0.94, 1.1, 0.3, 'balconyRail');
    }
    /* Each step is a solid block from the floor up to its own tread, so the
     * rise from one tread to the next is exactly `rise`. Centring boxes of
     * increasing height on their own middles instead leaves gaps of 1.5x the
     * rise between treads, which is more than a player can step up. */
    for (var s = 0; s < steps; s++) {
      var top = rise * (s + 1);
      addSolid(balconyMat, stairX, top / 2,
               zMid + depth / 2 + run * (steps - s) - run / 2,
               2.2, top, run, 'balconyStep');
    }

    /* Nothing may be placed on the stairs or in front of them. Random cover
     * landing here makes the only way up impassable, which is how the balcony
     * ended up unreachable. */
    keepClear.push(new THREE.Box3(
      new THREE.Vector3(stairX - 2.6, 0, zBack),
      new THREE.Vector3(stairX + 2.6, deckY + 2, zMid + depth / 2 + run * steps + 4)
    ));

    return {
      height: deckY, width: width, depth: depth, stairX: stairX,
      z: zMid, parts: balconyParts, keepClear: keepClear,
    };
  })();

  (function buildObstacles() {
    var placed = [];
    var guard = 0;
    while (placed.length < cfg.obstacles && guard++ < 4000) {
      var x = (rand() - 0.5) * (cfg.arena - 8);
      var z = (rand() - 0.5) * (cfg.arena - 8);
      if (Math.hypot(x, z) < 7) continue;                    // keep the spawn clear
      if (!isClearOfKeepOuts(x, z, 1.5)) continue;           // and the way onto the balcony
      var clash = placed.some(function (p) { return Math.hypot(p[0] - x, p[1] - z) < 6; });
      if (clash) continue;
      placed.push([x, z]);
      var kind = rand();
      if (kind < 0.4)      addObstacle(x, z, 2 + rand() * 1.5, 2 + rand() * 1.4, 2 + rand() * 1.5);
      else if (kind < 0.7) addObstacle(x, z, 1.4, 3.5 + rand() * 2.5, 1.4);
      else                 addObstacle(x, z, 5 + rand() * 4, 1.6 + rand(), 1.1);
    }
  })();

  /* ---------------------------------------------------- moving obstacles */
  /* Sliders that run back and forth. Their position is a pure function of the
   * world clock, so the server and every client agree without anything having
   * to be sent about them beyond the time itself. */
  var movers = [];

  function addMover(x, z, w, h, d, axis, amp, speed, phase) {
    var m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: 0x7a6a4e, roughness: 0.75, flatShading: true })
    );
    m.position.set(x, h / 2, z);
    m.castShadow = m.receiveShadow = true;
    m.name = 'mover';
    scene.add(m);
    m.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(m);
    colliders.push(box);
    solidMeshes.push(m);
    var mover = {
      mesh: m, box: box,
      base: new THREE.Vector3(x, h / 2, z),
      delta: new THREE.Vector3(),
      axis: axis, amp: amp, speed: speed, phase: phase,
      half: new THREE.Vector3(w / 2, h / 2, d / 2),
    };
    movers.push(mover);
    return mover;
  }

  // the ground each slider sweeps over, so two of them cannot share it
  function sweptFootprint(x, z, w, d, alongX, amp) {
    return new THREE.Box3(
      new THREE.Vector3(x - w / 2 - (alongX ? amp : 0), 0, z - d / 2 - (alongX ? 0 : amp)),
      new THREE.Vector3(x + w / 2 + (alongX ? amp : 0), 1, z + d / 2 + (alongX ? 0 : amp))
    );
  }

  (function buildMovers() {
    var placed = 0, guard = 0;
    var sweeps = [];
    while (placed < cfg.movingObstacles && guard++ < 2000) {
      var x = (rand() - 0.5) * (cfg.arena - 16);
      var z = (rand() - 0.5) * (cfg.arena - 16);
      if (Math.hypot(x, z) < 9) continue;                 // not through the spawn
      if (z < -half + cfg.balconyDepth + 4) continue;     // not under the balcony
      if (!isClearOfKeepOuts(x, z, amp + 2)) continue;    // never across the stairs
      var alongX = rand() < 0.5;
      var amp = 3 + rand() * 3;
      // keep the whole sweep inside the arena
      if (alongX && Math.abs(x) + amp > half - 4) continue;
      if (!alongX && Math.abs(z) + amp > half - 4) continue;
      var clash = false;
      for (var i = 0; i < obstacleBoxes.length; i++) {
        var c = obstacleBoxes[i].getCenter(new THREE.Vector3());
        if (Math.hypot(c.x - x, c.z - z) < amp + 4) { clash = true; break; }
      }
      if (clash) continue;

      /* And never across another slider's path. Two of them sharing ground
       * pass straight through each other, and a player riding one gets picked
       * up by the other as it crosses. */
      var w = 2.2 + rand(), h = 1.8 + rand() * 1.2, d = 2.2 + rand();
      var sweep = sweptFootprint(x, z, w, d, alongX, amp);
      sweep.expandByScalar(1.2);
      for (var sIdx = 0; sIdx < sweeps.length; sIdx++) {
        if (sweep.intersectsBox(sweeps[sIdx])) { clash = true; break; }
      }
      if (clash) continue;
      sweeps.push(sweep);
      /* A slow, readable slide. Cover that travels faster than a sprinting
       * player is both unreadable and impossible to keep in step across
       * clients, since each one renders it at a slightly different instant. */
      addMover(x, z, w, h, d,
               alongX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
               amp, 0.05 + rand() * 0.09, rand() * Math.PI * 2);
      placed++;
    }
  })();

  /* ---------------------------------------------------------- health packs */
  /* Fixed spots, seeded like everything else, so both sides of a networked
   * game know where they are without a word being sent about it. Only whether
   * one is on the ground right now has to travel. */
  var medkits = [];

  var kitMats = cfg.headless ? null : {
    box: new THREE.MeshStandardMaterial({
      color: 0xf2f5f7, roughness: 0.5, flatShading: true,
    }),
    cross: new THREE.MeshStandardMaterial({
      color: 0xff5a5f, emissive: 0xff2d33, emissiveIntensity: 0.55, roughness: 0.4,
    }),
  };
  var kitGeo = cfg.headless ? null : {
    box: new THREE.BoxGeometry(0.8, 0.5, 0.8),
    bar: new THREE.BoxGeometry(0.5, 0.12, 0.14),
  };

  function buildKit(x, y, z) {
    if (cfg.headless) return null;
    var group = new THREE.Group();
    var box = new THREE.Mesh(kitGeo.box, kitMats.box);
    box.castShadow = true;
    group.add(box);
    // a red cross on the lid, two bars of the same geometry
    var barA = new THREE.Mesh(kitGeo.bar, kitMats.cross);
    barA.position.y = 0.26;
    var barB = new THREE.Mesh(kitGeo.bar, kitMats.cross);
    barB.position.y = 0.26;
    barB.rotation.y = Math.PI / 2;
    group.add(barA, barB);
    var tag = PB.createNameTag('HEALTH', '#ff8b8f', { y: 0.95, scale: 1.9, font: 30 });
    group.add(tag.sprite);
    group.position.set(x, y, z);
    group.name = 'medkit';
    scene.add(group);
    return { group: group, tag: tag };
  }

  (function buildMedkits() {
    var guard = 0;
    while (medkits.length < cfg.medkits && guard++ < 3000) {
      var x = (rand() - 0.5) * (cfg.arena - 12);
      var z = (rand() - 0.5) * (cfg.arena - 12);
      if (Math.hypot(x, z) < 8) continue;                  // not on the spawn
      if (!isClearOfKeepOuts(x, z, 2)) continue;           // not on the stairs
      var probe = new THREE.Vector3(x, 0.9, z);
      var clash = false;
      for (var i = 0; i < obstacleBoxes.length; i++) {
        if (obstacleBoxes[i].distanceToPoint(probe) < 2) { clash = true; break; }
      }
      if (clash) continue;
      for (var m = 0; m < movers.length; m++) {
        // nothing under a slider: it would be run over and hidden
        if (Math.hypot(movers[m].base.x - x, movers[m].base.z - z) < movers[m].amp + 3) {
          clash = true; break;
        }
      }
      if (clash) continue;
      for (var k = 0; k < medkits.length; k++) {
        if (Math.hypot(medkits[k].x - x, medkits[k].z - z) < cfg.arena / 3) {
          clash = true; break;                             // keep the two apart
        }
      }
      if (clash) continue;

      medkits.push({
        index: medkits.length,
        x: x, y: 0.45, z: z,
        ready: true,
        phase: rand() * 6.28,
        view: buildKit(x, 0.45, z),
      });
    }
  })();

  // Bob them, and show or hide one that has just been taken or come back.
  function updateMedkits(dt) {
    for (var i = 0; i < medkits.length; i++) {
      var kit = medkits[i];
      kit.phase += dt;
      if (!kit.view) continue;
      kit.view.group.visible = kit.ready;
      if (!kit.ready) continue;
      kit.view.group.rotation.y += dt * 0.9;
      kit.view.group.position.y = kit.y + Math.sin(kit.phase * 2) * 0.12;
      kit.view.group.updateMatrixWorld(true);
    }
  }

  // Whichever pack is on the ground within reach of this spot.
  function medkitAt(x, z, feetY) {
    for (var i = 0; i < medkits.length; i++) {
      var kit = medkits[i];
      if (!kit.ready) continue;
      if (Math.hypot(kit.x - x, kit.z - z) > cfg.medkitRadius) continue;
      if (typeof feetY === 'number' && Math.abs(feetY - (kit.y - 0.45)) > 2.2) continue;
      return kit;
    }
    return null;
  }

  var _moverPos = new THREE.Vector3();

  // Position every slider for world time `t`, and refresh its collider.
  function updateMovers(t) {
    for (var i = 0; i < movers.length; i++) {
      var mv = movers[i];
      var offset = Math.sin(t * mv.speed * Math.PI * 2 + mv.phase) * mv.amp;
      _moverPos.copy(mv.base).addScaledVector(mv.axis, offset);
      // how far it travelled this update, so anything riding it can follow
      mv.delta.subVectors(_moverPos, mv.mesh.position);
      mv.mesh.position.copy(_moverPos);
      mv.mesh.updateMatrixWorld(true);
      mv.box.min.set(
        _moverPos.x - mv.half.x, _moverPos.y - mv.half.y, _moverPos.z - mv.half.z);
      mv.box.max.set(
        _moverPos.x + mv.half.x, _moverPos.y + mv.half.y, _moverPos.z + mv.half.z);
    }
  }

  /* A cheap signature of the arena layout. Both sides compute it from the
   * same code, so a mismatch means the two worlds were generated differently
   * and every shot will disagree about what it hit. */
  function fingerprint() {
    var acc = 0;
    function mix(vals) {
      for (var v = 0; v < vals.length; v++) {
        acc = (acc * 31 + Math.round(vals[v] * 100)) | 0;
      }
    }
    for (var i = 0; i < obstacleBoxes.length; i++) {
      var b = obstacleBoxes[i];
      mix([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]);
    }
    // the sliders go in by where they started and how they move, never by
    // where they are right now — otherwise the check depends on the clock
    for (var m = 0; m < movers.length; m++) {
      var mv = movers[m];
      mix([mv.base.x, mv.base.y, mv.base.z, mv.amp, mv.speed, mv.phase,
           mv.axis.x, mv.axis.z]);
    }
    for (var p = 0; p < balconyParts.length; p++) {
      var pb = balconyParts[p].box;
      mix([pb.min.x, pb.min.y, pb.min.z, pb.max.x, pb.max.y, pb.max.z]);
    }
    // the health packs are part of the layout too, and a disagreement about
    // where they are is a disagreement about where healing happens
    for (var k = 0; k < medkits.length; k++) mix([medkits[k].x, medkits[k].z]);
    return (acc >>> 0).toString(16) + ':' + obstacleBoxes.length + ':' + movers.length;
  }

  return {
    fingerprint: fingerprint,
    balcony: balcony,
    balconyParts: balconyParts,
    movers: movers,
    updateMovers: updateMovers,
    medkits: medkits,
    updateMedkits: updateMedkits,
    medkitAt: medkitAt,
    colliders: colliders,
    solidMeshes: solidMeshes,
    obstacleBoxes: obstacleBoxes,
    obstacleMeshes: obstacleMeshes,
    wallMeshes: wallMeshes,
    floor: floor,
    addObstacle: addObstacle,
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
