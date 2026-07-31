/* The viewmodel: gun parts, muzzle flash, and the reload animation.
 *
 * Part of the Paintball engine. Classic script, no modules: the game has to
 * run straight off the filesystem, where Chrome refuses to load ES modules.
 * Every builder takes the shared context created by createGame and returns
 * the handful of things the rest of the engine needs.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createWeapon = function (ctx) {
  var THREE = global.THREE;
  var cfg = ctx.cfg, camera = ctx.camera, state = ctx.state;
  var VIEW_LAYER = ctx.VIEW_LAYER, lights = ctx.lights;

  /* ---------------------------------------------------------------- gun */
  var gun = new THREE.Group();
  var steel = new THREE.MeshStandardMaterial({ color: 0x2e333c, roughness: 0.45, metalness: 0.75 });
  var dark = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.7, metalness: 0.4 });
  var accentMat = new THREE.MeshStandardMaterial({ color: 0x4d8cff, emissive: 0x2a5fd0, emissiveIntensity: 0.7, roughness: 0.4 });

  function part(geo, mat, x, y, z) {
    var m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    gun.add(m);
    return m;
  }
  part(new THREE.BoxGeometry(0.13, 0.16, 0.62), steel, 0, 0, -0.20);       // receiver
  part(new THREE.BoxGeometry(0.07, 0.07, 0.55), dark, 0, 0.02, -0.66);     // barrel
  part(new THREE.BoxGeometry(0.10, 0.10, 0.10), dark, 0, 0.02, -0.95);     // muzzle block
  var grip = part(new THREE.BoxGeometry(0.11, 0.28, 0.13), dark, 0, -0.19, 0.02);
  grip.rotation.x = -0.28;
  part(new THREE.BoxGeometry(0.09, 0.09, 0.22), dark, 0, -0.06, -0.44);    // fore-grip
  part(new THREE.BoxGeometry(0.04, 0.045, 0.30), accentMat, 0, 0.10, -0.22); // rail glow
  part(new THREE.BoxGeometry(0.025, 0.05, 0.02), steel, 0, 0.145, -0.36);  // front sight
  part(new THREE.BoxGeometry(0.14, 0.13, 0.16), steel, 0, -0.02, 0.16);    // stock
  var magazine = part(new THREE.BoxGeometry(0.10, 0.24, 0.13), dark, 0, -0.17, -0.14);
  var MAG_HOME = magazine.position.clone();

  var GUN_HOME = new THREE.Vector3(0.26, -0.22, -0.50);
  // sighted: centred under the crosshair and pulled in against the shoulder
  var GUN_SIGHTED = new THREE.Vector3(0.0, -0.105, -0.62);
  gun.position.copy(GUN_HOME);
  gun.rotation.set(0, 0.03, 0);
  gun.scale.setScalar(0.80);
  gun.name = 'viewmodel';
  camera.add(gun);

  var muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -1.05);
  gun.add(muzzle);

  var muzzleFlash = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0 })
  );
  muzzleFlash.position.copy(muzzle.position);
  gun.add(muzzleFlash);

  var muzzleLight = new THREE.PointLight(0xffb45a, 0, 9);
  muzzleLight.position.copy(muzzle.position);
  gun.add(muzzleLight);

  // The viewmodel sits on its own layer and is drawn over a cleared depth
  // buffer, so it never intersects a wall the player is standing against.
  gun.traverse(function (o) { o.layers.set(VIEW_LAYER); });
  muzzleLight.layers.enable(0);
  lights.forEach(function (l) { l.layers.enable(VIEW_LAYER); });

  return {
    gun: gun, magazine: magazine, MAG_HOME: MAG_HOME,
    GUN_HOME: GUN_HOME, GUN_SIGHTED: GUN_SIGHTED,
    muzzle: muzzle, muzzleFlash: muzzleFlash, muzzleLight: muzzleLight,
  };
};

/* Headless has no viewmodel, but the rest of the engine still poses and reads
 * it, so hand back inert stand-ins with the same shape. */
PB.stubWeapon = function (ctx) {
  var THREE = global.THREE;
  var nowhere = new THREE.Object3D();
  return {
    gun: new THREE.Object3D(),
    magazine: new THREE.Object3D(),
    MAG_HOME: new THREE.Vector3(),
    GUN_HOME: new THREE.Vector3(),
    GUN_SIGHTED: new THREE.Vector3(),
    muzzle: nowhere,
    muzzleFlash: { material: { opacity: 0 }, scale: { setScalar: function () {} } },
    muzzleLight: { intensity: 0 },
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
