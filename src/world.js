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

  /* --------------------------------------------------- built structures */
  /* Everything below is made of boxes, and on purpose.
   *
   * What the player walks into is an axis-aligned box list, so a shape that is
   * one mesh and one box can only ever be a box. An arch, a doorway or a room
   * is several boxes with the gaps left out — which is also why they are worth
   * having: you can walk through the hole, shoot through it, and be shot
   * through it, none of which a solid crate offers.
   *
   * They go into obstacleBoxes as well as colliders, so spawns, health packs,
   * sliders and NPCs all keep away from them, and so they are part of the
   * arena fingerprint the two sides check.
   */
  var structures = [];        // {kind, parts: [mesh], box: overall footprint}

  /* The air inside a room, which is not a collider and not solid, and which
   * nothing may be spawned into.
   *
   * A target floating inside four walls is one that can only be shot through a
   * doorway from exactly the right angle, if at all — the level cannot be
   * cleared and the player has no way of knowing why. The space is worth
   * having as somewhere to stand and fight over; it is not worth having as
   * somewhere to hide a target. */
  var interiors = [];

  function insideAnything(x, z, y, pad) {
    var m = pad || 0;
    for (var i = 0; i < interiors.length; i++) {
      var b = interiors[i];
      if (x < b.min.x - m || x > b.max.x + m) continue;
      if (z < b.min.z - m || z > b.max.z + m) continue;
      if (typeof y === 'number' && (y < b.min.y - m || y > b.max.y + m)) continue;
      return true;
    }
    return false;
  }

  function addPart(mat, x, y, z, w, h, d, name) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    m.name = name || 'structure';
    scene.add(m);
    m.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(m);
    colliders.push(box);
    obstacleBoxes.push(box);
    obstacleMeshes.push(m);
    solidMeshes.push(m);
    return m;
  }

  function structureOf(kind, parts) {
    var box = new THREE.Box3();
    for (var i = 0; i < parts.length; i++) box.expandByObject(parts[i]);
    var s = { kind: kind, parts: parts, box: box };
    structures.push(s);
    return s;
  }

  function pickMat() {
    return obstacleMats[Math.floor(rand() * obstacleMats.length)];
  }

  /* A ramp: solid at the back, sloping down to the floor at the front.
   *
   * The mesh is a true triangular prism, because a staircase of boxes reads as
   * a staircase. The collider is a handful of steps *inscribed under* the
   * slope — never above it, so nothing ever stops you in mid-air, and each one
   * is short enough to walk up, which is the whole point of a ramp. The cost
   * is sinking a few centimetres into the surface on the way up, which is a
   * far better trade than being stopped by air, or than an axis-aligned box
   * around the whole wedge — that is a wall you can see over and not climb.
   */
  function wedgeGeometry(w, h, d) {
    var geo = new THREE.BufferGeometry();
    var x = w / 2, z = d / 2;
    // 0-3 bottom, 4-5 the top edge along the high side
    var v = [
      -x, 0, -z, x, 0, -z, x, 0, z, -x, 0, z,
      -x, h, -z, x, h, -z,
    ];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.setIndex([
      0, 2, 1, 0, 3, 2,          // floor
      4, 1, 5, 4, 0, 1,          // the high back
      4, 3, 0, 5, 1, 2,          // the two triangular sides
      4, 5, 2, 4, 2, 3,          // the slope
    ]);
    geo.computeVertexNormals();
    return geo;
  }

  function addWedge(x, z, w, h, d, turns) {
    var m = new THREE.Mesh(wedgeGeometry(w, h, d), pickMat());
    m.position.set(x, 0, z);
    m.rotation.y = turns * (Math.PI / 2);       // quarter turns, as ever
    m.castShadow = m.receiveShadow = true;
    m.name = 'wedge';
    scene.add(m);
    m.updateMatrixWorld(true);
    solidMeshes.push(m);
    obstacleMeshes.push(m);
    /* Its whole volume goes on the obstacle list, which is what spawning,
     * targets and the sliders keep away from — nothing should be dropped
     * inside a ramp even though a player can walk up the outside of it. That
     * list stays one box per mesh; the stepped boxes below are what a player
     * actually walks into, and they go on the collider list alone. */
    obstacleBoxes.push(new THREE.Box3().setFromObject(m));

    /* Steps under the slope. Each is as tall as the slope is at the far edge
     * of that step, so the top of every step is on or below the surface. */
    var steps = [];
    var count = Math.max(2, Math.ceil(h / cfg.stepHeight));
    var parts = [m];
    var alongZ = turns % 2 === 0;
    var run = (alongZ ? d : w) / count;
    for (var s = 0; s < count; s++) {
      var top = h * (s / count);                // the low edge of this step
      if (top <= 0.001) continue;
      var mid = (alongZ ? d : w) / 2 - run * (s + 0.5);
      var flip = (turns === 0 || turns === 3) ? 1 : -1;
      var px = alongZ ? x : x + mid * flip;
      var pz = alongZ ? z + mid * flip : z;
      var box = new THREE.Box3(
        new THREE.Vector3(px - (alongZ ? w : run) / 2, 0, pz - (alongZ ? run : d) / 2),
        new THREE.Vector3(px + (alongZ ? w : run) / 2, top, pz + (alongZ ? run : d) / 2)
      );
      colliders.push(box);
      steps.push(box);
    }
    var s = structureOf('wedge', parts);
    s.steps = steps;               // what a player actually walks up
    return s;
  }

  /* Two posts and a lintel. Walk under it, shoot under it, take cover behind
   * a post — the gap is the point, so it is sized for a player to pass. */
  function addArch(x, z, span, height, thick) {
    var mat = pickMat();
    var post = Math.max(0.6, thick);
    var clear = Math.max(2.1, height - 0.7);         // headroom under the lintel
    var parts = [
      addPart(mat, x - span / 2, clear / 2, z, post, clear, post, 'archPost'),
      addPart(mat, x + span / 2, clear / 2, z, post, clear, post, 'archPost'),
      addPart(mat, x, clear + 0.35, z, span + post, 0.7, post, 'archTop'),
    ];
    return structureOf('arch', parts);
  }

  /* A room with its top open: four walls, some of them with a doorway.
   *
   * Open above so light reaches inside and so it can be shot into from the
   * balcony — a lid would make it a dark box that is safe to stand in, which
   * is the opposite of what cover in this arena is for.
   */
  function addHollow(x, z, size, height, doorways) {
    var mat = pickMat();
    var t = 0.5;                                   // wall thickness
    var doorW = 1.8;                               // a player is 0.84 across
    var doorH = 2.1;
    var parts = [];
    var half2 = size / 2;

    for (var side = 0; side < 4; side++) {
      var alongX = side % 2 === 0;
      var sign = side < 2 ? -1 : 1;
      var cx = alongX ? 0 : sign * half2;
      var cz = alongX ? sign * half2 : 0;
      var w = alongX ? size : t;
      var d = alongX ? t : size;

      if (doorways.indexOf(side) === -1) {
        parts.push(addPart(mat, x + cx, height / 2, z + cz, w, height, d, 'roomWall'));
        continue;
      }
      // two pillars and the lintel over the gap between them
      var run = (size - doorW) / 2;
      var off = doorW / 2 + run / 2;
      parts.push(addPart(mat, x + cx + (alongX ? -off : 0), height / 2,
                         z + cz + (alongX ? 0 : -off),
                         alongX ? run : t, height, alongX ? t : run, 'roomWall'));
      parts.push(addPart(mat, x + cx + (alongX ? off : 0), height / 2,
                         z + cz + (alongX ? 0 : off),
                         alongX ? run : t, height, alongX ? t : run, 'roomWall'));
      if (height > doorH + 0.2) {
        parts.push(addPart(mat, x + cx, (height + doorH) / 2, z + cz,
                           alongX ? doorW : t, height - doorH, alongX ? t : doorW,
                           'roomLintel'));
      }
    }
    // the air in the middle: somewhere to stand, nowhere to hang a target
    interiors.push(new THREE.Box3(
      new THREE.Vector3(x - half2 + t, 0, z - half2 + t),
      new THREE.Vector3(x + half2 - t, height, z + half2 - t)
    ));
    return structureOf('room', parts);
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

  /* ---------------------------------------------------------- the house */
  /* One per arena, on a random edge: a room you can go inside, a fence you
   * have to get over, and a tree for company.
   *
   * It is the one landmark in a level otherwise made of scattered crates —
   * somewhere to say "the house" about, somewhere to be cornered, and the only
   * place with a roof over it. The fence is deliberately jumpable rather than
   * gated: it slows an approach down and makes the way in a decision, without
   * ever locking anybody out of anywhere.
   */
  var house = null;

  var houseMats = {
    wall: new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 0.9 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x5b3f36, roughness: 0.85,
                                           flatShading: true }),
    fence: new THREE.MeshStandardMaterial({ color: 0x6d5a44, roughness: 0.95 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x4a3a2e, roughness: 1 }),
    leaves: new THREE.MeshStandardMaterial({ color: 0x3f7a45, roughness: 0.95,
                                             flatShading: true }),
  };

  (function buildHouse() {
    if (!cfg.house) return null;
    var W = 9, D = 8, H = 3.2;               // outside dimensions of the room
    var t = 0.45;                            // wall thickness
    var doorW = 1.9, doorH = 2.2;            // a player is 0.84 across, 1.75 tall
    var yard = 4.2;                          // fence standoff from the walls

    /* Pick an edge, but never the one the balcony runs along: the two would
     * fight over the same ground and the stairs are the only way up. */
    var edge = Math.floor(rand() * 3) + 1;   // 1..3, skipping the balcony's 0 (-Z)
    var inset = half - (Math.max(W, D) / 2 + yard + 2);
    var along = (rand() - 0.5) * (cfg.arena - Math.max(W, D) - yard * 2 - 10);
    var cx, cz, turn;
    if (edge === 1) { cx = along; cz = inset; turn = 0; }        // +Z wall
    else if (edge === 2) { cx = -inset; cz = along; turn = 1; }  // -X wall
    else { cx = inset; cz = along; turn = 3; }                   // +X wall

    var w = turn % 2 === 0 ? W : D;          // footprint after the quarter turn
    var d = turn % 2 === 0 ? D : W;
    var parts = [];

    /* Walls, with three doorways: one on each of three sides, so there is
     * always a way in from wherever you came at it and always a way out that
     * is not the way you came. The fourth side is solid, which is what makes
     * the inside worth standing in. */
    var sides = [
      { dx: 0, dz: -d / 2, w: w, d: t, door: turn !== 0 },
      { dx: 0, dz: d / 2, w: w, d: t, door: true },
      { dx: -w / 2, dz: 0, w: t, d: d, door: true },
      { dx: w / 2, dz: 0, w: t, d: d, door: turn === 0 },
    ];
    sides.forEach(function (s, i) {
      var alongX = s.w > s.d;
      if (!s.door) {
        parts.push(addPart(houseMats.wall, cx + s.dx, H / 2, cz + s.dz,
                           s.w, H, s.d, 'houseWall'));
        return;
      }
      var span = alongX ? s.w : s.d;
      var run = (span - doorW) / 2;
      var off = doorW / 2 + run / 2;
      parts.push(addPart(houseMats.wall,
                         cx + s.dx + (alongX ? -off : 0), H / 2,
                         cz + s.dz + (alongX ? 0 : -off),
                         alongX ? run : t, H, alongX ? t : run, 'houseWall'));
      parts.push(addPart(houseMats.wall,
                         cx + s.dx + (alongX ? off : 0), H / 2,
                         cz + s.dz + (alongX ? 0 : off),
                         alongX ? run : t, H, alongX ? t : run, 'houseWall'));
      parts.push(addPart(houseMats.wall, cx + s.dx, (H + doorH) / 2, cz + s.dz,
                         alongX ? doorW : t, H - doorH, alongX ? t : doorW,
                         'houseLintel'));
      void i;
    });

    /* A roof, which is what makes it a house rather than a room. Two courses
     * stepped inwards rather than a true pitch: the collider under a sloped
     * mesh is the box around it, and a box around a pitched roof is a ceiling
     * a metre above the ridge that rounds stop against in mid-air. */
    parts.push(addPart(houseMats.roof, cx, H + 0.25, cz, w + 0.9, 0.5, d + 0.9,
                       'houseRoof'));
    parts.push(addPart(houseMats.roof, cx, H + 0.75, cz, w - 1.4, 0.5, d - 1.4,
                       'houseRoofTop'));

    /* The fence: posts and rails at a height a standing jump clears. Left open
     * on the side the solid wall faces, so the yard is never a trap. */
    var fenceH = 1.15;
    var fx0 = cx - w / 2 - yard, fx1 = cx + w / 2 + yard;
    var fz0 = cz - d / 2 - yard, fz1 = cz + d / 2 + yard;
    var lim = half - 1.2;
    fx0 = Math.max(-lim, fx0); fx1 = Math.min(lim, fx1);
    fz0 = Math.max(-lim, fz0); fz1 = Math.min(lim, fz1);

    /* Panels with real gaps between them, rather than one long low wall.
     *
     * The gap is 0.6 — wider than that and a player could walk through it
     * instead of over, which would make the whole thing pointless; narrower
     * and it does not read as a fence from the ground. Rounds pass through the
     * gaps, so somebody sheltering behind it is not safe, only harder. */
    function fenceRun(x0, z0, x1, z1) {
      var len = Math.hypot(x1 - x0, z1 - z0);
      var alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      var gap = 0.6;
      var panels = Math.max(1, Math.round(len / 2.2));
      var panel = len / panels - gap;
      if (panel < 0.5) return;
      for (var p = 0; p < panels; p++) {
        var f = (p + 0.5) / panels;
        var px = x0 + (x1 - x0) * f;
        var pz = z0 + (z1 - z0) * f;
        parts.push(addPart(houseMats.fence, px, fenceH / 2, pz,
                           alongX ? panel : 0.22, fenceH,
                           alongX ? 0.22 : panel, 'fence'));
      }
    }
    fenceRun(fx0, fz0, fx1, fz0);
    fenceRun(fx0, fz1, fx1, fz1);
    fenceRun(fx0, fz0, fx0, fz1);
    fenceRun(fx1, fz0, fx1, fz1);

    /* A tree, outside the fence. The trunk stops a round; the canopy does not,
     * because a bush that eats bullets is a bush players will hate. */
    var treeSide = rand() < 0.5 ? -1 : 1;
    var tx = cx + (w / 2 + yard + 2.4) * (turn % 2 === 0 ? treeSide : 0);
    var tz = cz + (d / 2 + yard + 2.4) * (turn % 2 === 0 ? 0 : treeSide);
    tx = Math.max(-lim, Math.min(lim, tx));
    tz = Math.max(-lim, Math.min(lim, tz));
    parts.push(addPart(houseMats.trunk, tx, 1.5, tz, 0.55, 3, 0.55, 'treeTrunk'));
    if (!cfg.headless) {
      var canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 0), houseMats.leaves);
      canopy.position.set(tx, 4.1, tz);
      canopy.castShadow = true;
      canopy.name = 'treeCanopy';
      scene.add(canopy);
      canopy.updateMatrixWorld(true);
      parts.push(canopy);
    }

    // nothing else may be dropped in the yard or through the walls
    keepClear.push(new THREE.Box3(
      new THREE.Vector3(fx0 - 1, 0, fz0 - 1),
      new THREE.Vector3(fx1 + 1, H + 2, fz1 + 1)
    ));
    interiors.push(new THREE.Box3(
      new THREE.Vector3(cx - w / 2 + t, 0, cz - d / 2 + t),
      new THREE.Vector3(cx + w / 2 - t, H, cz + d / 2 - t)
    ));

    house = structureOf('house', parts);
    house.x = cx;
    house.z = cz;
    house.width = w;
    house.depth = d;
    house.height = H;
    house.doorHeight = doorH;
    house.doorWidth = doorW;
    house.fence = { minX: fx0, maxX: fx1, minZ: fz0, maxZ: fz1, height: fenceH };
    house.tree = { x: tx, z: tz };
    house.edge = edge;
    return house;
  })();

  (function buildObstacles() {
    var placed = [];       // [x, z, extent] — how much room each one took
    var guard = 0;
    while (placed.length < cfg.obstacles && guard++ < 6000) {
      /* Decide what is going here before deciding whether it fits. A crate and
       * a room are not the same size, and the clearances below — from the
       * spawn, from the balcony stairs, from each other — are all about how
       * much ground a thing takes up. Judging every one of them as though it
       * were a crate is how a room ended up reaching into the middle of the
       * map with two players trying to shoot each other across it. */
      var kind = rand();
      var plan;
      if (kind < 0.28) {
        plan = { what: 'box', w: 2 + rand() * 1.5, h: 2 + rand() * 1.4, d: 2 + rand() * 1.5 };
      } else if (kind < 0.46) {
        plan = { what: 'box', w: 1.4, h: 3.5 + rand() * 2.5, d: 1.4 };
      } else if (kind < 0.62) {
        plan = { what: 'box', w: 5 + rand() * 4, h: 1.6 + rand(), d: 1.1 };
      } else if (kind < 0.76) {
        // a ramp: cover from one side, a way up from the other
        plan = { what: 'wedge', w: 3 + rand() * 2.5, h: 1.4 + rand() * 1.4,
                 d: 3.5 + rand() * 2.5, turns: Math.floor(rand() * 4) };
      } else if (kind < 0.88) {
        plan = { what: 'arch', span: 3 + rand() * 2, h: 3.2 + rand() * 1.2,
                 thick: 0.7 + rand() * 0.4 };
      } else {
        /* A room with two or three ways in. Two doorways on opposite sides is
         * a passage; three is somewhere to be flanked in. */
        var sides = [0, 1, 2, 3];
        // seeded shuffle, so both sides of the wire cut the same doors
        for (var s = sides.length - 1; s > 0; s--) {
          var j = Math.floor(rand() * (s + 1));
          var tmp = sides[s]; sides[s] = sides[j]; sides[j] = tmp;
        }
        plan = { what: 'room', size: 5.5 + rand() * 2.5, h: 2.9 + rand() * 0.8,
                 doors: sides.slice(0, rand() < 0.5 ? 2 : 3) };
      }

      var extent = plan.what === 'room' ? plan.size
        : plan.what === 'arch' ? plan.span + plan.thick
        : Math.max(plan.w, plan.d);
      var reach = extent / 2;

      var x = (rand() - 0.5) * (cfg.arena - 8 - extent);
      var z = (rand() - 0.5) * (cfg.arena - 8 - extent);
      // the spawn stays clear of the whole of it, not of its centre
      if (Math.hypot(x, z) < 7 + reach) continue;
      if (!isClearOfKeepOuts(x, z, 1.5 + reach)) continue;
      var clash = placed.some(function (p) {
        return Math.hypot(p[0] - x, p[1] - z) < 4 + reach + p[2] / 2;
      });
      if (clash) continue;
      placed.push([x, z, extent]);

      if (plan.what === 'box') addObstacle(x, z, plan.w, plan.h, plan.d);
      else if (plan.what === 'wedge') addWedge(x, z, plan.w, plan.h, plan.d, plan.turns);
      else if (plan.what === 'arch') addArch(x, z, plan.span, plan.h, plan.thick);
      else addHollow(x, z, plan.size, plan.h, plan.doors);
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
      /* Nothing static in the ground it sweeps. Tested against the boxes
       * themselves rather than against their centres within a radius: the
       * arena is full of structures made of many small parts now, and a
       * radius around every one of those centres rules out most of the map —
       * which is how six sliders became two. */
      var w = 2.2 + rand(), h = 1.8 + rand() * 1.2, d = 2.2 + rand();
      var sweep = sweptFootprint(x, z, w, d, alongX, amp);
      sweep.expandByScalar(1.2);
      var clash = false;
      for (var i = 0; i < obstacleBoxes.length; i++) {
        var ob = obstacleBoxes[i];
        if (sweep.max.x < ob.min.x || sweep.min.x > ob.max.x) continue;
        if (sweep.max.z < ob.min.z || sweep.min.z > ob.max.z) continue;
        clash = true;
        break;
      }
      if (clash) continue;

      /* And never across another slider's path. Two of them sharing ground
       * pass straight through each other, and a player riding one gets picked
       * up by the other as it crosses. */
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
    structures: structures,
    interiors: interiors,
    insideAnything: insideAnything,
    house: house,
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
