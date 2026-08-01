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
    m.rotation.y = (rand() - 0.5) * 0.5;
    m.castShadow = m.receiveShadow = true;
    m.name = 'obstacle';
    scene.add(m);

    // Rotation grows the world-space box, so nudge anything that ended up
    // poking into a perimeter wall back inside the play area.
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

  (function buildObstacles() {
    var placed = [];
    var guard = 0;
    while (placed.length < cfg.obstacles && guard++ < 4000) {
      var x = (rand() - 0.5) * (cfg.arena - 8);
      var z = (rand() - 0.5) * (cfg.arena - 8);
      if (Math.hypot(x, z) < 7) continue;                    // keep the spawn clear
      var clash = placed.some(function (p) { return Math.hypot(p[0] - x, p[1] - z) < 6; });
      if (clash) continue;
      placed.push([x, z]);
      var kind = rand();
      if (kind < 0.4)      addObstacle(x, z, 2 + rand() * 1.5, 2 + rand() * 1.4, 2 + rand() * 1.5);
      else if (kind < 0.7) addObstacle(x, z, 1.4, 3.5 + rand() * 2.5, 1.4);
      else                 addObstacle(x, z, 5 + rand() * 4, 1.6 + rand(), 1.1);
    }
  })();

  /* A cheap signature of the arena layout. Both sides compute it from the
   * same code, so a mismatch means the two worlds were generated differently
   * and every shot will disagree about what it hit. */
  function fingerprint() {
    var acc = 0;
    for (var i = 0; i < obstacleBoxes.length; i++) {
      var b = obstacleBoxes[i];
      var vals = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
      for (var v = 0; v < vals.length; v++) {
        acc = (acc * 31 + Math.round(vals[v] * 100)) | 0;
      }
    }
    return (acc >>> 0).toString(16) + ':' + obstacleBoxes.length;
  }

  return {
    fingerprint: fingerprint,
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
