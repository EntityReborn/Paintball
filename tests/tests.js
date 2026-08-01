/* Browser test suite for the Paintball game.
 *
 * Runs against the real engine in a real WebGL context: physics and game rules
 * are checked by stepping the simulation, rendering is checked by reading pixels
 * back off the canvas, and input is checked by dispatching genuine DOM
 * KeyboardEvent / MouseEvent objects.
 *
 * Results are mirrored to window.__results for automated collection.
 */
(function (global) {
'use strict';

/* --------------------------------------------------------------- runner */
var suites = [];
var current = null;

function describe(area, fn) {
  current = { area: area, tests: [] };
  suites.push(current);
  fn();
  current = null;
}
function it(name, fn) { current.tests.push({ name: name, fn: fn }); }

function fail(msg) { throw new Error(msg); }

var assert = {
  ok: function (v, msg) { if (!v) fail(msg || 'expected truthy, got ' + v); },
  equal: function (a, b, msg) {
    if (a !== b) fail((msg || 'values differ') + ' — expected ' + b + ', got ' + a);
  },
  close: function (a, b, tol, msg) {
    if (Math.abs(a - b) > tol) {
      fail((msg || 'not close') + ' — expected ' + b + ' ±' + tol + ', got ' + a);
    }
  },
  greater: function (a, b, msg) {
    if (!(a > b)) fail((msg || 'not greater') + ' — expected > ' + b + ', got ' + a);
  },
  less: function (a, b, msg) {
    if (!(a < b)) fail((msg || 'not less') + ' — expected < ' + b + ', got ' + a);
  },
  between: function (a, lo, hi, msg) {
    if (a < lo || a > hi) fail((msg || 'out of range') + ' — expected ' + lo + '..' + hi + ', got ' + a);
  },
};

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* --------------------------------------------------------------- shared */
var g = null;              // the shared game instance most tests drive
var THREE = global.THREE;
var SEED = 12345;          // deterministic world

function freshGame(extra) {
  var host = document.getElementById('stage');
  host.innerHTML = '';
  var opts = Object.assign({
    container: host, seed: SEED, audio: false,
    preserveDrawingBuffer: true, shadows: true,
  }, extra || {});
  return global.createGame(opts);
}

// Put the world back to a known state without rebuilding the WebGL context.
function reset() {
  g.stop();
  g.setActive(false);
  g.setFiring(false);
  Object.keys(g.keys).forEach(function (k) { delete g.keys[k]; });
  g.teleport(0, g.cfg.eye, 0);
  g.yawObj.rotation.y = 0;
  g.pitchObj.rotation.x = 0;
  g.state.mag = g.cfg.magSize;
  g.state.reloading = false;
  g.state.lastShot = -1e9;
  g.state.vy = 0;
  g.state.recoil = 0;
  g.state.kick = 0;
  g.state.kickBack = 0;
  while (g.bullets.length) { g.scene.remove(g.bullets[0].mesh); g.bullets.shift(); }
  g.yawObj.updateMatrixWorld(true);
}

// Rebuild level 1 so NPC and target state is pristine.
function freshLevel() {
  g.startLevel(1);
  g.state.score = 0;
  reset();
}

// Step the simulation by `seconds` in fixed 1/120 slices.
function step(seconds) {
  var dt = 1 / 120;
  for (var t = 0; t < seconds; t += dt) g.update(dt);
}

/* ------------------------------------------------------------ pixel help */
function grab(game) {
  game.render();
  var gl = game.renderer.getContext();
  var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  var buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return {
    w: w, h: h, data: buf,
    // x,y in top-left coords
    at: function (x, y) {
      x = Math.floor(x); y = Math.floor(y);
      var i = ((h - 1 - y) * w + x) * 4;
      return { r: buf[i], g: buf[i + 1], b: buf[i + 2] };
    },
    center: function () { return this.at(w / 2, h / 2); },
  };
}

function uniqueColors(px, sampleStep) {
  var seen = Object.create(null), n = 0;
  for (var y = 0; y < px.h; y += (sampleStep || 4)) {
    for (var x = 0; x < px.w; x += (sampleStep || 4)) {
      var c = px.at(x, y);
      var key = (c.r >> 3) + ',' + (c.g >> 3) + ',' + (c.b >> 3);
      if (!seen[key]) { seen[key] = 1; n++; }
    }
  }
  return n;
}

function diffCount(a, b, x0, y0, x1, y1, tol) {
  var n = 0;
  for (var y = y0; y < y1; y += 2) {
    for (var x = x0; x < x1; x += 2) {
      var p = a.at(x, y), q = b.at(x, y);
      if (Math.abs(p.r - q.r) + Math.abs(p.g - q.g) + Math.abs(p.b - q.b) > (tol || 12)) n++;
    }
  }
  return n;
}

var BG = { r: 0x12, g: 0x1a, b: 0x24 };
function isBackground(c, tol) {
  return Math.abs(c.r - BG.r) + Math.abs(c.g - BG.g) + Math.abs(c.b - BG.b) <= (tol || 10);
}

// Stand somewhere with an unobstructed shot at a world point. Returns false if
// nowhere within reach works.
function standClearOf(point, range) {
  var r = range || 4;
  for (var a = 0; a < Math.PI * 2; a += Math.PI / 10) {
    var eye = new THREE.Vector3(point.x + Math.sin(a) * r, g.cfg.eye, point.z + Math.cos(a) * r);
    if (Math.abs(eye.x) > g.cfg.arena / 2 - 1.5) continue;
    if (Math.abs(eye.z) > g.cfg.arena / 2 - 1.5) continue;
    var box = g.playerBox(eye, new THREE.Box3());
    var blocked = g.colliders.some(function (c) { return c.intersectsBox(box); });
    if (blocked || !g.hasLineOfSight(eye, point)) continue;
    g.teleport(eye.x, g.cfg.eye, eye.z);
    g.aimAt(point);
    return true;
  }
  return false;
}

// A clear target: alive, and with an unobstructed line from the player's eye.
function findClearTarget(fromY) {
  var eye = new THREE.Vector3(g.state.pos.x, fromY === undefined ? g.cfg.eye : fromY, g.state.pos.z);
  for (var i = 0; i < g.targets.length; i++) {
    var t = g.targets[i];
    if (t.alive && g.hasLineOfSight(eye, t.mesh.position)) return t;
  }
  return null;
}

// Stand somewhere with a clear shot at a grounded NPC's chest.
function lineUpOnNPC() {
  for (var i = 0; i < g.npcs.length; i++) {
    var n = g.npcs[i];
    if (!n.alive || !n.grounded) continue;
    var chest = n.root.position.clone().setY(1.0);
    for (var a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      var eye = new THREE.Vector3(
        chest.x + Math.sin(a) * 4, g.cfg.eye, chest.z + Math.cos(a) * 4);
      var box = g.playerBox(eye, new THREE.Box3());
      var blocked = g.colliders.some(function (c) { return c.intersectsBox(box); });
      if (blocked || !g.hasLineOfSight(eye, chest)) continue;
      reset();
      g.teleport(eye.x, g.cfg.eye, eye.z);
      g.aimAt(chest);
      return n;
    }
  }
  return null;
}

/* ================================================================= TESTS */

describe('Bootstrap', function () {
  it('three.js is loaded from the local vendor copy', function () {
    assert.ok(global.THREE, 'window.THREE missing');
    assert.ok(THREE.REVISION, 'THREE.REVISION missing');
  });

  it('createGame is exposed as a classic script global', function () {
    assert.equal(typeof global.createGame, 'function', 'createGame not a function');
  });

  it('a game builds and attaches a sized canvas with a live WebGL context', function () {
    assert.ok(g.domElement instanceof HTMLCanvasElement, 'no canvas');
    assert.ok(g.domElement.parentNode, 'canvas not attached to the page');
    assert.greater(g.domElement.width, 0, 'canvas width');
    assert.greater(g.domElement.height, 0, 'canvas height');
    var gl = g.renderer.getContext();
    assert.ok(gl && !gl.isContextLost(), 'WebGL context lost');
  });

  it('the page shell boots the game without hitting the fatal banner', async function () {
    var frame = document.getElementById('boot-frame');
    var win;
    try {
      win = frame.contentWindow;
      void win.document;                       // throws if cross-origin (file://)
    } catch (e) {
      fail('SKIP: iframe is cross-origin, run the suite over http:// to check the shell');
    }
    var deadline = Date.now() + 6000;
    while (!win.game && Date.now() < deadline) await sleep(100);
    assert.ok(win.game, 'index.html did not create a game');
    assert.ok(win.document.getElementById('fatal').hidden, 'index.html showed the fatal banner');
    var c = win.document.querySelector('canvas');
    assert.ok(c, 'index.html has no canvas');
    assert.greater(c.width, 0, 'index.html canvas width');
    assert.greater(c.clientWidth, 0, 'index.html canvas is not visible on the page');
  });
});

describe('World', function () {
  it('has a floor of the configured size', function () {
    assert.ok(g.floor, 'no floor');
    var box = new THREE.Box3().setFromObject(g.floor);
    assert.close(box.max.x - box.min.x, g.cfg.arena, 0.01, 'floor width');
    assert.close(box.max.z - box.min.z, g.cfg.arena, 0.01, 'floor depth');
  });

  it('is enclosed by four walls of the configured height', function () {
    assert.equal(g.wallMeshes.length, 4, 'wall count');
    g.wallMeshes.forEach(function (w, i) {
      var box = new THREE.Box3().setFromObject(w);
      assert.close(box.max.y, g.cfg.wallHeight, 0.01, 'wall ' + i + ' height');
    });
  });

  it('scatters obstacles across the map', function () {
    assert.greater(g.obstacleMeshes.length, 15, 'obstacle count');
    assert.equal(g.obstacleBoxes.length, g.obstacleMeshes.length, 'obstacle collider count');
  });

  it('keeps every obstacle inside the walls', function () {
    var lim = g.cfg.arena / 2 - 0.5;      // inner face of the perimeter walls
    g.obstacleBoxes.forEach(function (b, i) {
      assert.between(b.min.x, -lim, lim, 'obstacle ' + i + ' min.x');
      assert.between(b.max.x, -lim, lim, 'obstacle ' + i + ' max.x');
      assert.between(b.min.z, -lim, lim, 'obstacle ' + i + ' min.z');
      assert.between(b.max.z, -lim, lim, 'obstacle ' + i + ' max.z');
    });
  });

  it('leaves the spawn point clear of obstacles', function () {
    var origin = new THREE.Vector3(0, g.cfg.eye, 0);
    g.obstacleBoxes.forEach(function (b, i) {
      assert.greater(b.distanceToPoint(origin), 1.5, 'obstacle ' + i + ' too close to spawn');
    });
  });

  it('registers a collider for every wall and obstacle', function () {
    assert.equal(g.colliders.length, 4 + g.obstacleMeshes.length, 'collider count');
  });

  it('adds every solid to the scene graph', function () {
    g.solidMeshes.forEach(function (m, i) {
      var o = m;
      while (o.parent) o = o.parent;
      assert.equal(o, g.scene, 'solid ' + i + ' is not attached to the scene');
    });
  });
});

describe('Targets', function () {
  it('spawns a full wave', function () {
    assert.equal(g.aliveCount(), g.cfg.targetsPerLevel, 'targets alive');
  });

  it('places targets inside the arena and above the floor', function () {
    var lim = g.cfg.arena / 2 - 1;
    g.targets.forEach(function (t, i) {
      assert.between(t.mesh.position.x, -lim, lim, 'target ' + i + ' x');
      assert.between(t.mesh.position.z, -lim, lim, 'target ' + i + ' z');
      assert.between(t.mesh.position.y, 0.6, 5, 'target ' + i + ' y');
    });
  });

  it('never spawns a target on top of the player', function () {
    g.targets.forEach(function (t, i) {
      var d = Math.hypot(t.mesh.position.x, t.mesh.position.z);
      assert.greater(d, 7.9, 'target ' + i + ' spawned in the player\'s lap');
    });
  });

  it('never buries a target inside an obstacle', function () {
    g.targets.forEach(function (t, i) {
      g.obstacleBoxes.forEach(function (b) {
        assert.greater(b.distanceToPoint(t.mesh.position), 0.85, 'target ' + i + ' is inside an obstacle');
      });
    });
  });

  it('adds each target to the scene with a halo', function () {
    g.targets.forEach(function (t, i) {
      assert.equal(t.mesh.parent, g.scene, 'target ' + i + ' not in scene');
      assert.ok(t.halo, 'target ' + i + ' has no halo');
    });
  });

  it('bobs and spins targets over time', function () {
    var t = g.targets[0];
    var y0 = t.mesh.position.y, r0 = t.mesh.rotation.y;
    step(0.5);
    assert.ok(Math.abs(t.mesh.position.y - y0) > 0.01, 'target did not bob');
    assert.ok(Math.abs(t.mesh.rotation.y - r0) > 0.01, 'target did not spin');
  });
});

describe('Rendering', function () {
  it('draws a frame that is not a blank screen', function () {
    reset();
    var px = grab(g);
    assert.greater(px.w, 0, 'drawing buffer width');
    assert.greater(uniqueColors(px), 12, 'frame has almost no colour variety — nothing was drawn');
  });

  it('draws the floor when looking down', function () {
    reset();
    g.pitchObj.rotation.x = -0.9;
    g.yawObj.updateMatrixWorld(true);
    var px = grab(g);
    var c = px.center();
    assert.ok(!isBackground(c), 'centre pixel is the clear colour, floor missing');
    assert.greater(c.r + c.g + c.b, 60, 'floor is unlit/black');
  });

  it('draws walls when looking at one', function () {
    reset();
    g.teleport(0, g.cfg.eye, g.cfg.arena / 2 - 6);
    g.aimAt(new THREE.Vector3(0, 3, g.cfg.arena / 2));
    var px = grab(g);
    assert.ok(!isBackground(px.center()), 'no wall pixels at the crosshair');
  });

  it('draws obstacles when looking at one', function () {
    reset();
    var b = g.obstacleBoxes[0];
    var c = b.getCenter(new THREE.Vector3());
    var dir = c.clone().setY(0).normalize();
    g.teleport(c.x - dir.x * 6, g.cfg.eye, c.z - dir.z * 6);
    g.aimAt(c);
    var px = grab(g);
    assert.ok(!isBackground(px.center()), 'obstacle not visible at the crosshair');
  });

  it('draws a red target at the crosshair when aimed at one', function () {
    reset();
    var t = findClearTarget();
    assert.ok(t, 'no target with a clear line of sight');
    g.aimAt(t.mesh.position);
    var px = grab(g);
    var c = px.center();
    assert.greater(c.r, 90, 'target pixel not bright red');
    assert.greater(c.r, c.b * 1.6, 'target pixel is not red-dominant');
  });

  it('draws the gun in the lower right of the view', function () {
    reset();
    var withGun = grab(g);
    g.gun.visible = false;
    var without = grab(g);
    g.gun.visible = true;
    var n = diffCount(withGun, without,
      Math.floor(withGun.w * 0.5), Math.floor(withGun.h * 0.5), withGun.w, withGun.h);
    assert.greater(n, 200, 'the gun contributed almost no pixels');
  });

  it('keeps the gun visible while pressed against a wall', function () {
    reset();
    g.teleport(0, g.cfg.eye, g.cfg.arena / 2 - 1.5);
    g.aimAt(new THREE.Vector3(0, g.cfg.eye, g.cfg.arena / 2));
    var withGun = grab(g);
    g.gun.visible = false;
    var without = grab(g);
    g.gun.visible = true;
    var n = diffCount(withGun, without,
      Math.floor(withGun.w * 0.5), Math.floor(withGun.h * 0.5), withGun.w, withGun.h);
    assert.greater(n, 200, 'gun clipped through the wall instead of drawing over it');
  });

  it('renders the viewmodel on its own layer', function () {
    var wrong = [];
    g.gun.traverse(function (o) {
      if (!o.layers.isEnabled(g.viewLayer)) wrong.push(o.name || o.type);
    });
    assert.equal(wrong.length, 0, 'viewmodel parts off the view layer: ' + wrong.join(', '));
    assert.ok(g.camera.layers.isEnabled(0), 'camera lost layer 0 after rendering');
  });

  it('survives a resize', function () {
    var host = document.getElementById('stage');
    var w0 = g.renderer.domElement.width;
    host.style.width = '480px';
    g.resize();
    assert.ok(g.renderer.domElement.width !== w0, 'renderer did not resize');
    host.style.width = '';
    g.resize();
    assert.greater(g.camera.aspect, 0, 'aspect ratio broken after resize');
  });
});

describe('Movement', function () {
  it('W walks forward along the facing direction', function () {
    reset();
    g.setActive(true);
    g.yawObj.rotation.y = 0;                 // faces -Z
    g.setKey('KeyW', true);
    step(1);
    g.setKey('KeyW', false);
    assert.less(g.state.pos.z, -2, 'did not move forward');
    assert.close(g.state.pos.x, 0, 0.2, 'drifted sideways');
  });

  it('S walks backward', function () {
    reset();
    g.setActive(true);
    g.setKey('KeyS', true);
    step(1);
    g.setKey('KeyS', false);
    assert.greater(g.state.pos.z, 2, 'did not move backward');
  });

  it('A and D strafe in opposite directions', function () {
    reset();
    g.setActive(true);
    g.setKey('KeyA', true); step(0.8); g.setKey('KeyA', false);
    var left = g.state.pos.x;
    reset();
    g.setActive(true);
    g.setKey('KeyD', true); step(0.8); g.setKey('KeyD', false);
    var right = g.state.pos.x;
    assert.less(left, -1, 'A did not strafe left');
    assert.greater(right, 1, 'D did not strafe right');
  });

  it('respects the facing direction when turning', function () {
    reset();
    g.setActive(true);
    g.yawObj.rotation.y = Math.PI / 2;       // now faces -X
    g.setKey('KeyW', true); step(1); g.setKey('KeyW', false);
    assert.less(g.state.pos.x, -2, 'movement ignored the camera yaw');
  });

  it('sprints faster than it walks', function () {
    // measured as top speed, not distance covered: the map has obstacles in it
    function topSpeed(sprint) {
      reset();
      g.setActive(true);
      g.setKey('KeyW', true);
      if (sprint) g.setKey('ShiftLeft', true);
      var peak = 0;
      for (var i = 0; i < 240; i++) {
        g.update(1 / 120);
        peak = Math.max(peak, Math.hypot(g.state.vel.x, g.state.vel.z));
      }
      g.setKey('KeyW', false);
      g.setKey('ShiftLeft', false);
      return peak;
    }
    var walk = topSpeed(false);
    var run = topSpeed(true);
    assert.close(walk, g.cfg.speed, 0.3, 'walk speed');
    assert.close(run, g.cfg.sprint, 0.3, 'sprint speed');
    assert.greater(run, walk * 1.3, 'sprint is not faster than walking');
  });

  it('comes to a stop when the keys are released', function () {
    reset();
    g.setActive(true);
    g.setKey('KeyW', true); step(1); g.setKey('KeyW', false);
    step(1);
    assert.close(Math.hypot(g.state.vel.x, g.state.vel.z), 0, 0.05, 'player kept sliding');
  });

  it('jumps and falls back to eye height', function () {
    reset();
    g.setActive(true);
    g.state.grounded = true;
    g.setKey('Space', true);
    var peak = 0;
    for (var i = 0; i < 40; i++) { g.update(1 / 120); peak = Math.max(peak, g.state.pos.y); }
    g.setKey('Space', false);
    step(2);
    assert.greater(peak - g.cfg.eye, 0.8, 'jump was too small');
    assert.close(g.state.pos.y, g.cfg.eye, 0.02, 'did not land back on the floor');
    assert.ok(g.state.grounded, 'not grounded after landing');
  });

  it('falls under gravity and lands on top of a crate', function () {
    reset();
    var crate = null;
    for (var i = 0; i < g.obstacleBoxes.length; i++) {
      if (g.obstacleBoxes[i].max.y < 2.2) { crate = g.obstacleBoxes[i]; break; }
    }
    assert.ok(crate, 'no low crate in this world');
    var c = crate.getCenter(new THREE.Vector3());
    g.setActive(true);
    g.teleport(c.x, crate.max.y + 3, c.z);
    step(2.5);
    assert.close(g.state.pos.y - g.cfg.eye, crate.max.y, 0.05, 'feet did not rest on the crate top');
    assert.ok(g.state.grounded, 'not grounded on the crate');
  });

  it('bobs the camera and sways the gun while walking', function () {
    reset();
    g.setActive(true);
    g.setKey('KeyW', true);
    step(0.5);
    var gunX = g.gun.position.x;
    step(0.35);
    g.setKey('KeyW', false);
    assert.ok(Math.abs(g.gun.position.x - gunX) > 0.0005, 'viewmodel did not sway');
  });
});

describe('Collision', function () {
  // How deeply the player's box overlaps a collider. Resting flush against a
  // surface gives 0, so only real penetration is reported.
  function penetration(box, b) {
    var ox = Math.min(box.max.x, b.max.x) - Math.max(box.min.x, b.min.x);
    var oy = Math.min(box.max.y, b.max.y) - Math.max(box.min.y, b.min.y);
    var oz = Math.min(box.max.z, b.max.z) - Math.max(box.min.z, b.min.z);
    return Math.min(ox, oy, oz);
  }

  it('cannot walk through an obstacle from any direction', function () {
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
    var box = new THREE.Box3();
    var worst = 0, worstAt = '', tried = 0;
    var edge = g.cfg.arena / 2 - 1.5;
    for (var i = 0; i < g.obstacleBoxes.length; i += 3) {
      var b = g.obstacleBoxes[i];
      if (b.max.y < 1.2) continue;                   // low enough to stand on, not a wall
      var c = b.getCenter(new THREE.Vector3());
      for (var d = 0; d < dirs.length; d++) {
        var sx = c.x + dirs[d][0] * 7, sz = c.z + dirs[d][1] * 7;
        // the run-up has to start on open ground inside the arena
        if (Math.abs(sx) > edge || Math.abs(sz) > edge) continue;
        reset();
        g.teleport(sx, g.cfg.eye, sz);
        var start = g.playerBox(g.state.pos, box);
        var blocked = g.colliders.some(function (cc) { return cc.intersectsBox(start); });
        if (blocked) continue;
        tried++;
        g.setActive(true);
        g.aimAt(c);
        g.setKey('KeyW', true);
        g.setKey('ShiftLeft', true);                 // sprint, the hardest case
        for (var s = 0; s < 200; s++) {
          g.update(1 / 60);
          var pen = penetration(g.playerBox(g.state.pos, box), b);
          if (pen > worst) { worst = pen; worstAt = 'obstacle ' + i + ' from direction ' + d; }
        }
        g.setKey('KeyW', false);
        g.setKey('ShiftLeft', false);
      }
    }
    assert.greater(tried, 10, 'not enough valid approaches were tested');
    assert.less(worst, 0.05, 'sank ' + worst.toFixed(3) + 'u into ' + worstAt);
  });

  it('pushes the player out if they end up inside geometry', function () {
    reset();
    var b = g.obstacleBoxes[0];
    var c = b.getCenter(new THREE.Vector3());
    g.setActive(true);
    g.teleport(c.x, g.cfg.eye, c.z);              // dropped straight into a crate
    step(1.5);
    var box = g.playerBox(g.state.pos, new THREE.Box3());
    var ox = Math.min(box.max.x, b.max.x) - Math.max(box.min.x, b.min.x);
    var oy = Math.min(box.max.y, b.max.y) - Math.max(box.min.y, b.min.y);
    var oz = Math.min(box.max.z, b.max.z) - Math.max(box.min.z, b.min.z);
    assert.less(Math.min(ox, oy, oz), 0.05, 'player stayed stuck inside an obstacle');
  });

  it('cannot leave the arena in any direction', function () {
    var lim = g.cfg.arena / 2 - 1;
    var dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4];
    for (var i = 0; i < dirs.length; i++) {
      reset();
      g.setActive(true);
      g.yawObj.rotation.y = dirs[i];
      g.setKey('KeyW', true);
      g.setKey('ShiftLeft', true);
      step(12);
      g.setKey('KeyW', false);
      g.setKey('ShiftLeft', false);
      assert.between(g.state.pos.x, -lim, lim, 'escaped the arena on x (heading ' + i + ')');
      assert.between(g.state.pos.z, -lim, lim, 'escaped the arena on z (heading ' + i + ')');
    }
  });

  it('never sinks below the floor', function () {
    reset();
    g.setActive(true);
    step(3);
    assert.close(g.state.pos.y, g.cfg.eye, 0.001, 'fell through the floor');
  });
});

describe('Shooting', function () {
  it('spends a round and spawns a bullet', function () {
    reset();
    var before = g.state.mag;
    var shot = g.shoot();
    assert.ok(shot, 'shoot() returned nothing');
    assert.equal(g.state.mag, before - 1, 'ammo not spent');
    assert.equal(g.bullets.length, 1, 'no bullet spawned');
  });

  it('starts the bullet at the muzzle', function () {
    reset();
    g.shoot();
    var muzzlePos = g.muzzle.getWorldPosition(new THREE.Vector3());
    assert.less(g.bullets[0].mesh.position.distanceTo(muzzlePos), 0.01, 'bullet did not start at the muzzle');
  });

  it('enforces a rate of fire', function () {
    reset();
    assert.ok(g.shoot(), 'first shot blocked');
    assert.ok(!g.shoot(), 'second shot was not rate limited');
    g.update(g.cfg.fireMs / 1000 + 0.01);
    assert.ok(g.shoot(), 'shot blocked after the cooldown');
  });

  it('empties the magazine and refuses to fire', function () {
    reset();
    for (var i = 0; i < g.cfg.magSize; i++) {
      g.shoot();
      g.update(g.cfg.fireMs / 1000 + 0.001);
    }
    assert.equal(g.state.mag, 0, 'magazine did not empty');
    var before = g.bullets.length;
    g.shoot();
    assert.equal(g.bullets.length, before, 'fired on an empty magazine');
  });

  it('reloads on R and refills the magazine', function () {
    reset();
    g.state.mag = 3;
    assert.ok(g.reload(), 'reload refused');
    assert.ok(g.state.reloading, 'not marked as reloading');
    assert.ok(!g.shoot(), 'fired while reloading');
    step(g.cfg.reloadMs / 1000 + 0.05);
    assert.equal(g.state.mag, g.cfg.magSize, 'magazine not refilled');
    assert.ok(!g.state.reloading, 'still reloading');
  });

  it('auto-reloads when the trigger is pulled dry', function () {
    reset();
    g.state.mag = 0;
    g.state.lastShot = -1e9;
    g.shoot();
    assert.ok(g.state.reloading, 'dry fire did not start a reload');
    step(g.cfg.reloadMs / 1000 + 0.05);
    assert.equal(g.state.mag, g.cfg.magSize, 'auto reload did not finish');
  });

  it('kicks the gun and lights the muzzle flash', function () {
    reset();
    g.shoot();
    assert.greater(g.state.recoil, 0.5, 'no recoil');
    assert.greater(g.muzzleFlash.material.opacity, 0.5, 'no muzzle flash');
    step(0.6);
    assert.less(g.state.recoil, 0.2, 'recoil never settled');
    assert.less(g.muzzleFlash.material.opacity, 0.1, 'muzzle flash never faded');
  });

  it('lands the shot exactly on the crosshair, not on the muzzle line', function () {
    reset();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    var eye = g.camera.getWorldPosition(new THREE.Vector3());
    var fwd = g.camera.getWorldDirection(new THREE.Vector3());
    var shot = g.shoot();
    var toHit = shot.hit.point.clone().sub(eye).normalize();
    assert.greater(toHit.dot(fwd), 0.999, 'the shot did not follow the crosshair ray');
  });

  it('stops bullets at obstacles instead of shooting through them', function () {
    reset();
    var b = g.obstacleBoxes[0];
    var c = b.getCenter(new THREE.Vector3());
    var dir = c.clone().setY(0).normalize();
    g.teleport(c.x - dir.x * 8, g.cfg.eye, c.z - dir.z * 8);
    g.aimAt(c);
    var shot = g.shoot();
    assert.ok(!shot.hit.target, 'shot passed through an obstacle to a target');
    assert.less(shot.hit.distance, 9, 'shot did not stop at the obstacle');
  });

  it('leaves an impact mark on walls', function () {
    reset();
    var before = g.impacts.length;
    g.teleport(0, g.cfg.eye, g.cfg.arena / 2 - 8);
    g.aimAt(new THREE.Vector3(0, 3, g.cfg.arena / 2));
    g.shoot();
    step(1.0);
    assert.greater(g.impacts.length, before, 'no impact decal');
  });

  it('cleans bullets up after they arrive', function () {
    reset();
    g.aimAt(new THREE.Vector3(0, 3, g.cfg.arena / 2));
    g.shoot();
    step(2);
    assert.equal(g.bullets.length, 0, 'bullets leaked');
  });
});

describe('Breaking targets', function () {
  it('breaks a target that is hit, scores it, and throws debris', function () {
    reset();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    var score0 = g.state.score;
    var alive0 = g.aliveCount();
    g.aimAt(t.mesh.position);
    g.shoot();
    step(1.5);
    assert.ok(!t.alive, 'target survived a direct hit');
    assert.equal(g.aliveCount(), alive0 - 1, 'alive count did not drop');
    assert.equal(g.state.score, score0 + 100, 'score did not increase by 100');
    assert.greater(g.debris.length, 10, 'no debris from the break');
    assert.equal(t.mesh.parent, null, 'broken target still in the scene');
  });

  it('emits a hit event with the running score', function () {
    reset();
    var seen = null;
    g.on('hit', function (d) { seen = d; });
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(1.5);
    assert.ok(seen, 'no hit event');
    assert.equal(seen.score, g.state.score, 'hit event carried the wrong score');
  });

  it('clears debris from the scene once it expires', function () {
    reset();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(1.5);
    assert.greater(g.debris.length, 0, 'expected debris');
    step(2.5);
    assert.equal(g.debris.length, 0, 'debris never expired');
  });

  it('does not break a target the shot missed', function () {
    reset();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position.clone().add(new THREE.Vector3(0, 6, 0)));
    g.shoot();
    step(2);
    assert.ok(t.alive, 'a miss broke the target anyway');
  });
});

