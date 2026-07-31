/* Paintball — a small first-person shooting range.
 *
 * Classic (non-module) script so the game runs straight off the filesystem:
 * Chrome refuses to execute ES modules from file:// URLs.
 *
 * Exposes window.createGame(options) -> game. Everything the test suite needs
 * to drive the game (input, stepping, aiming, teleporting) is on the returned
 * object, so tests never have to reach into internals.
 */
(function (global) {
'use strict';

var THREE = global.THREE;

var DEFAULTS = {
  arena: 60,
  wallHeight: 7,
  eye: 1.7,
  radius: 0.42,
  playerHeight: 1.75,
  speed: 7.0,
  sprint: 11.0,
  accel: 60,
  friction: 10,
  gravity: 26,
  jump: 8.2,
  magSize: 12,
  reloadMs: 950,
  fireMs: 130,
  bulletSpeed: 120,
  obstacles: 26,
  targetsPerLevel: 10,
  wanderingTargets: 0.6,      // fraction of targets that drift around
  npcsPerLevel: 4,            // level 1; one more per level after that
  scoreTarget: 100,
  scoreNpc: 250,
  scoreMiss: -25,
  scoreLevelBonus: 500,
  seed: null,               // number => deterministic world, null => random
  audio: true,
  shadows: true,
  container: null,
  preserveDrawingBuffer: false,  // tests turn this on to read pixels back
  headless: false,            // server side: simulate without a renderer or a DOM
  lookSpikePx: 500,           // a single mouse sample larger than this is discarded
  fov: 75,
  zoomFov: 42,                // right mouse button sights down the barrel
  zoomTime: 0.13,             // seconds to go all the way in or out
};

var VIEW_LAYER = 1;         // the gun renders here, in a second depth-cleared pass

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createGame(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var rand = cfg.seed === null ? Math.random : mulberry32(cfg.seed);
  var half = cfg.arena / 2;

  /* ----------------------------------------------------------- renderer */
  var container = cfg.container ||
    (typeof document !== 'undefined' ? document.body : null);
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121a24);
  scene.fog = new THREE.Fog(0x121a24, 45, 120);

  var width = (container && container.clientWidth) || global.innerWidth || 800;
  var height = (container && container.clientHeight) || global.innerHeight || 600;

  var camera = new THREE.PerspectiveCamera(cfg.fov, width / height, 0.05, 400);

  // Headless runs the same simulation with no renderer and no DOM, so the
  // server can build the identical world from the same seed.
  var renderer = null;
  if (!cfg.headless) {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: cfg.preserveDrawingBuffer,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = cfg.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
  }

  var yawObj = new THREE.Object3D();
  var pitchObj = new THREE.Object3D();
  yawObj.add(pitchObj);
  pitchObj.add(camera);
  scene.add(yawObj);

  // The viewmodel gets its own wider lens. Scaling the gun down instead would
  // also pull it closer to the camera, which cancels out most of the effect.
  var viewCamera = new THREE.PerspectiveCamera(85, width / height, 0.01, 12);
  viewCamera.layers.set(VIEW_LAYER);
  camera.add(viewCamera);

  function resize() {
    if (!renderer) return;
    var w = container.clientWidth || global.innerWidth;
    var h = container.clientHeight || global.innerHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewCamera.aspect = w / h;
    viewCamera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  /* ------------------------------------------------------------- lights */
  var hemi = new THREE.HemisphereLight(0x9dc0ff, 0x2a2f38, 0.95);
  scene.add(hemi);

  var sun = new THREE.DirectionalLight(0xffeedd, 1.5);
  sun.position.set(24, 38, 16);
  sun.castShadow = cfg.shadows;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -half * 1.2;
  sun.shadow.camera.right = half * 1.2;
  sun.shadow.camera.top = half * 1.2;
  sun.shadow.camera.bottom = -half * 1.2;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0009;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  var ambient = new THREE.AmbientLight(0x4c5a70, 0.65);
  scene.add(ambient);

  /* ------------------------------------------------- shared state + bus */
  var state = {
    score: 0, level: 1, mag: cfg.magSize, reloading: false,
    lastShot: -1e9, vel: new THREE.Vector3(), pos: new THREE.Vector3(0, cfg.eye, 0),
    vy: 0, grounded: true, bob: 0, bobX: 0, bobY: 0, recoil: 0, kick: 0,
    kickBack: 0, reloadT: 0, active: false, shotsFired: 0, elapsed: 0,
    lookSpikes: 0, maxLookDelta: 0, zoom: 0, networked: false,
  };
  var zooming = false;

  var listeners = {};
  function on(evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); return api; }
  function emit(evt, data) {
    var subs = listeners[evt];
    if (!subs) return;
    for (var i = 0; i < subs.length; i++) subs[i](data);
  }

  /* The context every module is built from. Later modules read what earlier
   * ones put here, and a couple of late bindings (checkLevel) let the NPCs
   * call back into level flow that is defined further down. */
  var ctx = {
    cfg: cfg, rand: rand, half: half, state: state, emit: emit,
    scene: scene, camera: camera, viewCamera: viewCamera, renderer: renderer,
    yawObj: yawObj, pitchObj: pitchObj, VIEW_LAYER: VIEW_LAYER,
    lights: [sun, hemi, ambient],
    targetGeo: new THREE.IcosahedronGeometry(0.62, 0),
    shardGeo: new THREE.TetrahedronGeometry(0.2, 0),
    checkLevel: function () { return checkLevel(); },
  };

  var world = PB.createWorld(ctx);
  var colliders = ctx.colliders = world.colliders;
  var solidMeshes = ctx.solidMeshes = world.solidMeshes;
  var obstacleBoxes = ctx.obstacleBoxes = world.obstacleBoxes;
  var obstacleMeshes = world.obstacleMeshes;
  var wallMeshes = world.wallMeshes;
  var floor = ctx.floor = world.floor;

  var fx = ctx.fx = PB.createEffects(ctx);
  var indicators = fx.indicators;
  var indicatorPool = fx.indicatorPool;
  var shardPool = fx.shardPool;
  var flashPool = fx.flashPool;
  var debris = fx.debris;
  var addScore = ctx.addScore = fx.addScore;
  var spawnIndicator = fx.spawnIndicator;

  var T = PB.createTargets(ctx);
  var targets = T.targets;
  var spawnTarget = T.spawnTarget;
  var spawnTargets = T.spawnTargets;
  var moveTarget = T.moveTarget;
  var breakTarget = T.breakTarget;
  var aliveCount = T.aliveCount;

  var weapon = cfg.headless ? PB.stubWeapon(ctx) : PB.createWeapon(ctx);
  var gun = weapon.gun;
  var magazine = weapon.magazine;
  var MAG_HOME = weapon.MAG_HOME;
  var GUN_HOME = weapon.GUN_HOME;
  var GUN_SIGHTED = weapon.GUN_SIGHTED;
  var muzzle = weapon.muzzle;
  var muzzleFlash = weapon.muzzleFlash;
  var muzzleLight = weapon.muzzleLight;

  var N = PB.createNPCs(ctx);
  var npcs = N.npcs;
  var makeNPC = N.makeNPC;
  var placeNPC = N.placeNPC;
  var npcsAlive = N.npcsAlive;
  var knockDownNPC = N.knockDownNPC;
  var updateNPCs = N.updateNPCs;

  var sfx = PB.createAudio(ctx);

  /* ------------------------------------------------------------ bullets */
  var bullets = [];
  var bulletGeo = new THREE.SphereGeometry(0.05, 6, 5);
  var bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0 });
  var tracerGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 5);
  var tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.6 });

  var raycaster = new THREE.Raycaster();

  // Shots are resolved by a ray from the crosshair the instant they are fired,
  // so they always land where the player is aiming. The bullet mesh then flies
  // from the muzzle to that point purely as a visual.
  function traceShot(from, dir) {
    raycaster.set(from, dir);
    raycaster.far = 300;
    var live = targets.filter(function (t) { return t.alive; }).map(function (t) { return t.mesh; });
    var tHit = live.length ? raycaster.intersectObjects(live, false)[0] : null;
    var sHit = raycaster.intersectObjects(solidMeshes, false)[0];

    if (tHit && (!sHit || tHit.distance < sHit.distance)) {
      var owner = null;
      for (var i = 0; i < targets.length; i++) if (targets[i].mesh === tHit.object) owner = targets[i];
      return { point: tHit.point.clone(), target: owner, distance: tHit.distance };
    }
    if (sHit) {
      if (sHit.object.userData.npc) {
        return { point: sHit.point.clone(), npc: sHit.object.userData.npc, distance: sHit.distance };
      }
      var n = sHit.face
        ? sHit.face.normal.clone().transformDirection(sHit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      return { point: sHit.point.clone(), normal: n, object: sHit.object, distance: sHit.distance };
    }
    return { point: from.clone().addScaledVector(dir, 300), distance: 300 };
  }

  function fireBullet(origin, hit) {
    var core = new THREE.Mesh(bulletGeo, bulletMat);
    var tracer = new THREE.Mesh(tracerGeo, tracerMat);
    tracer.scale.y = 2.2;
    tracer.rotation.x = Math.PI / 2;
    tracer.position.z = 1.1;
    core.add(tracer);
    core.position.copy(origin);
    core.lookAt(hit.point);
    core.name = 'bullet';
    scene.add(core);
    bullets.push({
      mesh: core,
      dir: hit.point.clone().sub(origin).normalize(),
      remaining: origin.distanceTo(hit.point),
      hit: hit,
    });
    return core;
  }

  var impactGeo = new THREE.CircleGeometry(0.09, 8);
  var impacts = [];
  var decalPool = [];
  var nextDecal = 0;

  for (var dp = 0; dp < 40; dp++) {
    var decal = new THREE.Mesh(impactGeo, new THREE.MeshBasicMaterial({
      color: 0x11151b, transparent: true, opacity: 0.85,
    }));
    decal.visible = false;
    decal.name = 'impact';
    scene.add(decal);
    decalPool.push(decal);
  }

  var _look = new THREE.Vector3();

  function addImpact(point, normal) {
    var d = decalPool[nextDecal];
    nextDecal = (nextDecal + 1) % decalPool.length;

    // if this decal is still in the live list, retire it first
    for (var i = 0; i < impacts.length; i++) {
      if (impacts[i].mesh === d) { impacts.splice(i, 1); break; }
    }

    d.visible = true;
    d.material.opacity = 0.85;
    d.position.copy(point).addScaledVector(normal, 0.012);
    d.lookAt(_look.copy(point).add(normal));
    impacts.push({ mesh: d, life: 9 });
  }

  /* -------------------------------------------------------------- input */
  var keys = Object.create(null);
  var firing = false;

  function onKeyDown(e) {
    keys[e.code] = true;
    if (e.code === 'KeyR') reload();
    if (e.code === 'Space' && state.active) e.preventDefault();
  }
  function onKeyUp(e) { keys[e.code] = false; }
  function onMouseDown(e) {
    if (!state.active) return;
    if (e.button === 0) firing = true;
    if (e.button === 2) { zooming = true; e.preventDefault(); }
  }
  function onMouseUp(e) {
    if (e.button === 0) firing = false;
    if (e.button === 2) zooming = false;
  }
  function onContextMenu(e) { if (state.active) e.preventDefault(); }
  /* ------------------------------------------------------------- looking */
  /* Every write to the view angles goes through applyLook/setPitch so the
   * pitch limit can never be bypassed, and so the debug log sees everything
   * that moved the camera. Turn the log on with game.setLookDebug(true) and
   * read it back with game.lookStats(). */
  var LOOK_SENS = 0.0022;              // radians per pixel
  var PITCH_LIMIT = Math.PI / 2 - 0.01;
  var SPIKE_PX = cfg.lookSpikePx;      // one event this big is not a hand movement
  var swallowFirstMove = false;

  var lookDebug = false;
  var lookLog = [];
  var LOOK_LOG_MAX = 600;

  var lastLookAt = 0;

  function logLook(kind, dx, dy) {
    if (!lookDebug) return;
    var now = global.performance ? performance.now() : Date.now();
    lookLog.push({
      t: +now.toFixed(1),
      gap: lastLookAt ? +(now - lastLookAt).toFixed(1) : 0,
      kind: kind, dx: dx, dy: dy,
      yaw: +yawObj.rotation.y.toFixed(5),
      pitch: +pitchObj.rotation.x.toFixed(5),
    });
    lastLookAt = now;
    if (lookLog.length > LOOK_LOG_MAX) lookLog.shift();
  }

  function setPitch(v) {
    pitchObj.rotation.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, v));
  }

  // dx, dy are raw pixel deltas. Returns false if the sample was rejected.
  function applyLook(dx, dy) {
    dx = dx || 0;
    dy = dy || 0;

    // The first sample after the pointer locks carries the jump from wherever
    // the cursor happened to be, and re-entering an unlocked window produces
    // the same kind of jump. Both are indistinguishable from a violent flick,
    // so anything past human range is dropped rather than clamped — clamping
    // still turns the view, just less far.
    if (swallowFirstMove) {
      swallowFirstMove = false;
      logLook('swallow', dx, dy);
      return false;
    }
    if (!isFinite(dx) || !isFinite(dy)) {
      logLook('nonfinite', dx, dy);
      return false;                 // one NaN would poison the angle for good
    }
    var mag = Math.max(Math.abs(dx), Math.abs(dy));
    if (mag > SPIKE_PX) {
      state.lookSpikes++;
      logLook('spike', dx, dy);
      if (lookDebug && global.console) {
        console.warn('[look] dropped a ' + mag + 'px jump (dx=' + dx + ', dy=' + dy + ')');
      }
      return false;
    }
    if (mag > state.maxLookDelta) state.maxLookDelta = mag;

    // scale with the lens so sighted aim is as fine as the picture is close
    var sens = LOOK_SENS * (camera.fov / cfg.fov);
    yawObj.rotation.y -= dx * sens;
    setPitch(pitchObj.rotation.x - dy * sens);
    logLook('move', dx, dy);
    return true;
  }

  function onMouseMove(e) {
    if (!state.active) return;
    applyLook(e.movementX, e.movementY);
  }

  function bindInput(target) {
    var t = target || global;
    t.addEventListener('keydown', onKeyDown);
    t.addEventListener('keyup', onKeyUp);
    t.addEventListener('mousedown', onMouseDown);
    t.addEventListener('mouseup', onMouseUp);
    t.addEventListener('mousemove', onMouseMove);
    t.addEventListener('contextmenu', onContextMenu);
    global.addEventListener('resize', resize);
  }
  function unbindInput(target) {
    var t = target || global;
    t.removeEventListener('keydown', onKeyDown);
    t.removeEventListener('keyup', onKeyUp);
    t.removeEventListener('mousedown', onMouseDown);
    t.removeEventListener('mouseup', onMouseUp);
    t.removeEventListener('mousemove', onMouseMove);
    t.removeEventListener('contextmenu', onContextMenu);
    global.removeEventListener('resize', resize);
  }

  /* ------------------------------------------------------------ actions */
  // Reloading runs on game time rather than a timer, so it stays in step with
  // the animation and behaves the same when the simulation is stepped by hand.
  function reload() {
    if (state.reloading || state.mag === cfg.magSize) return false;
    state.reloading = true;
    state.reloadT = 0;
    emit('reloadStart', {});
    sfx.reload();
    return true;
  }

  function updateReload(dt) {
    if (!state.reloading) {
      state.reloadT = 0;
      return;
    }
    state.reloadT = Math.min(1, state.reloadT + dt / (cfg.reloadMs / 1000));
    if (state.reloadT >= 1) {
      state.mag = cfg.magSize;
      state.reloading = false;
      state.reloadT = 0;
      emit('reloadEnd', {});
      emit('ammo', { mag: state.mag, size: cfg.magSize });
    }
  }

  // 0 while seated, 1 while fully dropped clear of the gun
  function magOffset(p) {
    if (p < 0.12) return 0;
    if (p < 0.32) return (p - 0.12) / 0.20;          // pull the old magazine out
    if (p < 0.60) return 1;                          // empty
    if (p < 0.82) return 1 - (p - 0.60) / 0.22;      // slap the new one home
    return 0;
  }

  function animateReload() {
    var p = state.reloadT;
    if (!state.reloading) {
      magazine.position.copy(MAG_HOME);
      magazine.rotation.set(0, 0, 0);
      return 0;
    }
    var drop = magOffset(p);
    magazine.position.set(
      MAG_HOME.x - drop * 0.02,
      MAG_HOME.y - drop * 0.30,
      MAG_HOME.z + drop * 0.03
    );
    magazine.rotation.z = drop * 0.5;
    magazine.rotation.x = drop * 0.25;
    return Math.sin(p * Math.PI);                    // how far the gun is lowered
  }

  var _fwd = new THREE.Vector3();
  var _eye = new THREE.Vector3();
  var _origin = new THREE.Vector3();

  function shoot() {
    var now = state.elapsed * 1000;
    if (state.reloading || now - state.lastShot < cfg.fireMs) return null;
    if (state.mag <= 0) {
      if (now - state.lastShot > 300) {
        sfx.empty();
        state.lastShot = now;
        emit('empty', {});
        reload();
      }
      return null;
    }
    state.lastShot = now;
    state.mag--;
    state.shotsFired++;
    sfx.shoot();
    emit('ammo', { mag: state.mag, size: cfg.magSize });
    emit('shoot', { mag: state.mag });

    yawObj.updateMatrixWorld(true);
    camera.getWorldDirection(_fwd);
    camera.getWorldPosition(_eye);
    muzzle.getWorldPosition(_origin);

    var hit = traceShot(_eye, _fwd);
    var mesh = fireBullet(_origin, hit);

    state.recoil = 1;
    state.kick = 1;
    muzzleFlash.material.opacity = 1;
    muzzleFlash.scale.setScalar(0.8 + rand() * 0.7);
    muzzleLight.intensity = 6;

    return { hit: hit, mesh: mesh };
  }

  /* -------------------------------------------------------------- levels */
  /* A level is over when every NPC has been put down. Targets are optional
   * score on the side and do not come back once shot. */

  function clearLevel() {
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.mesh.parent) scene.remove(t.mesh);
      t.mesh.material.dispose();
      t.halo.material.dispose();
      t.alive = false;
    }
    targets.length = 0;

    for (var n = 0; n < npcs.length; n++) {
      var npc = npcs[n];
      scene.remove(npc.root);
      npc.root.traverse(function (o) { if (o.isMesh) o.material.dispose(); });
      var idx = solidMeshes.indexOf(npc.hitbox);
      if (idx !== -1) solidMeshes.splice(idx, 1);
    }
    npcs.length = 0;

    for (var d = debris.length - 1; d >= 0; d--) debris[d].mesh.visible = false;
    debris.length = 0;

    // stray rounds must not resolve against the level that just ended
    for (var b = bullets.length - 1; b >= 0; b--) scene.remove(bullets[b].mesh);
    bullets.length = 0;
  }

  function startLevel(level) {
    state.level = level;
    clearLevel();
    spawnTargets();
    var count = cfg.npcsPerLevel + (level - 1);
    for (var i = 0; i < count; i++) npcs.push(makeNPC(i));
    emit('level', {
      level: state.level, npcs: npcsAlive(), targets: aliveCount(), complete: false,
    });
    return { npcs: npcsAlive(), targets: aliveCount() };
  }

  function checkLevel() {
    if (npcsAlive() > 0) return false;
    addScore(cfg.scoreLevelBonus, null);
    emit('levelComplete', { level: state.level, score: state.score });
    sfx.wave();
    startLevel(state.level + 1);
    return true;
  }

  /* ------------------------------------------------------------ physics */
  var _tmpBox = new THREE.Box3();
  var _min = new THREE.Vector3();
  var _max = new THREE.Vector3();
  var _c1 = new THREE.Vector3();
  var _c2 = new THREE.Vector3();

  function playerBox(pos, out) {
    _min.set(pos.x - cfg.radius, pos.y - cfg.eye, pos.z - cfg.radius);
    _max.set(pos.x + cfg.radius, pos.y - cfg.eye + cfg.playerHeight, pos.z + cfg.radius);
    return out.set(_min, _max);
  }

  function resolveCollisions(pos) {
    playerBox(pos, _tmpBox);
    for (var i = 0; i < colliders.length; i++) {
      var box = colliders[i];
      if (!_tmpBox.intersectsBox(box)) continue;

      var ox = Math.min(_tmpBox.max.x - box.min.x, box.max.x - _tmpBox.min.x);
      var oy = Math.min(_tmpBox.max.y - box.min.y, box.max.y - _tmpBox.min.y);
      var oz = Math.min(_tmpBox.max.z - box.min.z, box.max.z - _tmpBox.min.z);

      _tmpBox.getCenter(_c1);
      box.getCenter(_c2);

      if (oy <= ox && oy <= oz) {
        if (_c1.y > _c2.y) {
          pos.y += oy;
          if (state.vy < 0) { state.vy = 0; state.grounded = true; }
        } else {
          pos.y -= oy;
          if (state.vy > 0) state.vy = 0;
        }
      } else if (ox < oz) {
        pos.x += _c1.x > _c2.x ? ox : -ox;
      } else {
        pos.z += _c1.z > _c2.z ? oz : -oz;
      }
      playerBox(pos, _tmpBox);
    }
  }

  var _wish = new THREE.Vector3();
  var UP = new THREE.Vector3(0, 1, 0);

  function movePlayer(dt) {
    _wish.set(0, 0, 0);
    if (keys['KeyW']) _wish.z -= 1;
    if (keys['KeyS']) _wish.z += 1;
    if (keys['KeyA']) _wish.x -= 1;
    if (keys['KeyD']) _wish.x += 1;

    var moving = _wish.lengthSq() > 0;
    if (moving) _wish.normalize().applyAxisAngle(UP, yawObj.rotation.y);

    var maxSpeed = (keys['ShiftLeft'] || keys['ShiftRight']) ? cfg.sprint : cfg.speed;
    var v = state.vel;

    if (moving) {
      v.addScaledVector(_wish, cfg.accel * dt);
      var sp = Math.hypot(v.x, v.z);
      if (sp > maxSpeed) { v.x *= maxSpeed / sp; v.z *= maxSpeed / sp; }
    } else {
      var drop = Math.max(0, 1 - cfg.friction * dt);
      v.x *= drop; v.z *= drop;
      if (Math.hypot(v.x, v.z) < 0.02) { v.x = 0; v.z = 0; }
    }

    if (keys['Space'] && state.grounded) {
      state.vy = cfg.jump;
      state.grounded = false;
    }
    state.vy -= cfg.gravity * dt;

    var p = state.pos;
    p.x += v.x * dt;
    p.z += v.z * dt;
    p.y += state.vy * dt;

    state.grounded = false;
    if (p.y < cfg.eye) { p.y = cfg.eye; state.vy = 0; state.grounded = true; }

    resolveCollisions(p);

    var lim = half - 1 - cfg.radius;
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));

    var speed = Math.hypot(v.x, v.z);
    state.bob += dt * speed * 1.35;
    var amp = Math.min(1, speed / cfg.speed);
    var bobY = state.grounded ? Math.sin(state.bob * 2) * 0.035 * amp : 0;
    var bobX = state.grounded ? Math.cos(state.bob) * 0.028 * amp : 0;

    yawObj.position.set(p.x, p.y + bobY, p.z);
    state.bobX = bobX;
    state.bobY = bobY;
  }

  // Runs every frame, paused or not, so a reload animates to completion.
  function poseGun() {
    var dip = animateReload();
    var z = state.zoom * state.zoom * (3 - 2 * state.zoom);   // same ease as the lens
    var bobX = state.bobX * (1 - z * 0.8);                    // steadier when sighted
    var bobY = state.bobY * (1 - z * 0.8);

    var hx = GUN_HOME.x + (GUN_SIGHTED.x - GUN_HOME.x) * z;
    var hy = GUN_HOME.y + (GUN_SIGHTED.y - GUN_HOME.y) * z;
    var hz = GUN_HOME.z + (GUN_SIGHTED.z - GUN_HOME.z) * z;

    gun.position.set(
      hx - bobX * 0.5 + dip * 0.05,
      hy - bobY * 0.6 - state.recoil * 0.02 - dip * 0.13,
      hz + state.recoil * 0.09 + dip * 0.06
    );
    gun.rotation.x = state.recoil * 0.22 - dip * 0.50;   // muzzle dips while reloading
    gun.rotation.z = -bobX * 0.25 + dip * 0.45;
    gun.rotation.y = (0.03 - dip * 0.18) * (1 - z);      // square up to the sights
  }

  function updateBullets(dt) {
    // Resolving a hit can end the level, which clears this very array, so the
    // loop re-checks the entry and removes by identity rather than by index.
    for (var i = bullets.length - 1; i >= 0; i--) {
      var b = bullets[i];
      if (!b) continue;
      var step = cfg.bulletSpeed * dt;

      if (step < b.remaining) {
        b.mesh.position.addScaledVector(b.dir, step);
        b.remaining -= step;
        continue;
      }

      var h = b.hit;
      if (h.target && h.target.alive) {
        var where = h.target.mesh.position.clone();
        breakTarget(h.target, b.dir);
        addScore(cfg.scoreTarget, where);
        emit('hit', { target: h.target, score: state.score, left: aliveCount() });
        sfx.hit();
      } else if (h.npc && h.npc.alive) {
        knockDownNPC(h.npc);
        emit('hit', { npc: h.npc, score: state.score, left: aliveCount() });
        sfx.hit();
      } else {
        // hit nothing worth hitting: a wall, the floor, a body, or thin air
        if (h.normal) addImpact(h.point, h.normal);
        addScore(cfg.scoreMiss, h.point);
        emit('miss', { point: h.point, score: state.score });
        sfx.miss();
      }
      scene.remove(b.mesh);
      var at = bullets.indexOf(b);
      if (at !== -1) bullets.splice(at, 1);
    }
  }

  var _camWorld = new THREE.Vector3();

  function updateFx(dt) {
    camera.getWorldPosition(_camWorld);

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!t.alive) continue;
      t.phase += dt;
      if (!state.networked) moveTarget(t, dt);
      if (!state.networked) t.mesh.position.y = t.base + Math.sin(t.phase * 1.6) * 0.22;
      t.mesh.rotation.y += dt * 0.9;
      t.mesh.rotation.x += dt * 0.35;
      t.halo.lookAt(_camWorld);
      t.mesh.updateMatrixWorld(true);   // shots raycast against this same frame
    }

    fx.updateIndicators(dt);
    fx.updateDebris(dt);
    fx.updateFlashes(dt);

    for (var k = impacts.length - 1; k >= 0; k--) {
      var im = impacts[k];
      im.life -= dt;
      if (im.life < 2) im.mesh.material.opacity = Math.max(0, (im.life / 2) * 0.85);
      if (im.life <= 0) {
        im.mesh.visible = false;
        impacts.splice(k, 1);
      }
    }

    muzzleFlash.material.opacity = Math.max(0, muzzleFlash.material.opacity - dt * 12);
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 45);
    state.recoil = Math.max(0, state.recoil - dt * 7);

    // muzzle climb, then settle back to where the player was aiming
    if (state.kick > 0) {
      // Clamped like every other write to pitch: an unclamped += here used to
      // push the view past vertical when firing while looking up, and the
      // camera flipped over.
      var climb = state.kick * dt * 0.55;
      var beforeClimb = pitchObj.rotation.x;
      setPitch(beforeClimb + climb);
      state.kickBack += pitchObj.rotation.x - beforeClimb;   // only what landed
      state.kick = Math.max(0, state.kick - dt * 9);
    } else if (state.kickBack > 0) {
      var back = Math.min(state.kickBack, dt * 0.45);
      setPitch(pitchObj.rotation.x - back);
      state.kickBack -= back;
    }
  }

  // Ease the lens between hip and sighted, and tell anyone who cares.
  function updateZoom(dt) {
    var want = (zooming && state.active) ? 1 : 0;
    if (state.zoom === want) return;
    var stepSize = dt / cfg.zoomTime;
    var before = state.zoom;
    state.zoom = want > state.zoom
      ? Math.min(want, state.zoom + stepSize)
      : Math.max(want, state.zoom - stepSize);
    // smoothstep so it settles rather than stopping dead
    var e = state.zoom * state.zoom * (3 - 2 * state.zoom);
    camera.fov = cfg.fov + (cfg.zoomFov - cfg.fov) * e;
    camera.updateProjectionMatrix();
    if ((before === 0) !== (state.zoom === 0) || (before === 1) !== (state.zoom === 1)) {
      emit('zoom', { zoom: state.zoom, sighted: state.zoom === 1 });
    }
  }

  function update(dt) {
    state.elapsed += dt;
    updateZoom(dt);
    if (state.active) {
      movePlayer(dt);
      if (firing) shoot();
    }
    updateReload(dt);
    if (!state.networked) updateNPCs(dt);
    updateBullets(dt);
    updateFx(dt);
    poseGun();
    emit('frame', dt);
  }

  function render() {
    if (!renderer) return;
    camera.layers.set(0);
    renderer.render(scene, camera);

    // Second pass for the viewmodel. scene.background must be detached first:
    // three.js force-clears the colour buffer whenever a background colour is
    // set, even with autoClear off, which would wipe the world we just drew.
    var bg = scene.background;
    scene.background = null;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, viewCamera);
    renderer.autoClear = true;
    scene.background = bg;
  }

  var rafId = null, last = 0, running = false;
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dt > 0) update(dt);
    render();
  }
  function start() {
    if (cfg.headless) return;        // the server drives update() on its own clock
    if (running) return;
    running = true;
    last = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* --------------------------------------------------------- test hooks */
  // Point the camera at a world position (used by tests and never by play).
  function aimAt(target) {
    var eye = new THREE.Vector3();
    yawObj.updateMatrixWorld(true);
    camera.getWorldPosition(eye);
    var d = target.clone().sub(eye);
    yawObj.rotation.y = Math.atan2(-d.x, -d.z);
    setPitch(Math.asin(THREE.MathUtils.clamp(d.clone().normalize().y, -1, 1)));
    yawObj.updateMatrixWorld(true);
  }
  function teleport(x, y, z) {
    state.pos.set(x, y === undefined ? cfg.eye : y, z);
    state.vel.set(0, 0, 0);
    state.vy = 0;
    yawObj.position.copy(state.pos);
    yawObj.updateMatrixWorld(true);
  }
  function hasLineOfSight(from, to) {
    var dir = to.clone().sub(from);
    var dist = dir.length();
    dir.normalize();
    raycaster.set(from, dir);
    raycaster.far = dist - 0.7;
    return raycaster.intersectObjects(solidMeshes, false).length === 0;
  }
  function dispose() {
    stop();
    unbindInput();
    if (!renderer) return;
    renderer.dispose();
    var ext = renderer.getContext().getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  var api = {
    cfg: cfg, scene: scene, camera: camera, renderer: renderer,
    yawObj: yawObj, pitchObj: pitchObj, gun: gun, muzzle: muzzle, muzzleFlash: muzzleFlash,
    state: state, targets: targets, bullets: bullets, debris: debris, impacts: impacts,
    npcs: npcs, magazine: magazine, viewCamera: viewCamera, flashPool: flashPool,
    shardPool: shardPool, decalPool: decalPool,
    indicators: indicators, indicatorPool: indicatorPool,
    colliders: colliders, obstacleBoxes: obstacleBoxes, obstacleMeshes: obstacleMeshes,
    wallMeshes: wallMeshes, floor: floor, solidMeshes: solidMeshes, keys: keys,

    on: on, emit: emit, start: start, stop: stop, update: update, render: render,
    shoot: shoot, reload: reload, spawnTargets: spawnTargets, spawnTarget: spawnTarget,
    startLevel: startLevel, checkLevel: checkLevel, clearLevel: clearLevel,
    npcsAlive: npcsAlive, addScore: addScore, spawnIndicator: spawnIndicator,
    moveTarget: moveTarget, makeNPC: makeNPC,
    traceShot: traceShot, aliveCount: aliveCount, movePlayer: movePlayer,
    updateNPCs: updateNPCs, knockDownNPC: knockDownNPC, placeNPC: placeNPC, poseGun: poseGun,
    applyLook: applyLook, setPitch: setPitch,
    setLookDebug: function (on) { lookDebug = !!on; if (!on) lookLog.length = 0; },
    lookLog: function () { return lookLog.slice(); },
    lookStats: function () {
      var maxStep = 0, worst = null;
      for (var i = 1; i < lookLog.length; i++) {
        var d = Math.max(Math.abs(lookLog[i].yaw - lookLog[i - 1].yaw),
                         Math.abs(lookLog[i].pitch - lookLog[i - 1].pitch));
        if (d > maxStep) { maxStep = d; worst = lookLog[i]; }
      }
      return {
        samples: lookLog.length,
        spikes: state.lookSpikes,
        maxEventPx: state.maxLookDelta,
        maxAngleStep: +maxStep.toFixed(5),
        worst: worst,
        pitchLimit: PITCH_LIMIT,
        sensitivity: LOOK_SENS,
        spikeThresholdPx: SPIKE_PX,
      };
    },
    updateBullets: updateBullets, updateFx: updateFx, resize: resize,
    bindInput: bindInput, unbindInput: unbindInput, dispose: dispose,
    aimAt: aimAt, teleport: teleport, hasLineOfSight: hasLineOfSight, playerBox: playerBox,

    setActive: function (v) {
      if (v && !state.active) swallowFirstMove = true;
      state.active = !!v;
      if (!v) { firing = false; zooming = false; }
    },
    isActive: function () { return state.active; },
    setFiring: function (v) { firing = !!v; },
    isFiring: function () { return firing; },
    setNetworked: function (v) { state.networked = !!v; },
    isNetworked: function () { return state.networked; },
    setZooming: function (v) { zooming = !!v; },
    isZooming: function () { return zooming; },
    setKey: function (code, down) { keys[code] = !!down; },
    domElement: renderer ? renderer.domElement : null,
    viewLayer: VIEW_LAYER,
  };

  startLevel(1);
  yawObj.position.copy(state.pos);
  emit('ammo', { mag: state.mag, size: cfg.magSize });

  /* Compile every shader up front.
   *
   * three.js builds a material's program the first time it is actually drawn.
   * The debris shards are hidden until something breaks, so the first break
   * paid for the compile mid-frame — a very visible hitch. Showing the pooled
   * objects for one compile pass moves that cost to load time. */
  (function warmUpShaders() {
    if (!renderer) return;
    var hidden = [];
    scene.traverse(function (o) {
      if ((o.isMesh || o.isSprite) && o.visible === false) { hidden.push(o); o.visible = true; }
    });
    try {
      renderer.compile(scene, camera);
      renderer.compile(scene, viewCamera);
      // A real frame as well: renderer.compile skips the shadow pass, and the
      // depth materials for new shadow casters are just as expensive to build.
      renderer.render(scene, camera);
      renderer.render(scene, viewCamera);
    } catch (e) { /* warming up is an optimisation, never fatal */ }
    for (var i = 0; i < hidden.length; i++) hidden[i].visible = false;
  })();

  return api;
}

global.createGame = createGame;
global.PAINTBALL_DEFAULTS = DEFAULTS;

})(typeof window !== 'undefined' ? window : globalThis);
