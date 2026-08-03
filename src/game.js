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
  jump: 10.4,               // enough to land on the low cover, roughly 2.1u up
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
  scoreKill: 1000,

  playerHealth: 10,           // hits a player can take
  healEvery: 2,               // seconds per point of health recovered
  respawnDelay: 2.5,          // seconds on the floor before coming back
  spawnShield: 3,             // seconds of protection on coming back

  medkits: 2,                 // health packs standing in the arena
  medkitRespawn: 25,          // seconds before a used one comes back
  medkitRadius: 1.4,
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
  sensitivity: 1.0,           // multiplier on the base look speed
  invertY: false,

  balconyHeight: 3.4,
  balconyWidth: 26,
  balconyDepth: 7,
  stepHeight: 0.45,           // how high a ledge can be and still be walked up
  movingObstacles: 4,

  perks: true,
  perkEvery: 12,              // seconds between spawn attempts
  perkMax: 3,                 // how many may be out at once
  perkLife: 26,               // how long one waits to be collected
  perkDuration: 15,           // how long its effect lasts
  perkRadius: 1.3,
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
    worldTime: 0, airJumps: 0, standingOn: null,
    health: 0, maxHealth: 0, dead: false, shield: 0,

    /* Everything worth bragging about. Distance is kept in world units and
     * converted on the way out — the arena is metric, a unit is a metre. */
    stats: {
      shotsFired: 0, shotsHit: 0, misses: 0,
      targetsBroken: 0, npcsDown: 0,
      distance: 0, jumps: 0, reloads: 0,
      levelsCleared: 0, timePlayed: 0, timeSighted: 0,
      bestStreak: 0, streak: 0, kills: 0, deaths: 0,
      longestShot: 0, bestScore: 0,
    },
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
  var arenaFingerprint = world.fingerprint;
  var movers = ctx.movers = world.movers;
  var balcony = ctx.balcony = world.balcony;
  var medkits = ctx.medkits = world.medkits;
  ctx.remoteHitboxes = [];        // net.js fills this as players appear

  var fx = ctx.fx = PB.createEffects(ctx);
  var indicators = fx.indicators;
  var indicatorPool = fx.indicatorPool;
  var shardPool = fx.shardPool;
  var flashPool = fx.flashPool;
  var debris = fx.debris;
  var addScore = ctx.addScore = fx.addScore;
  var spawnIndicator = fx.spawnIndicator;

  var T = PB.createTargets(ctx);
  var targets = ctx.targets = T.targets;
  var spawnTarget = T.spawnTarget;
  var spawnTargets = T.spawnTargets;
  var moveTarget = T.moveTarget;
  var breakTarget = T.breakTarget;
  var reviveTarget = T.reviveTarget;
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

  var debugView = cfg.headless ? null : PB.createDebug(ctx);
  var perkSystem = PB.createPerks(ctx);
  var sfx = PB.createAudio(ctx);

  /* Perks change the rules while they last, so anything they touch has to ask
   * rather than read the config directly. */
  function fireInterval() { return cfg.fireMs * perkSystem.factor(state, 'fireRate'); }
  function walkSpeed() { return cfg.speed * perkSystem.factor(state, 'speed'); }
  function runSpeed() { return cfg.sprint * perkSystem.factor(state, 'speed'); }
  function magSize() { return Math.round(cfg.magSize * perkSystem.factor(state, 'clip')); }
  function airJumpsAllowed() { return perkSystem.bonus(state, 'airJumps'); }

  /* Put the static geometry into world space once, up front.
   *
   * three.js only refreshes world matrices while rendering. Headless never
   * renders, so without this the floor and every piece of cover keep an
   * identity matrix — unrotated and stacked at the origin — and every
   * server-side raycast hits phantom geometry instead of the real arena. */
  scene.updateMatrixWorld(true);

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
  var LOOK_BASE = 0.0022;              // radians per pixel at sensitivity 1
  var LOOK_SENS = LOOK_BASE * cfg.sensitivity;
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
    setPitch(pitchObj.rotation.x - (cfg.invertY ? -dy : dy) * sens);
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
    if (state.reloading || state.mag >= magSize()) return false;
    state.reloading = true;
    state.reloadT = 0;
    state.stats.reloads++;
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
      state.mag = magSize();
      state.reloading = false;
      state.reloadT = 0;
      emit('reloadEnd', {});
      emit('ammo', { mag: state.mag, size: magSize() });
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
    if (state.reloading || now - state.lastShot < fireInterval()) return null;
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
    state.stats.shotsFired++;
    sfx.shoot();
    emit('ammo', { mag: state.mag, size: magSize() });
    emit('shoot', { mag: state.mag });

    yawObj.updateMatrixWorld(true);
    camera.getWorldDirection(_fwd);
    camera.getWorldPosition(_eye);
    muzzle.getWorldPosition(_origin);

    var hit = traceShot(_eye, _fwd);
    var mesh = fireBullet(_origin, hit);
    if (state.networked) {
      emit('shotFired', {
        origin: { x: _eye.x, y: _eye.y, z: _eye.z },
        dir: { x: _fwd.x, y: _fwd.y, z: _fwd.z },
      });
    }

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
    /* Put what we just spawned into world space. Shots are raycast against
     * these meshes, and the first frame is what would otherwise do it — which
     * is fine in a browser and not fine on a server, where a round can be
     * adjudicated before any frame has been drawn. applyLevel already did
     * this; the offline path did not. */
    scene.updateMatrixWorld(true);
    if (debugView) debugView.refresh();
    emit('level', {
      level: state.level, npcs: npcsAlive(), targets: aliveCount(), complete: false,
    });
    return { npcs: npcsAlive(), targets: aliveCount() };
  }

  // The level is over when the arena is clear: every NPC down and every
  // target broken. Either one alone leaves work to do.
  /* Rebuild the level from a description rather than from our own RNG.
   *
   * A networked client cannot generate the next level itself: its random
   * stream has long since diverged from the server's. Without this the client
   * keeps playing the level it built at boot while the server has moved on —
   * new targets land on already-broken ones and never appear, and any NPC the
   * server added exists only as an invisible thing that stops bullets. */
  function applyLevel(desc) {
    clearLevel();
    /* Online the server decides when a level is done, so checkLevel never runs
     * here and nothing was counting the levels this player saw through. Moving
     * up is the same achievement either way — as long as we were already in
     * the level being left, rather than joining partway through someone
     * else's match. */
    if (state.networked && desc.level === state.level + 1) {
      state.stats.levelsCleared++;
      emit('levelComplete', { level: state.level, score: state.score });
    }
    state.level = desc.level;
    for (var i = 0; i < desc.targets.length; i++) {
      var t = desc.targets[i];
      spawnTarget(t[0], t[1], t[2], !!t[3]);
    }
    for (var n = 0; n < desc.npcs; n++) npcs.push(makeNPC(n));
    scene.updateMatrixWorld(true);
    if (debugView) debugView.refresh();
    emit('level', {
      level: state.level, npcs: npcsAlive(), targets: aliveCount(), complete: false,
    });
    return { targets: aliveCount(), npcs: npcsAlive() };
  }

  function checkLevel() {
    if (npcsAlive() > 0 || aliveCount() > 0) return false;
    state.stats.levelsCleared++;
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

      /* Step up rather than being stopped dead.
       *
       * Without this, box-against-box resolution pushes the player back
       * horizontally off anything at all, so a staircase is a wall and the
       * balcony can only be reached by jumping. If the ledge is low enough
       * and there is headroom above it, stand on it instead. */
      var feet = pos.y - cfg.eye;
      var rise = box.max.y - feet;
      // allowed while rising too: a player jumping at a crate should get up
      // onto it rather than being shoved off the side on the way up
      if (rise > 0.01 && rise <= cfg.stepHeight) {
        var headroom = true;
        for (var j = 0; j < colliders.length; j++) {
          if (j === i) continue;
          var other = colliders[j];
          if (other.max.y <= box.max.y + 0.05) continue;
          if (other.min.y > box.max.y + cfg.playerHeight) continue;
          if (pos.x + cfg.radius <= other.min.x || pos.x - cfg.radius >= other.max.x) continue;
          if (pos.z + cfg.radius <= other.min.z || pos.z - cfg.radius >= other.max.z) continue;
          headroom = false;
          break;
        }
        if (headroom) {
          pos.y = box.max.y + cfg.eye;
          if (state.vy < 0) state.vy = 0;      // never cut a jump short
          state.grounded = true;
          playerBox(pos, _tmpBox);
          continue;
        }
      }

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

  /* What the player is standing on, if it is something that moves.
   *
   * Cover slides out from under a player otherwise: they stay put in the air
   * while the crate they were on walks away. Checked against the box the
   * player is actually resting on, with a little tolerance for the gap the
   * collision resolver leaves. */
  function standsOn(mover, pos) {
    var b = mover.box;
    var feet = pos.y - cfg.eye;
    if (Math.abs(feet - b.max.y) > 0.3) return false;
    if (pos.x + cfg.radius < b.min.x || pos.x - cfg.radius > b.max.x) return false;
    if (pos.z + cfg.radius < b.min.z || pos.z - cfg.radius > b.max.z) return false;
    return true;
  }

  function supportingMover(pos) {
    // stay with whatever we are already riding while it still holds us up,
    // rather than being handed to another one that happens to pass under
    if (state.standingOn && standsOn(state.standingOn, pos)) return state.standingOn;
    for (var i = 0; i < movers.length; i++) {
      if (standsOn(movers[i], pos)) return movers[i];
    }
    return null;
  }

  var MAX_CARRY = 1.0;        // a jump in the world clock must not fling anyone

  function movePlayer(dt) {
    // ride whatever we were standing on at the end of the last frame
    var riding = state.standingOn;
    if (riding && riding.delta.lengthSq() > 0 && riding.delta.length() < MAX_CARRY) {
      state.pos.add(riding.delta);
      resolveCollisions(state.pos);        // in case it carried us into something
    }

    _wish.set(0, 0, 0);
    if (keys['KeyW']) _wish.z -= 1;
    if (keys['KeyS']) _wish.z += 1;
    if (keys['KeyA']) _wish.x -= 1;
    if (keys['KeyD']) _wish.x += 1;

    var moving = _wish.lengthSq() > 0;
    if (moving) _wish.normalize().applyAxisAngle(UP, yawObj.rotation.y);

    var maxSpeed = (keys['ShiftLeft'] || keys['ShiftRight']) ? runSpeed() : walkSpeed();
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

    /* Jumping, with the double-jump perk folded in. `jumpHeld` stops one long
     * press from spending both jumps in consecutive frames. */
    if (keys['Space']) {
      if (state.grounded) {
        state.vy = cfg.jump;
        state.grounded = false;
        state.airJumps = 0;
        state.stats.jumps++;
        state.jumpHeld = true;
      } else if (!state.jumpHeld && state.airJumps < airJumpsAllowed()) {
        state.vy = cfg.jump;
        state.airJumps++;
        state.stats.jumps++;
        state.jumpHeld = true;
        emit('doubleJump', { at: state.pos.clone() });
      }
    } else {
      state.jumpHeld = false;
    }
    state.vy -= cfg.gravity * dt;

    var p = state.pos;
    p.x += v.x * dt;
    p.z += v.z * dt;
    p.y += state.vy * dt;

    state.grounded = false;
    if (p.y < cfg.eye) {
      p.y = cfg.eye;
      state.vy = 0;
      state.grounded = true;
      state.airJumps = 0;
    }

    resolveCollisions(p);

    var lim = half - 1 - cfg.radius;
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));

    var speed = Math.hypot(v.x, v.z);
    state.stats.distance += speed * dt;
    state.bob += dt * speed * 1.35;
    var amp = Math.min(1, speed / walkSpeed());
    var bobY = state.grounded ? Math.sin(state.bob * 2) * 0.035 * amp : 0;
    var bobX = state.grounded ? Math.cos(state.bob) * 0.028 * amp : 0;

    yawObj.position.set(p.x, p.y + bobY, p.z);
    state.bobX = bobX;
    state.bobY = bobY;
    state.standingOn = state.grounded ? supportingMover(p) : null;
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
      if (state.networked) {
        // the server decides what this hit; see applyServerHit
        scene.remove(b.mesh);
        var netAt = bullets.indexOf(b);
        if (netAt !== -1) bullets.splice(netAt, 1);
        continue;
      }
      if (h.target && h.target.alive) {
        var where = h.target.mesh.position.clone();
        breakTarget(h.target, b.dir);
        recordHit(where);
        state.stats.targetsBroken++;
        addScore(cfg.scoreTarget, where);
        emit('hit', { target: h.target, score: state.score, left: aliveCount() });
        sfx.hit();
        checkLevel();                 // the last target can finish the level too
      } else if (h.npc && h.npc.alive) {
        recordHit(h.point);
        state.stats.npcsDown++;
        knockDownNPC(h.npc);
        emit('hit', { npc: h.npc, score: state.score, left: aliveCount() });
        sfx.hit();
      } else {
        // hit nothing worth hitting: a wall, the floor, a body, or thin air
        if (h.normal) addImpact(h.point, h.normal);
        state.stats.misses++;
        state.stats.streak = 0;
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
    /* The sliders run off this clock. Online it comes from the server and
     * nowhere else — advancing it locally as well let each client run its own
     * clock between snapshots, and they drifted apart by a couple of metres. */
    if (!state.networked) {
      state.worldTime += dt;
      world.updateMovers(state.worldTime);
    }
    if (state.active) {
      state.stats.timePlayed += dt;
      if (state.zoom > 0.5) state.stats.timeSighted += dt;
    }
    updateZoom(dt);
    if (state.active) {
      movePlayer(dt);
      if (firing) shoot();
    }
    updateReload(dt);
    perkSystem.tickHolder(state, dt);
    perkSystem.update(dt, state.pos);
    updateMedkits(dt);
    if (state.shield > 0) {
      state.shield = Math.max(0, state.shield - dt);
      if (state.shield === 0) emit('shieldEnd', {});
    }
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

  /* Apply an outcome the server decided.
   *
   * Everyone in the room is told about every shot, because the world has to
   * change for all of them — the target breaks, the body drops, the wall gets
   * a mark. But only the player who actually fired may have it counted: this
   * used to run the accounting for every hit anyone landed, so one player's
   * shooting quietly inflated everybody else's accuracy and streaks.
   */
  function applyServerHit(msg, mine) {
    /* A hit adjudicated on the previous level can still be in flight when the
     * next one begins. Applying it here breaks a brand new target through an
     * index that meant something else a moment ago, and because the server
     * still has that target standing it becomes invisible and unkillable. */
    if (typeof msg.level === 'number' && msg.level !== state.level) return;
    var point = msg.point
      ? new THREE.Vector3(msg.point.x, msg.point.y, msg.point.z)
      : null;
    var dir = msg.dir
      ? new THREE.Vector3(msg.dir.x, msg.dir.y, msg.dir.z)
      : new THREE.Vector3(0, 1, 0);

    if (msg.kind === 'player') {
      spawnIndicator(msg.killed ? cfg.scoreKill : 0, point);
      // recordHit counts the hit; counting it here as well is how accuracy
      // climbed past 100% — every hit on a player was worth two
      if (mine) {
        recordHit(point);
        if (msg.killed) state.stats.kills++;
        sfx.hit();
      }
      emit('hit', {
        player: msg.victim, killed: !!msg.killed,
        score: state.score, left: aliveCount(), mine: !!mine,
      });
      return;
    }

    if (msg.kind === 'target') {
      var t = targets[msg.index];
      if (t && t.alive) {
        breakTarget(t, dir);
        if (mine) { state.stats.targetsBroken++; recordHit(point); }
      }
      spawnIndicator(cfg.scoreTarget, point);
      if (mine) sfx.hit();
      emit('hit', { target: t, score: state.score, left: aliveCount(), mine: !!mine });
    } else if (msg.kind === 'npc') {
      if (mine) { state.stats.npcsDown++; recordHit(point); }
      spawnIndicator(cfg.scoreNpc, point);
      if (mine) sfx.hit();
      emit('hit', { npc: npcs[msg.index], score: state.score, left: aliveCount(), mine: !!mine });
    } else {
      if (mine) { state.stats.misses++; state.stats.streak = 0; }
      if (point && msg.normal) {
        addImpact(point, new THREE.Vector3(msg.normal.x, msg.normal.y, msg.normal.z));
      }
      if (mine) spawnIndicator(cfg.scoreMiss, point);
      emit('miss', { point: point, score: state.score, mine: !!mine });
    }
  }

  /* Someone else's round: draw the tracer travelling from their muzzle and
   * let it be heard from where they are standing. */
  function showRemoteShot(msg) {
    if (!msg.origin || !msg.point) return null;
    var from = new THREE.Vector3(msg.origin.x, msg.origin.y, msg.origin.z);
    var to = new THREE.Vector3(msg.point.x, msg.point.y, msg.point.z);
    var mesh = fireBullet(from, { point: to });
    camera.getWorldPosition(_shotFrom);
    sfx.shootAt(_shotFrom.distanceTo(from));
    return mesh;
  }

  /* ------------------------------------------------------- health packs */
  /* The pack itself is part of the seeded world, so it is already in the same
   * place on every client. What travels is only whether it is standing there
   * right now — online the server decides that, offline this does. */
  function updateMedkits(dt) {
    // readiness first, then the drawing of it: the other way round shows a
    // pack as gone for one frame after it has come back
    if (!state.networked) {
      for (var i = 0; i < medkits.length; i++) {
        var kit = medkits[i];
        if (!kit.ready && state.elapsed >= kit.backAt) kit.ready = true;
      }
    }
    world.updateMedkits(dt);
    if (state.networked) return;
    if (!state.active || state.health >= state.maxHealth) return;
    var got = world.medkitAt(state.pos.x, state.pos.z, state.pos.y - cfg.eye);
    if (got) takeMedkit(got);
  }

  function takeMedkit(kit) {
    kit.ready = false;
    kit.backAt = state.elapsed + cfg.medkitRespawn;
    setHealth(state.maxHealth || cfg.playerHealth, state.maxHealth || cfg.playerHealth);
    emit('medkit', { index: kit.index, mine: true });
    sfx.wave();
    return kit;
  }

  /* Which packs are on the ground, straight from the server. */
  function applyMedkits(list) {
    if (!list) return;
    for (var i = 0; i < medkits.length && i < list.length; i++) {
      medkits[i].ready = !!list[i];
    }
  }

  /* Our own health, as the server reports it. Nothing here decides damage —
   * the server does — this is the readout and the effects. */
  function setHealth(health, max) {
    var was = state.health;
    state.maxHealth = max || cfg.playerHealth;
    state.health = Math.max(0, Math.min(state.maxHealth, health));
    var nowDead = state.health <= 0;
    if (was !== state.health || nowDead !== state.dead) {
      if (state.health < was) emit('hurt', { health: state.health, max: state.maxHealth });
      if (nowDead && !state.dead) state.stats.deaths++;
      state.dead = nowDead;
      emit('health', { health: state.health, max: state.maxHealth, dead: state.dead });
    }
    return state.health;
  }

  /* Seconds of protection left. Set on coming back from a death, and by the
   * shield perk; nothing may hurt us while it runs. */
  function setShield(seconds) {
    var was = state.shield;
    state.shield = Math.max(0, seconds || 0);
    if (state.shield > 0 && was <= 0) emit('shield', { seconds: state.shield });
    return state.shield;
  }

  function shielded() {
    return state.shield > 0 || perkSystem.held(state, 'shield');
  }

  function setScore(n) {
    state.score = Math.max(0, n | 0);
    if (state.score > state.stats.bestScore) state.stats.bestScore = state.score;
    emit('score', { score: state.score, delta: 0, nominal: 0 });
  }

  /* -------------------------------------------------------------- stats */
  var _shotFrom = new THREE.Vector3();

  function recordHit(point) {
    var st = state.stats;
    st.shotsHit++;
    st.streak++;
    if (st.streak > st.bestStreak) st.bestStreak = st.streak;
    if (point) {
      camera.getWorldPosition(_shotFrom);
      var range = _shotFrom.distanceTo(point);
      if (range > st.longestShot) st.longestShot = range;
    }
  }

  var FEET_PER_UNIT = 3.28084;      // the arena is metric: one unit, one metre

  function stats() {
    var st = state.stats;
    var fired = st.shotsFired;
    return {
      score: state.score,
      bestScore: st.bestScore,
      level: state.level,
      levelsCleared: st.levelsCleared,
      shotsFired: fired,
      shotsHit: st.shotsHit,
      misses: st.misses,
      accuracy: fired ? st.shotsHit / fired : 0,
      targetsBroken: st.targetsBroken,
      npcsDown: st.npcsDown,
      bestStreak: st.bestStreak,
      streak: st.streak,
      kills: st.kills,
      deaths: st.deaths,
      longestShot: st.longestShot,
      longestShotFeet: st.longestShot * FEET_PER_UNIT,
      distance: st.distance,
      distanceFeet: st.distance * FEET_PER_UNIT,
      jumps: st.jumps,
      reloads: st.reloads,
      timePlayed: st.timePlayed,
      timeSighted: st.timeSighted,
      sightedShare: st.timePlayed ? st.timeSighted / st.timePlayed : 0,
      shotsPerMinute: st.timePlayed ? (fired / st.timePlayed) * 60 : 0,
      pointsPerShot: fired ? state.score / fired : 0,
    };
  }

  function resetStats() {
    var st = state.stats;
    for (var k in st) if (Object.prototype.hasOwnProperty.call(st, k)) st[k] = 0;
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
    applyLevel: applyLevel, reviveTarget: reviveTarget,
    npcsAlive: npcsAlive, addScore: addScore, spawnIndicator: spawnIndicator,
    moveTarget: moveTarget, makeNPC: makeNPC,
    traceShot: traceShot, aliveCount: aliveCount, movePlayer: movePlayer,
    updateNPCs: updateNPCs, knockDownNPC: knockDownNPC, placeNPC: placeNPC, poseGun: poseGun,
    arenaFingerprint: arenaFingerprint,
    stats: stats, resetStats: resetStats, recordHit: recordHit, FEET_PER_UNIT: FEET_PER_UNIT,
    applyServerHit: applyServerHit, showRemoteShot: showRemoteShot,
    setScore: setScore, setHealth: setHealth, breakTarget: breakTarget,
    setShield: setShield, shielded: shielded,
    medkits: medkits, applyMedkits: applyMedkits, takeMedkit: takeMedkit,
    medkitAt: world.medkitAt,
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
    debugView: debugView,
    debugHitboxes: ctx.remoteHitboxes,
    setSensitivity: function (v) {
      cfg.sensitivity = Math.min(5, Math.max(0.1, typeof v === 'number' ? v : 1));
      LOOK_SENS = LOOK_BASE * cfg.sensitivity;
      return cfg.sensitivity;
    },
    getSensitivity: function () { return cfg.sensitivity; },
    setInvertY: function (v) { cfg.invertY = !!v; return cfg.invertY; },
    sfx: sfx,
    setNetworked: function (v) { state.networked = !!v; },
    setWorldTime: function (t) {
      state.worldTime = t;
      world.updateMovers(state.worldTime);
    },
    movers: movers, balcony: balcony, updateMovers: world.updateMovers,
    supportingMover: supportingMover,
    perkSystem: perkSystem, perks: perkSystem.perks,
    fireInterval: fireInterval, walkSpeed: walkSpeed, runSpeed: runSpeed,
    magSize: magSize, airJumpsAllowed: airJumpsAllowed,
    grantPerk: function (kind) {
      var ok = perkSystem.grant(state, kind);
      if (ok) {
        var def = perkSystem.kindByName(kind);
        emit('perk', {
          kind: kind, label: def.label, mine: true,
          duration: perkSystem.durationOf(kind),
        });
      }
      return ok;
    },
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