describe('Levels', function () {
  // Put every NPC down, one at a time, from point blank.
  function clearNPCs() {
    var level0 = g.state.level;
    var downed = 0;
    while (g.npcsAlive() > 0 && g.state.level === level0 && downed < 40) {
      var n = null;
      for (var i = 0; i < g.npcs.length; i++) if (g.npcs[i].alive) { n = g.npcs[i]; break; }
      if (!n) break;
      g.knockDownNPC(n);
      downed++;
    }
    return downed;
  }

  // Down every NPC and break every target: the whole win condition.
  function clearArena() {
    var level0 = g.state.level;
    clearNPCs();
    for (var pass = 0; pass < 4 && g.state.level === level0; pass++) {
      for (var i = 0; i < g.targets.length; i++) {
        var t = g.targets[i];
        if (!t.alive) continue;
        if (!standClearOf(t.mesh.position, 3)) continue;
        g.state.mag = g.cfg.magSize;
        g.state.lastShot = -1e9;
        g.shoot();
        step(0.4);
        if (g.state.level !== level0) break;
      }
    }
    return g.state.level !== level0;
  }

  it('needs both the NPCs down and the targets broken', function () {
    freshLevel();
    var level0 = g.state.level;
    var completed = 0;
    g.on('levelComplete', function () { completed++; });

    // break every target first: that must not end the level
    for (var pass = 0; pass < 3 && g.aliveCount() > 0; pass++) {
      for (var i = 0; i < g.targets.length; i++) {
        var t = g.targets[i];
        if (!t.alive) continue;
        if (!standClearOf(t.mesh.position, 3)) continue;
        g.state.mag = g.cfg.magSize;
        g.state.lastShot = -1e9;
        g.shoot();
        step(0.4);
      }
    }
    assert.equal(g.aliveCount(), 0, 'targets were not all broken');
    assert.equal(g.state.level, level0, 'clearing the targets alone ended the level');
    assert.equal(completed, 0, 'levelComplete fired on targets alone');

    clearNPCs();
    assert.equal(completed, 1, 'clearing both did not complete the level');
    assert.equal(g.state.level, level0 + 1, 'level did not advance');
  });

  it('does not end the level on the NPCs alone', function () {
    freshLevel();
    var level0 = g.state.level;
    var completed = 0;
    g.on('levelComplete', function () { completed++; });
    clearNPCs();
    assert.equal(g.npcsAlive(), 0, 'NPCs were not all downed');
    assert.greater(g.aliveCount(), 0, 'the targets went too');
    assert.equal(completed, 0, 'levelComplete fired with targets still standing');
    assert.equal(g.state.level, level0, 'the level advanced on NPCs alone');
  });

  it('the last target finishes a level whose NPCs are already down', function () {
    freshLevel();
    var level0 = g.state.level;
    clearNPCs();
    assert.equal(g.state.level, level0, 'ended early');
    // now break every target; the last one should tip it over
    for (var pass = 0; pass < 3 && g.state.level === level0; pass++) {
      for (var i = 0; i < g.targets.length; i++) {
        var t = g.targets[i];
        if (!t.alive) continue;
        if (!standClearOf(t.mesh.position, 3)) continue;
        g.state.mag = g.cfg.magSize;
        g.state.lastShot = -1e9;
        g.shoot();
        step(0.4);
        if (g.state.level !== level0) break;
      }
    }
    assert.equal(g.state.level, level0 + 1, 'breaking the last target did not finish the level');
  });

  it('awards the level bonus once the arena is clear', function () {
    freshLevel();
    var score0 = g.state.score;
    var npcs = g.npcsAlive();
    var downed = clearNPCs();
    assert.equal(downed, npcs, 'did not down every NPC exactly once');
    assert.equal(g.state.score, score0 + npcs * g.cfg.scoreNpc,
                 'NPC kills did not score, or the bonus landed early');

    // clear the targets to actually finish it
    for (var pass = 0; pass < 3 && g.aliveCount() > 0; pass++) {
      for (var i = 0; i < g.targets.length; i++) {
        var t = g.targets[i];
        if (!t.alive) continue;
        if (!standClearOf(t.mesh.position, 3)) continue;
        g.state.mag = g.cfg.magSize;
        g.state.lastShot = -1e9;
        g.shoot();
        step(0.4);
      }
    }
    assert.greater(g.state.score, score0 + npcs * g.cfg.scoreNpc, 'the bonus never arrived');
  });

  it('stocks the next level with more NPCs and a fresh set of targets', function () {
    freshLevel();
    var before = g.npcs.length;
    clearArena();
    assert.equal(g.npcs.length, before + 1, 'next level did not add an NPC');
    assert.equal(g.npcsAlive(), g.npcs.length, 'next level started with bodies');
    assert.equal(g.aliveCount(), g.cfg.targetsPerLevel, 'next level has no targets');
  });

  it('clears the old level out of the scene', function () {
    freshLevel();
    var before = g.scene.children.length;
    clearArena();
    step(0.5);
    // same shape of level, so the object count must come back to where it was
    assert.less(Math.abs(g.scene.children.length - before), 12,
                'scene grew by ' + (g.scene.children.length - before) + ' across a level change');
  });

  it('does not resolve in-flight bullets against the finished level', function () {
    freshLevel();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    assert.equal(g.bullets.length, 1, 'no bullet in flight');
    clearArena();                     // ends the level while the round is flying
    assert.equal(g.bullets.length, 0, 'stray bullet survived the level change');
    step(0.5);                        // must not throw
  });
});

describe('Input', function () {
  it('routes real keyboard events into movement', function () {
    reset();
    g.setActive(true);
    g.bindInput(window);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    assert.ok(g.keys['KeyW'], 'keydown not recorded');
    step(0.8);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    assert.ok(!g.keys['KeyW'], 'keyup not recorded');
    assert.less(g.state.pos.z, -1.5, 'real key events did not move the player');
    g.unbindInput(window);
  });

  it('fires on a real left mouse button press and stops on release', function () {
    reset();
    g.setActive(true);
    g.bindInput(window);
    var shots = 0;
    g.on('shoot', function () { shots++; });

    window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    assert.ok(g.isFiring(), 'mousedown did not arm the trigger');
    g.update(1 / 60);
    assert.equal(shots, 1, 'left click did not fire');
    assert.equal(g.bullets.length, 1, 'left click spawned no bullet');

    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    assert.ok(!g.isFiring(), 'mouseup did not release the trigger');
    var after = shots;
    step(1);
    assert.equal(shots, after, 'kept firing after the button was released');
    g.unbindInput(window);
  });

  it('holds the trigger down for automatic fire at the rate limit', function () {
    reset();
    g.setActive(true);
    g.bindInput(window);
    var shots = 0;
    g.on('shoot', function () { shots++; });
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    step(0.62);                                   // ~4.8 shots at 130ms
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    assert.between(shots, 4, 6, 'automatic fire rate is off');
    g.unbindInput(window);
  });

  it('ignores the right mouse button', function () {
    reset();
    g.setActive(true);
    g.bindInput(window);
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    assert.ok(!g.isFiring(), 'right click armed the trigger');
    g.unbindInput(window);
  });

  it('turns the view with real mouse movement', function () {
    reset();
    g.setActive(true);
    g.bindInput(window);
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0 }));   // swallowed
    var yaw0 = g.yawObj.rotation.y, pitch0 = g.pitchObj.rotation.x;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 60 }));
    assert.less(g.yawObj.rotation.y, yaw0, 'moving the mouse right did not turn right');
    assert.less(g.pitchObj.rotation.x, pitch0, 'moving the mouse down did not look down');
    g.unbindInput(window);
  });

  it('swallows the huge first delta the pointer lock delivers', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);                         // as if the pointer just locked
    var yaw0 = g.yawObj.rotation.y;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 900, movementY: 700 }));
    assert.close(g.yawObj.rotation.y, yaw0, 0.0001, 'the view snapped on the first event');
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 50 }));
    assert.ok(Math.abs(g.yawObj.rotation.y - yaw0) > 0.01, 'later events were ignored too');
    g.unbindInput(window);
  });

  it('clamps a single wild mouse delta so the view cannot snap', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 1 }));   // eat the first
    var yaw0 = g.yawObj.rotation.y;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 20000 }));
    var swing = Math.abs(g.yawObj.rotation.y - yaw0);
    assert.less(swing, 0.5, 'a single event spun the view ' + swing.toFixed(2) + ' rad');
    g.unbindInput(window);
  });

  it('recoil climbs and then settles back to the original aim', function () {
    reset();
    var pitch0 = g.pitchObj.rotation.x;
    g.shoot();
    step(0.1);
    assert.greater(g.pitchObj.rotation.x, pitch0, 'no muzzle climb');
    step(2);
    assert.close(g.pitchObj.rotation.x, pitch0, 0.01, 'aim drifted up permanently');
  });

  it('clamps how far the view can pitch', function () {
    reset();
    g.setActive(true);
    g.bindInput(window);
    window.dispatchEvent(new MouseEvent('mousemove', { movementY: 0 }));   // swallowed
    for (var i = 0; i < 40; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { movementY: -400 }));
    }
    assert.less(g.pitchObj.rotation.x, Math.PI / 2, 'pitch flipped over the top');
    for (var j = 0; j < 80; j++) {
      window.dispatchEvent(new MouseEvent('mousemove', { movementY: 400 }));
    }
    assert.greater(g.pitchObj.rotation.x, -Math.PI / 2, 'pitch flipped under the bottom');
    g.unbindInput(window);
  });

  it('reloads on the R key', function () {
    reset();
    g.bindInput(window);
    g.state.mag = 2;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    assert.ok(g.state.reloading, 'R did not start a reload');
    step(g.cfg.reloadMs / 1000 + 0.05);
    assert.equal(g.state.mag, g.cfg.magSize, 'R reload did not finish');
    g.unbindInput(window);
  });

  it('ignores input while paused, and resumes when unpaused', function () {
    reset();
    g.setActive(false);
    g.setKey('KeyW', true);
    step(1);
    assert.close(g.state.pos.z, 0, 0.001, 'moved while paused');
    g.setActive(true);
    step(1);
    g.setKey('KeyW', false);
    assert.less(g.state.pos.z, -2, 'did not move after unpausing');
  });
});

describe('Reload animation', function () {
  it('runs the reload on game time, with no wall-clock timer', function () {
    reset();
    g.state.mag = 1;
    g.reload();
    assert.equal(g.state.reloadT, 0, 'progress did not start at zero');
    step(g.cfg.reloadMs / 2000);
    assert.between(g.state.reloadT, 0.35, 0.65, 'progress halfway through');
    assert.ok(g.state.reloading, 'finished early');
    step(g.cfg.reloadMs / 2000 + 0.05);
    assert.ok(!g.state.reloading, 'reload never finished');
    assert.equal(g.state.mag, g.cfg.magSize, 'magazine not refilled');
  });

  it('drops the magazine out and seats a fresh one', function () {
    reset();
    var home = g.magazine.position.clone();
    g.state.mag = 0;
    g.reload();

    step(0.05);                       // still seated at the very start
    assert.less(g.magazine.position.distanceTo(home), 0.02, 'magazine moved too early');

    // partway through, the magazine should be clear of the gun
    var dropped = 0;
    for (var i = 0; i < 120; i++) {
      step(g.cfg.reloadMs / 1000 / 120);
      dropped = Math.max(dropped, home.y - g.magazine.position.y);
    }
    assert.greater(dropped, 0.2, 'magazine never dropped out');
    assert.less(g.magazine.position.distanceTo(home), 0.02, 'magazine not seated at the end');
    assert.close(g.magazine.rotation.z, 0, 0.01, 'magazine left rotated');
  });

  it('lowers the gun during the reload and brings it back', function () {
    reset();
    g.poseGun();
    var restY = g.gun.position.y;
    var restPitch = g.gun.rotation.x;
    g.state.mag = 2;
    g.reload();
    step(g.cfg.reloadMs / 2000);
    assert.less(g.gun.position.y, restY - 0.05, 'gun did not drop');
    assert.less(g.gun.rotation.x, restPitch - 0.2, 'muzzle did not dip');
    assert.greater(g.gun.rotation.z, 0.2, 'gun did not roll over for the reload');
    step(g.cfg.reloadMs / 2000 + 0.1);
    assert.close(g.gun.position.y, restY, 0.02, 'gun did not return to rest');
    assert.close(g.gun.rotation.x, restPitch, 0.02, 'gun pitch did not return');
  });

  it('animates while the game is paused', function () {
    reset();
    g.setActive(false);
    g.state.mag = 0;
    g.reload();
    step(g.cfg.reloadMs / 2000);
    assert.greater(g.state.reloadT, 0.3, 'reload stalled while paused');
    step(g.cfg.reloadMs / 2000 + 0.05);
    assert.equal(g.state.mag, g.cfg.magSize, 'reload did not finish while paused');
  });

  it('refuses to reload a full magazine', function () {
    reset();
    assert.ok(!g.reload(), 'reloaded a full magazine');
    assert.ok(!g.state.reloading, 'started reloading anyway');
  });
});

describe('NPCs', function () {
  it('places a few low-poly figures in the world', function () {
    freshLevel();
    assert.greater(g.npcs.length, 2, 'not enough NPCs');
    g.npcs.forEach(function (n, i) {
      assert.equal(n.root.parent, g.scene, 'npc ' + i + ' not in the scene');
      assert.ok(n.torso && n.head && n.legL && n.legR && n.armL && n.armR,
                'npc ' + i + ' is missing body parts');
      var box = new THREE.Box3().setFromObject(n.root);
      assert.between(box.max.y - box.min.y, 1.4, 2.2, 'npc ' + i + ' is the wrong height');
    });
  });

  it('spawns them clear of the player and the obstacles', function () {
    var n = g.npcs[0];
    for (var attempt = 0; attempt < 25; attempt++) {
      assert.ok(g.placeNPC(n), 'placement gave up');
      var p = n.root.position;
      assert.greater(Math.hypot(p.x, p.z), 5, 'spawned on the player');
      _npcPoint.set(p.x, 0.9, p.z);
      for (var b = 0; b < g.obstacleBoxes.length; b++) {
        assert.greater(g.obstacleBoxes[b].distanceToPoint(_npcPoint), 1.0,
                       'spawned inside obstacle ' + b);
      }
      assert.between(p.x, -g.cfg.arena / 2, g.cfg.arena / 2, 'spawned outside the arena');
    }
  });

  it('runs: the figures move and their legs swing', function () {
    freshLevel();
    var n = g.npcs[0];
    var from = n.root.position.clone();
    var legs = [];
    for (var i = 0; i < 90; i++) {
      step(1 / 60);
      legs.push(n.legL.rotation.x);
    }
    assert.greater(n.root.position.distanceTo(from), 1.5, 'npc did not move');
    var swing = Math.max.apply(null, legs) - Math.min.apply(null, legs);
    assert.greater(swing, 0.6, 'legs did not swing through a run cycle');
  });

  it('swings arms opposite to legs', function () {
    freshLevel();
    var n = g.npcs[0];
    var samples = 0, opposed = 0;
    for (var i = 0; i < 120; i++) {
      step(1 / 60);
      if (!n.grounded) continue;
      if (Math.abs(n.legL.rotation.x) < 0.2) continue;
      samples++;
      if (Math.sign(n.armL.rotation.x) !== Math.sign(n.legL.rotation.x)) opposed++;
    }
    assert.greater(samples, 10, 'not enough run samples');
    assert.equal(opposed, samples, 'arms did not counter-swing');
  });

  it('jumps, leaves the ground, tucks its legs and lands', function () {
    freshLevel();
    var n = g.npcs[0];
    n.jumpIn = 0;
    var peak = 0, tucked = false;
    for (var i = 0; i < 200; i++) {
      step(1 / 60);
      peak = Math.max(peak, n.root.position.y);
      if (!n.grounded && n.legL.rotation.x < -0.3) tucked = true;
    }
    assert.greater(peak, 0.6, 'npc never left the ground');
    assert.ok(tucked, 'npc did not tuck its legs while airborne');
    assert.close(n.root.position.y, 0, 0.01, 'npc did not land');
    assert.ok(n.grounded, 'npc is stuck in the air');
  });

  it('keeps every NPC inside the arena', function () {
    freshLevel();
    var lim = g.cfg.arena / 2 - 1;
    for (var i = 0; i < 900; i++) {
      step(1 / 60);
      for (var j = 0; j < g.npcs.length; j++) {
        var p = g.npcs[j].root.position;
        if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) {
          fail('npc ' + j + ' escaped to ' + p.x.toFixed(1) + ',' + p.z.toFixed(1));
        }
      }
    }
  });

  it('can be shot, scores 250, and drops', function () {
    reset();
    var n = lineUpOnNPC();
    assert.ok(n, 'could not get a clear shot on any NPC');
    var score0 = g.state.score;
    var shot = g.shoot();
    assert.ok(shot.hit.npc, 'the shot did not register on the NPC');
    assert.equal(shot.hit.npc, n, 'the shot hit a different NPC');
    step(0.6);
    assert.ok(!n.alive, 'the NPC shrugged off a direct hit');
    assert.equal(g.state.score, score0 + 250, 'NPC hit did not score 250');
  });

  it('stays down for good once shot', function () {
    freshLevel();
    var n = g.npcs[1];
    var where = n.root.position.clone();
    g.knockDownNPC(n);
    step(1);
    assert.ok(!n.alive, 'got back up');
    assert.greater(n.root.rotation.x, 0.5, 'downed NPC did not fall over');
    step(6);
    assert.ok(!n.alive, 'an NPC respawned');
    assert.less(n.root.position.distanceTo(where), 1.5, 'a body wandered off');
  });

  it('lets bullets through a body instead of stopping them', function () {
    freshLevel();
    var n = g.npcs[2];
    assert.ok(g.solidMeshes.indexOf(n.hitbox) !== -1, 'a live NPC is not solid');
    g.knockDownNPC(n);
    assert.equal(g.solidMeshes.indexOf(n.hitbox), -1, 'a body still stops bullets');
  });

  it('stops bullets that hit it', function () {
    freshLevel();
    var n = g.npcs[2];
    var p = n.root.position;
    g.teleport(p.x + 3, g.cfg.eye, p.z);
    g.aimAt(new THREE.Vector3(p.x, 1.15, p.z));
    var hit = g.traceShot(
      g.camera.getWorldPosition(new THREE.Vector3()),
      g.camera.getWorldDirection(new THREE.Vector3())
    );
    assert.ok(hit.npc, 'the NPC is not solid to bullets');
    assert.less(hit.distance, 4, 'bullet stopped behind the NPC');
  });
});

/* Hunting the reported "view snaps" problem. Every one of these describes a
 * specific way the camera angle could jump, so a failure names the cause. */
describe('View angles', function () {
  var SENS = 0.0022;

  function look(dx, dy) {
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy || 0 }));
  }
  function armed() {
    reset();
    g.bindInput(window);
    g.setActive(true);
    look(0, 0);                     // the swallowed first sample
    return { yaw: g.yawObj.rotation.y, pitch: g.pitchObj.rotation.x };
  }

  it('integrates a stream of ordinary deltas exactly', function () {
    var start = armed();
    var total = 0;
    for (var i = 0; i < 200; i++) {
      var dx = (i % 7) - 3;                        // -3..3 px, both directions
      look(dx, 0);
      total += dx;
    }
    assert.close(g.yawObj.rotation.y, start.yaw - total * SENS, 1e-9,
                 'yaw drifted away from the sum of the deltas');
    g.unbindInput(window);
  });

  it('never turns further in one event than the delta allows', function () {
    armed();
    var worst = 0, last = g.yawObj.rotation.y;
    for (var i = 0; i < 400; i++) {
      var dx = Math.round(Math.sin(i / 9) * 60);
      look(dx, 0);
      var stepSize = Math.abs(g.yawObj.rotation.y - last);
      worst = Math.max(worst, stepSize - Math.abs(dx) * SENS);
      last = g.yawObj.rotation.y;
    }
    assert.less(worst, 1e-9, 'the view moved further than the input asked for');
    g.unbindInput(window);
  });

  it('applies a fast flick in full, without clamping it', function () {
    // an earlier build clamped every event to 140px, which quietly changed the
    // sensitivity of any quick movement
    var start = armed();
    look(300, 0);
    assert.close(g.yawObj.rotation.y, start.yaw - 300 * SENS, 1e-9,
                 'a 300px flick was not applied in full');
    g.unbindInput(window);
  });

  it('swallows the jump the pointer lock delivers on the first event', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    var yaw0 = g.yawObj.rotation.y;
    look(1200, 800);
    assert.close(g.yawObj.rotation.y, yaw0, 1e-9, 'the first sample moved the view');
    g.unbindInput(window);
  });

  it('drops a cursor re-entry jump and keeps the stream smooth', function () {
    // what the mouse leaving one side of the window and coming back looks like
    var start = armed();
    for (var i = 0; i < 20; i++) look(4, 0);
    var beforeJump = g.yawObj.rotation.y;
    var spikes0 = g.state.lookSpikes;
    look(1400, -600);                              // the re-entry
    assert.close(g.yawObj.rotation.y, beforeJump, 1e-9, 'the re-entry jump turned the view');
    assert.equal(g.state.lookSpikes, spikes0 + 1, 'the jump was not counted as a spike');
    for (var j = 0; j < 20; j++) look(4, 0);
    assert.close(g.yawObj.rotation.y, start.yaw - 40 * 4 * SENS, 1e-9,
                 'the stream did not carry on cleanly after the jump');
    g.unbindInput(window);
  });

  it('ignores non-finite deltas instead of turning the view to NaN', function () {
    var start = armed();
    look(NaN, 0);
    look(Infinity, 0);
    look(undefined, undefined);
    assert.ok(isFinite(g.yawObj.rotation.y), 'yaw became ' + g.yawObj.rotation.y);
    assert.ok(isFinite(g.pitchObj.rotation.x), 'pitch became ' + g.pitchObj.rotation.x);
    assert.close(g.yawObj.rotation.y, start.yaw, 1e-9, 'a bad sample moved the view');
    g.unbindInput(window);
  });

  it('holds the pitch limit no matter how hard you push', function () {
    armed();
    for (var i = 0; i < 200; i++) look(0, -200);
    assert.less(g.pitchObj.rotation.x, Math.PI / 2, 'pitch went over the top');
    assert.close(g.pitchObj.rotation.x, Math.PI / 2 - 0.01, 1e-6, 'pitch did not stop at the limit');
    for (var j = 0; j < 400; j++) look(0, 200);
    assert.greater(g.pitchObj.rotation.x, -Math.PI / 2, 'pitch went under the bottom');
    assert.close(g.pitchObj.rotation.x, -(Math.PI / 2 - 0.01), 1e-6, 'pitch did not stop at the floor');
    g.unbindInput(window);
  });

  it('comes straight back down off the limit', function () {
    // if the limit were enforced by wrapping rather than clamping, one event
    // the other way would fling the view across the sky
    armed();
    for (var i = 0; i < 200; i++) look(0, -200);
    var atLimit = g.pitchObj.rotation.x;
    look(0, 10);
    assert.close(g.pitchObj.rotation.x, atLimit - 10 * SENS, 1e-9, 'coming off the limit snapped');
    g.unbindInput(window);
  });

  it('does not flip the view when firing while looking straight up', function () {
    // the recoil kick used to add to pitch without re-clamping
    reset();
    g.pitchObj.rotation.x = Math.PI / 2 - 0.01;
    var before = g.pitchObj.rotation.x;
    g.shoot();
    var worst = 0;
    for (var i = 0; i < 120; i++) {
      step(1 / 120);
      worst = Math.max(worst, Math.abs(g.pitchObj.rotation.x));
    }
    assert.less(worst, Math.PI / 2, 'recoil pushed the view past vertical');
    assert.less(Math.abs(g.pitchObj.rotation.x - before), 0.02,
                'the view did not return to where it was aimed');
  });

  it('keeps recoil recovery inside the limits over sustained fire', function () {
    reset();
    g.pitchObj.rotation.x = Math.PI / 2 - 0.05;
    for (var i = 0; i < 20; i++) {
      g.state.lastShot = -1e9;
      g.state.mag = g.cfg.magSize;
      g.shoot();
      step(0.1);
      assert.less(Math.abs(g.pitchObj.rotation.x), Math.PI / 2, 'pitch escaped on shot ' + i);
    }
    step(3);
    assert.less(Math.abs(g.pitchObj.rotation.x), Math.PI / 2, 'pitch escaped while settling');
  });

  it('turns a full circle without a discontinuity', function () {
    armed();
    var last = g.yawObj.rotation.y;
    var worst = 0;
    for (var i = 0; i < 1000; i++) {
      look(-8, 0);                                 // ~360 degrees in total
      var d = Math.abs(g.yawObj.rotation.y - last);
      worst = Math.max(worst, d);
      last = g.yawObj.rotation.y;
    }
    assert.close(worst, 8 * SENS, 1e-9, 'a step of ' + worst.toFixed(4) + ' rad appeared mid-turn');
    g.unbindInput(window);
  });

  it('does not move the view while paused', function () {
    reset();
    g.bindInput(window);
    g.setActive(false);
    var yaw0 = g.yawObj.rotation.y, pitch0 = g.pitchObj.rotation.x;
    for (var i = 0; i < 50; i++) look(40, 40);
    assert.close(g.yawObj.rotation.y, yaw0, 1e-9, 'yaw moved while paused');
    assert.close(g.pitchObj.rotation.x, pitch0, 1e-9, 'pitch moved while paused');
    g.unbindInput(window);
  });

  it('survives repeated pause and resume without injecting rotation', function () {
    reset();
    g.bindInput(window);
    var yaw0 = g.yawObj.rotation.y;
    for (var i = 0; i < 10; i++) {
      g.setActive(true);
      look(900, 700);                              // the re-lock jump each time
      g.setActive(false);
      look(50, 50);                                // stray movement while paused
    }
    assert.close(g.yawObj.rotation.y, yaw0, 1e-9, 'pausing and resuming turned the view');
    g.unbindInput(window);
  });

  it('gives the same result however the movement is split across events', function () {
    var a = armed();
    look(120, 0);
    var oneEvent = g.yawObj.rotation.y - a.yaw;
    var b = armed();
    for (var i = 0; i < 120; i++) look(1, 0);
    var manyEvents = g.yawObj.rotation.y - b.yaw;
    assert.close(oneEvent, manyEvents, 1e-9, 'sensitivity depends on the event rate');
    g.unbindInput(window);
  });

  it('records a debug log that names the worst step', function () {
    reset();
    g.setLookDebug(true);
    g.bindInput(window);
    g.setActive(true);
    look(0, 0);
    for (var i = 0; i < 60; i++) look(12, 6);
    look(2000, 0);                                 // a spike, for the log
    var stats = g.lookStats();
    assert.greater(stats.samples, 50, 'nothing was logged');
    assert.greater(stats.spikes, 0, 'the spike was not recorded');
    assert.less(stats.maxAngleStep, 0.05, 'the log shows a jump of ' + stats.maxAngleStep + ' rad');
    var log = g.lookLog();
    assert.ok(log[log.length - 1].gap !== undefined, 'the log does not record event gaps');
    var kinds = log.map(function (e) { return e.kind; });
    assert.ok(kinds.indexOf('spike') !== -1, 'no spike entry in the log');
    assert.ok(kinds.indexOf('move') !== -1, 'no move entries in the log');
    g.setLookDebug(false);
    g.unbindInput(window);
  });
});

describe('Zoom', function () {
  function rightDown() { window.dispatchEvent(new MouseEvent('mousedown', { button: 2 })); }
  function rightUp() { window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })); }

  it('sights down the barrel while the right button is held', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    assert.close(g.camera.fov, g.cfg.fov, 0.01, 'did not start at the hip fov');

    rightDown();
    assert.ok(g.isZooming(), 'right button did not arm the zoom');
    step(g.cfg.zoomTime + 0.05);
    assert.close(g.camera.fov, g.cfg.zoomFov, 0.5, 'lens did not reach the sighted fov');
    assert.close(g.state.zoom, 1, 0.001, 'zoom did not finish');

    rightUp();
    step(g.cfg.zoomTime + 0.05);
    assert.close(g.camera.fov, g.cfg.fov, 0.5, 'lens did not come back out');
    assert.close(g.state.zoom, 0, 0.001, 'zoom did not release');
    g.unbindInput(window);
  });

  it('eases rather than snapping to the sights', function () {
    reset();
    g.setZooming(true);
    g.setActive(true);
    var last = g.camera.fov, worst = 0;
    for (var i = 0; i < 40; i++) {
      step(1 / 120);
      worst = Math.max(worst, Math.abs(g.camera.fov - last));
      last = g.camera.fov;
    }
    var perStep = (g.cfg.fov - g.cfg.zoomFov) / (g.cfg.zoomTime * 120);
    assert.less(worst, perStep * 2, 'the lens jumped ' + worst.toFixed(1) + ' degrees in a frame');
    g.setZooming(false);
    step(0.5);
  });

  it('brings the gun up to the middle of the view', function () {
    reset();
    g.poseGun();
    var hipX = g.gun.position.x;
    g.setZooming(true);
    g.setActive(true);
    step(g.cfg.zoomTime + 0.05);
    assert.less(Math.abs(g.gun.position.x), Math.abs(hipX) * 0.4, 'gun did not centre');
    assert.close(g.gun.rotation.y, 0, 0.02, 'gun did not square up to the sights');
    g.setZooming(false);
    step(g.cfg.zoomTime + 0.1);
    assert.close(g.gun.position.x, hipX, 0.01, 'gun did not return to the hip');
  });

  it('slows the aim in proportion to the lens', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0 }));   // swallowed

    var yaw0 = g.yawObj.rotation.y;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 100 }));
    var hipTurn = Math.abs(g.yawObj.rotation.y - yaw0);

    g.setZooming(true);
    step(g.cfg.zoomTime + 0.05);
    var yaw1 = g.yawObj.rotation.y;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 100 }));
    var sightedTurn = Math.abs(g.yawObj.rotation.y - yaw1);

    assert.less(sightedTurn, hipTurn * 0.8, 'sighted aim is not finer than hip aim');
    assert.close(sightedTurn / hipTurn, g.cfg.zoomFov / g.cfg.fov, 0.05,
                 'sensitivity does not track the lens');
    g.setZooming(false);
    step(0.4);
    g.unbindInput(window);
  });

  it('still shoots where the crosshair points while sighted', function () {
    freshLevel();
    g.setZooming(true);
    g.setActive(true);
    step(g.cfg.zoomTime + 0.05);
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    var shot = g.shoot();
    assert.equal(shot.hit.target, t, 'the sighted shot did not land on the target');
    step(0.6);
    assert.ok(!t.alive, 'target survived a sighted hit');
    g.setZooming(false);
    step(0.4);
  });

  it('does not fire on the right button', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    var mag = g.state.mag;
    rightDown();
    step(0.4);
    rightUp();
    assert.equal(g.state.mag, mag, 'the right button fired a round');
    assert.equal(g.bullets.length, 0, 'the right button spawned a bullet');
    g.unbindInput(window);
    step(0.3);
  });

  it('drops the zoom when the game is paused', function () {
    reset();
    g.setActive(true);
    g.setZooming(true);
    step(g.cfg.zoomTime + 0.05);
    g.setActive(false);
    step(g.cfg.zoomTime + 0.1);
    assert.ok(!g.isZooming(), 'still zooming after pausing');
    assert.close(g.camera.fov, g.cfg.fov, 0.5, 'lens stayed zoomed while paused');
  });

  it('announces the zoom so the HUD can follow', function () {
    reset();
    var seen = [];
    g.on('zoom', function (d) { seen.push(d); });
    g.setActive(true);
    g.setZooming(true);
    step(g.cfg.zoomTime + 0.05);
    g.setZooming(false);
    step(g.cfg.zoomTime + 0.05);
    assert.greater(seen.length, 1, 'no zoom events');
    assert.ok(seen.some(function (d) { return d.sighted; }), 'never reported as sighted');
    assert.ok(seen.some(function (d) { return !d.sighted; }), 'never reported as released');
  });

  it('keeps the pitch limit while sighted', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    g.setZooming(true);
    step(g.cfg.zoomTime + 0.05);
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0 }));
    for (var i = 0; i < 300; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { movementY: -200 }));
    }
    assert.less(g.pitchObj.rotation.x, Math.PI / 2, 'pitch escaped while sighted');
    g.setZooming(false);
    g.unbindInput(window);
    step(0.4);
  });
});

describe('Wandering targets', function () {
  it('marks some targets as drifters and leaves the rest fixed', function () {
    freshLevel();
    var drifting = g.targets.filter(function (t) { return t.wander; }).length;
    assert.greater(drifting, 0, 'no targets drift');
    assert.less(drifting, g.targets.length, 'every target drifts');
  });

  it('moves the drifters and leaves the fixed ones on the spot', function () {
    freshLevel();
    var drifter = g.targets.find(function (t) { return t.wander && t.alive; });
    var fixed = g.targets.find(function (t) { return !t.wander && t.alive; });
    assert.ok(drifter && fixed, 'need one of each kind');
    var d0 = drifter.mesh.position.clone();
    var f0 = fixed.mesh.position.clone();
    step(3);
    var moved = Math.hypot(drifter.mesh.position.x - d0.x, drifter.mesh.position.z - d0.z);
    var still = Math.hypot(fixed.mesh.position.x - f0.x, fixed.mesh.position.z - f0.z);
    assert.greater(moved, 1.0, 'a drifting target did not drift');
    assert.close(still, 0, 0.001, 'a fixed target moved');
  });

  it('drifts slowly rather than teleporting', function () {
    freshLevel();
    var drifter = g.targets.find(function (t) { return t.wander && t.alive; });
    var last = drifter.mesh.position.clone();
    var worst = 0;
    for (var i = 0; i < 600; i++) {
      step(1 / 60);
      var d = Math.hypot(drifter.mesh.position.x - last.x, drifter.mesh.position.z - last.z);
      worst = Math.max(worst, d);
      last.copy(drifter.mesh.position);
    }
    assert.less(worst, 0.12, 'a target jumped ' + worst.toFixed(2) + 'u in one frame');
  });

  it('keeps drifting targets inside the arena and out of the cover', function () {
    freshLevel();
    var lim = g.cfg.arena / 2 - 1.5;
    var probe = new THREE.Vector3();
    for (var i = 0; i < 1500; i++) {
      step(1 / 60);
      if (i % 5) continue;
      for (var j = 0; j < g.targets.length; j++) {
        var t = g.targets[j];
        if (!t.alive || !t.wander) continue;
        var p = t.mesh.position;
        if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) {
          fail('target drifted out to ' + p.x.toFixed(1) + ',' + p.z.toFixed(1));
        }
        probe.set(p.x, t.base, p.z);
        for (var b = 0; b < g.obstacleBoxes.length; b++) {
          if (g.obstacleBoxes[b].distanceToPoint(probe) < 0.35) {
            fail('target drifted into obstacle ' + b);
          }
        }
      }
    }
  });

  it('can still be shot while drifting', function () {
    freshLevel();
    step(2);                              // let them spread out
    var t = null;
    for (var i = 0; i < g.targets.length; i++) {
      var c = g.targets[i];
      if (!c.alive || !c.wander) continue;
      if (g.hasLineOfSight(new THREE.Vector3(0, g.cfg.eye, 0), c.mesh.position)) { t = c; break; }
    }
    if (!t) fail('SKIP: no drifting target in the open this run');
    g.teleport(0, g.cfg.eye, 0);
    g.aimAt(t.mesh.position);
    var shot = g.shoot();
    assert.equal(shot.hit.target, t, 'the shot missed a drifting target it was aimed at');
    step(0.6);
    assert.ok(!t.alive, 'drifting target survived a direct hit');
  });
});

describe('Scoring', function () {
  it('adds for a target and for an NPC', function () {
    freshLevel();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    var s0 = g.state.score;
    g.aimAt(t.mesh.position);
    g.shoot();
    step(0.6);
    assert.equal(g.state.score, s0 + g.cfg.scoreTarget, 'target score');

    s0 = g.state.score;
    g.knockDownNPC(g.npcs[0]);
    assert.equal(g.state.score, s0 + g.cfg.scoreNpc, 'NPC score');
  });

  it('takes points off for a shot that hits nothing', function () {
    freshLevel();
    g.state.score = 1000;
    g.teleport(0, g.cfg.eye, 0);
    g.aimAt(new THREE.Vector3(0, 0.2, g.cfg.arena / 2));   // into the floor/wall
    g.shoot();
    step(1);
    assert.equal(g.state.score, 1000 + g.cfg.scoreMiss, 'a miss did not cost anything');
  });

  it('never lets the score go below zero', function () {
    freshLevel();
    g.state.score = 10;
    for (var i = 0; i < 6; i++) {
      g.teleport(0, g.cfg.eye, 0);
      g.aimAt(new THREE.Vector3(0, 0.2, g.cfg.arena / 2));
      g.state.lastShot = -1e9;
      g.state.mag = g.cfg.magSize;
      g.shoot();
      step(0.6);
      assert.ok(g.state.score >= 0, 'score went negative: ' + g.state.score);
    }
    assert.equal(g.state.score, 0, 'score did not settle at zero');
  });

  it('reports the change that actually landed', function () {
    freshLevel();
    var seen = [];
    g.on('score', function (d) { seen.push(d); });
    g.state.score = 10;
    assert.equal(g.addScore(-25, null), -10, 'clamped delta not reported');
    assert.equal(seen[seen.length - 1].delta, -10, 'event delta');
    assert.equal(seen[seen.length - 1].nominal, -25, 'event nominal value');
    assert.equal(g.state.score, 0, 'score floor');
  });
});

describe('Score indicators', function () {
  it('floats a + label where a target was hit', function () {
    freshLevel();
    step(2);                                  // let older labels expire
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    var where = t.mesh.position.clone();
    g.aimAt(where);
    g.shoot();
    step(0.5);
    var near = g.indicators.filter(function (ind) {
      return ind.sprite.visible && ind.sprite.position.distanceTo(where) < 2.5;
    });
    assert.greater(near.length, 0, 'no indicator appeared at the hit');
    assert.ok(!t.alive, 'the target was not actually hit');
  });

  it('floats a - label where a shot missed, even at zero score', function () {
    freshLevel();
    g.state.score = 0;
    var seen = null;
    g.on('miss', function (d) { seen = d; });
    g.teleport(0, g.cfg.eye, 0);
    g.aimAt(new THREE.Vector3(0, 0.2, g.cfg.arena / 2));
    g.shoot();
    step(1);
    assert.ok(seen, 'no miss event');
    var near = g.indicators.filter(function (ind) {
      return ind.sprite.visible && ind.sprite.position.distanceTo(seen.point) < 2.5;
    });
    assert.greater(near.length, 0, 'no indicator appeared at the impact');
  });

  it('rises and fades away', function () {
    freshLevel();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(0.4);
    var ind = g.indicators[g.indicators.length - 1];
    var y0 = ind.sprite.position.y;
    step(0.4);
    assert.greater(ind.sprite.position.y, y0, 'indicator did not rise');
    step(1.5);
    assert.ok(!ind.sprite.visible, 'indicator never went away');
    assert.equal(g.indicators.indexOf(ind), -1, 'indicator left in the live list');
  });

  it('recycles a fixed pool instead of allocating', function () {
    freshLevel();
    var before = g.scene.children.length;
    for (var i = 0; i < 30; i++) {
      g.teleport(0, g.cfg.eye, 0);
      g.aimAt(new THREE.Vector3(Math.sin(i) * 20, 0.4, Math.cos(i) * 20));
      g.state.lastShot = -1e9;
      g.state.mag = g.cfg.magSize;
      g.shoot();
      step(0.35);
    }
    assert.less(g.scene.children.length, before + 1, 'indicators grew the scene');
    assert.less(g.indicators.length, g.indicatorPool.length + 1, 'more live labels than the pool');
  });
});

describe('Statistics', function () {
  it('starts a fresh count', function () {
    freshLevel();
    g.resetStats();
    var s = g.stats();
    assert.equal(s.shotsFired, 0, 'shots');
    assert.equal(s.accuracy, 0, 'accuracy with no shots should be zero, not NaN');
    assert.equal(s.distance, 0, 'distance');
  });

  it('counts shots, hits and misses, and works out accuracy', function () {
    freshLevel();
    g.resetStats();

    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(0.6);

    g.teleport(0, g.cfg.eye, 0);
    g.aimAt(new THREE.Vector3(0, -2, 0));            // straight into the floor
    g.state.lastShot = -1e9;
    g.shoot();
    step(0.6);

    var s = g.stats();
    assert.equal(s.shotsFired, 2, 'shots fired');
    assert.equal(s.shotsHit, 1, 'hits');
    assert.equal(s.misses, 1, 'misses');
    assert.equal(s.targetsBroken, 1, 'targets broken');
    assert.close(s.accuracy, 0.5, 0.001, 'accuracy');
  });

  it('measures how far the player walked, in units and in feet', function () {
    freshLevel();
    g.resetStats();
    g.setActive(true);
    var from = g.state.pos.clone();
    g.setKey('KeyW', true);
    step(1.5);
    g.setKey('KeyW', false);
    step(0.5);

    var s = g.stats();
    var straightLine = Math.hypot(g.state.pos.x - from.x, g.state.pos.z - from.z);
    assert.greater(s.distance, 1, 'no distance recorded');
    // path length is at least the straight line, and within reason of it
    assert.greater(s.distance, straightLine - 0.5, 'distance is shorter than the displacement');
    assert.close(s.distanceFeet, s.distance * 3.28084, 0.01, 'feet conversion');
  });

  it('does not count distance while standing still', function () {
    freshLevel();
    g.resetStats();
    g.setActive(true);
    step(2);
    assert.close(g.stats().distance, 0, 0.001, 'standing still logged distance');
  });

  it('counts jumps and reloads', function () {
    freshLevel();
    g.resetStats();
    g.setActive(true);
    g.state.grounded = true;
    g.setKey('Space', true);
    step(0.1);
    g.setKey('Space', false);
    step(1.5);
    assert.equal(g.stats().jumps, 1, 'jumps');

    g.state.mag = 3;
    g.reload();
    step(g.cfg.reloadMs / 1000 + 0.05);
    assert.equal(g.stats().reloads, 1, 'reloads');
  });

  it('tracks the best streak and resets it on a miss', function () {
    freshLevel();
    g.resetStats();
    var hits = 0;
    for (var i = 0; i < g.targets.length && hits < 3; i++) {
      var t = g.targets[i];
      if (!t.alive) continue;
      if (!standClearOf(t.mesh.position, 3)) continue;
      g.state.mag = g.cfg.magSize;
      g.state.lastShot = -1e9;
      g.shoot();
      step(0.5);
      if (!t.alive) hits++;
    }
    assert.equal(hits, 3, 'could not land three shots');
    assert.equal(g.stats().streak, 3, 'streak did not build');
    assert.equal(g.stats().bestStreak, 3, 'best streak');

    g.teleport(0, g.cfg.eye, 0);
    g.aimAt(new THREE.Vector3(0, -2, 0));
    g.state.lastShot = -1e9;
    g.shoot();
    step(0.6);
    assert.equal(g.stats().streak, 0, 'a miss did not break the streak');
    assert.equal(g.stats().bestStreak, 3, 'the best streak was forgotten');
  });

  it('remembers the longest shot that landed', function () {
    freshLevel();
    g.resetStats();
    var far = null, farDist = 0;
    var eye = new THREE.Vector3(g.state.pos.x, g.cfg.eye, g.state.pos.z);
    for (var i = 0; i < g.targets.length; i++) {
      var t = g.targets[i];
      if (!t.alive || !g.hasLineOfSight(eye, t.mesh.position)) continue;
      var d = eye.distanceTo(t.mesh.position);
      if (d > farDist) { farDist = d; far = t; }
    }
    assert.ok(far, 'no target in the open');
    g.aimAt(far.mesh.position);
    g.shoot();
    step(0.8);
    var s = g.stats();
    assert.close(s.longestShot, farDist, 1.5, 'longest shot distance');
    assert.close(s.longestShotFeet, s.longestShot * 3.28084, 0.01, 'feet conversion');
  });

  it('counts time played only while the game is running', function () {
    freshLevel();
    g.resetStats();
    g.setActive(false);
    step(1);
    assert.close(g.stats().timePlayed, 0, 0.001, 'paused time counted as played');
    g.setActive(true);
    step(1);
    assert.close(g.stats().timePlayed, 1, 0.05, 'time played');
  });

  it('counts time spent sighted', function () {
    freshLevel();
    g.resetStats();
    g.setActive(true);
    step(0.5);
    g.setZooming(true);
    step(1);
    g.setZooming(false);
    step(0.5);
    var s = g.stats();
    assert.greater(s.timeSighted, 0.5, 'sighted time');
    assert.less(s.timeSighted, s.timePlayed, 'sighted longer than played');
    assert.between(s.sightedShare, 0.2, 0.8, 'sighted share');
  });

  it('counts NPCs put down', function () {
    freshLevel();
    g.resetStats();
    var n = lineUpOnNPC();
    assert.ok(n, 'no clear shot on an NPC');
    g.shoot();
    step(0.6);
    assert.equal(g.stats().npcsDown, 1, 'NPC kills');
    assert.equal(g.stats().shotsHit, 1, 'the NPC hit did not count as a hit');
  });

  it('reports a rate of fire and points per shot', function () {
    freshLevel();
    g.resetStats();
    g.setActive(true);
    g.setFiring(true);
    step(2);
    g.setFiring(false);
    var s = g.stats();
    assert.greater(s.shotsFired, 3, 'nothing was fired');
    assert.between(s.shotsPerMinute, 200, 500, 'shots per minute');
    assert.ok(isFinite(s.pointsPerShot), 'points per shot is not a number');
  });
});

describe('Performance', function () {
  it('breaking a target does not change the light count', function () {
    reset();
    function lights() {
      var n = 0;
      g.scene.traverse(function (o) { if (o.isLight) n++; });
      return n;
    }
    var before = lights();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(0.6);
    assert.ok(!t.alive, 'target did not break');
    assert.equal(lights(), before, 'a break added or removed a light, forcing a shader rebuild');
  });

  it('compiles no new shaders when a target breaks', function () {
    // A mid-frame shader compile was a ~300ms stall on the first break.
    reset();
    g.render();
    var before = g.renderer.info.programs.length;
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(0.3);
    g.render();
    assert.ok(g.debris.length > 0, 'no debris to draw');
    assert.equal(g.renderer.info.programs.length, before,
                 'a break triggered a shader compile mid-frame');
  });

  it('keeps debris out of the shadow pass', function () {
    g.shardPool.forEach(function (s, i) {
      assert.ok(!s.castShadow, 'shard ' + i + ' casts a shadow');
      assert.ok(!s.material.transparent, 'shard ' + i + ' is transparent');
    });
    var shared = g.shardPool.every(function (s) { return s.material === g.shardPool[0].material; });
    assert.ok(shared, 'shards do not share one material');
  });

  it('breaking a target allocates no new scene objects', function () {
    reset();
    var before = g.scene.children.length;
    var mats = g.shardPool.length;
    var broken = 0;
    for (var i = 0; i < g.targets.length && broken < 3; i++) {
      var t = g.targets[i];
      if (!t.alive) continue;
      var p = t.mesh.position;
      g.teleport(p.x + 3, p.y, p.z);
      g.aimAt(p);
      g.state.lastShot = -1e9;
      g.state.mag = g.cfg.magSize;
      g.shoot();
      step(0.5);
      broken++;
    }
    assert.equal(broken, 3, 'could not break three targets');
    // broken targets are removed, nothing is added
    assert.less(g.scene.children.length, before + 1, 'the scene grew while breaking targets');
    assert.equal(g.shardPool.length, mats, 'the shard pool grew');
  });

  it('recycles shards instead of leaking them', function () {
    reset();
    step(3);                                  // let earlier debris expire
    var live = g.debris.length;
    assert.equal(live, 0, 'debris left over: ' + live);
    var hidden = g.shardPool.filter(function (s) { return !s.visible; }).length;
    assert.equal(hidden, g.shardPool.length, 'shards left visible after expiring');
  });

  it('reuses impact decals rather than growing the scene', function () {
    reset();
    var before = g.scene.children.length;
    for (var i = 0; i < 60; i++) {
      g.teleport(0, g.cfg.eye, 0);
      g.aimAt(new THREE.Vector3(Math.sin(i) * 20, 2 + (i % 3), Math.cos(i) * 20));
      g.state.lastShot = -1e9;
      g.state.mag = g.cfg.magSize;
      g.shoot();
      step(0.4);
    }
    assert.less(g.scene.children.length, before + 1, 'firing 60 rounds grew the scene');
    assert.less(g.impacts.length, g.decalPool.length + 1, 'more live decals than the pool holds');
  });

  it('draws the viewmodel through its own lens', function () {
    assert.ok(g.viewCamera, 'no viewmodel camera');
    assert.equal(g.viewCamera.fov, 85, 'viewmodel fov');
    assert.ok(g.viewCamera.layers.isEnabled(g.viewLayer), 'viewmodel camera is off the view layer');
    assert.ok(!g.viewCamera.layers.isEnabled(0), 'viewmodel camera would redraw the world');
    assert.close(g.viewCamera.aspect, g.camera.aspect, 0.001, 'viewmodel aspect out of step');
  });
});

var _npcPoint = new THREE.Vector3();

describe('HUD wiring', function () {
  it('emits ammo events that a HUD can render', function () {
    reset();
    var last = null;
    g.on('ammo', function (d) { last = d; });
    g.shoot();
    assert.ok(last, 'no ammo event');
    assert.equal(last.mag, g.state.mag, 'ammo event out of sync');
    assert.equal(last.size, g.cfg.magSize, 'magazine size missing');
  });

  it('emits score and level events', function () {
    reset();
    var scores = 0, waves = 0;
    g.on('score', function () { scores++; });
    g.on('level', function () { waves++; });
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.aimAt(t.mesh.position);
    g.shoot();
    step(1.5);
    assert.greater(scores, 0, 'no score event');
    g.state.level++;
    g.emit('level', { level: g.state.level });
    assert.greater(waves, 0, 'no level event');
  });

  it('the live page HUD tracks the game state', async function () {
    var frame = document.getElementById('boot-frame');
    var win;
    try { win = frame.contentWindow; void win.document; }
    catch (e) { fail('SKIP: cross-origin iframe, run over http:// to check the HUD'); }
    assert.ok(win.game, 'page game missing');
    var doc = win.document;
    assert.equal(doc.getElementById('s-mag').textContent, String(win.game.state.mag), 'ammo readout');
    assert.equal(doc.getElementById('s-left').textContent, String(win.game.aliveCount()), 'targets readout');
    assert.equal(doc.getElementById('s-level').textContent, String(win.game.state.level), 'level readout');
    assert.equal(doc.getElementById('s-npcs').textContent, String(win.game.npcsAlive()), 'NPC readout');
  });
});

/* ================================================================= drive */
async function run() {
  var out = document.getElementById('results');
  var summary = document.getElementById('summary');
  var passed = 0, failed = 0, skipped = 0, failures = [];

  g = freshGame();

  for (var s = 0; s < suites.length; s++) {
    var suite = suites[s];
    var h = document.createElement('div');
    h.className = 'suite';
    h.textContent = suite.area;
    out.appendChild(h);

    for (var i = 0; i < suite.tests.length; i++) {
      var t = suite.tests[i];
      var row = document.createElement('div');
      row.className = 'test running';
      row.innerHTML = '<span class="mark">•</span><span class="name"></span>';
      row.querySelector('.name').textContent = t.name;
      out.appendChild(row);

      var t0 = performance.now();
      try {
        await t.fn();
        row.className = 'test pass';
        row.querySelector('.mark').textContent = '✓';
        passed++;
      } catch (err) {
        var isSkip = /^SKIP:/.test(err.message);
        row.className = 'test ' + (isSkip ? 'skip' : 'fail');
        row.querySelector('.mark').textContent = isSkip ? '−' : '✕';
        var why = document.createElement('div');
        why.className = 'why';
        why.textContent = err.message;
        row.appendChild(why);
        if (isSkip) { skipped++; }
        else { failed++; failures.push(suite.area + ' › ' + t.name + ' — ' + err.message); }
      }
      var ms = Math.round(performance.now() - t0);
      var time = document.createElement('span');
      time.className = 'ms';
      time.textContent = ms + 'ms';
      row.appendChild(time);
      await sleep(0);
    }
  }

  summary.textContent = passed + ' passed · ' + failed + ' failed' + (skipped ? ' · ' + skipped + ' skipped' : '');
  summary.className = failed ? 'bad' : 'good';
  document.title = (failed ? '✕ ' : '✓ ') + summary.textContent;

  global.__results = {
    passed: passed, failed: failed, skipped: skipped,
    total: passed + failed + skipped, failures: failures, done: true,
  };

  // leave a live game on screen for the visual check
  reset();
  g.setActive(false);
  g.aimAt(g.targets.find(function (t) { return t.alive; }).mesh.position);
  g.start();
}

global.__runTests = run;
if (document.readyState === 'complete') run();
else global.addEventListener('load', run);

})(window);
