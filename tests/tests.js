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
  // nobody starts a test on the floor, whatever the last one left behind
  g.setHealth(g.cfg.playerHealth, g.cfg.playerHealth);
  g.state.deathT = 0;
  g.camera.rotation.set(0, 0, 0);
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
  var radii = range ? [range, range + 1.5, range + 3] : [4, 5.5, 7];
  for (var ri = 0; ri < radii.length; ri++) {
    var r = radii[ri];
    for (var a = 0; a < Math.PI * 2; a += Math.PI / 12) {
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
  }
  return false;
}

// A clear target: alive, and with an unobstructed line from the player's eye.
/* A target this player can actually shoot from where they stand.
 *
 * Line of sight alone is not enough: it says nothing is in the way of the
 * centre line, while the shot is judged by a raycast from the camera, and the
 * two disagree around the edges of cover. Aiming at each candidate and asking
 * where the round would land picks one that can really be hit, which keeps
 * these tests about what they are testing rather than about the arena the
 * seed happened to build. */
function findClearTarget(fromY) {
  var eye = new THREE.Vector3(g.state.pos.x, fromY === undefined ? g.cfg.eye : fromY, g.state.pos.z);
  var yaw = g.yawObj.rotation.y;
  var pitch = g.pitchObj.rotation.x;
  var found = null;
  for (var i = 0; i < g.targets.length && !found; i++) {
    var t = g.targets[i];
    if (!t.alive || !g.hasLineOfSight(eye, t.mesh.position)) continue;
    g.aimAt(t.mesh.position);
    var hit = g.traceShot(
      g.camera.getWorldPosition(new THREE.Vector3()),
      g.camera.getWorldDirection(new THREE.Vector3())
    );
    if (hit.target === t) found = t;
  }
  /* Nothing in view from here. The arena is eighty across with rooms and a
   * house in it now, so standing at the spawn and looking around is no longer
   * a reliable way to find anything — go and stand where one can be seen.
   * Only a fallback: a target already in view is still shot from where the
   * caller was, which is what most of these tests are about. */
  for (var r = 0; r < g.targets.length && !found; r++) {
    var want = g.targets[r];
    if (!want.alive) continue;
    for (var a = 0; a < Math.PI * 2 && !found; a += Math.PI / 8) {
      for (var reach = 4; reach <= 10 && !found; reach += 3) {
        var at = new THREE.Vector3(
          want.mesh.position.x + Math.sin(a) * reach, g.cfg.eye,
          want.mesh.position.z + Math.cos(a) * reach);
        var lim = g.cfg.arena / 2 - 2;
        if (Math.abs(at.x) > lim || Math.abs(at.z) > lim) continue;
        var probe = g.playerBox(at, new THREE.Box3());
        if (g.colliders.some(function (c) { return c.intersectsBox(probe); })) continue;
        if (!g.hasLineOfSight(at, want.mesh.position)) continue;
        g.teleport(at.x, g.cfg.eye, at.z);
        g.aimAt(want.mesh.position);
        var shot = g.traceShot(
          g.camera.getWorldPosition(new THREE.Vector3()),
          g.camera.getWorldDirection(new THREE.Vector3())
        );
        if (shot.target === want) found = want;
      }
    }
  }

  // leave the camera where we found it, so callers aim for themselves
  g.yawObj.rotation.y = yaw;
  g.setPitch(pitch);
  g.yawObj.updateMatrixWorld(true);
  return found;
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

  it('gives every obstacle a collider the same size as the obstacle', function () {
    /* The collider is an axis-aligned box fitted around the mesh. Rotate the
     * mesh by anything but a quarter turn and the box grows past what you can
     * see — you get stopped by cover you have not reached. */
    var size = new THREE.Vector3();
    g.obstacleMeshes.forEach(function (m, i) {
      /* A ramp is the exception, and deliberately: its collider is a short
       * flight of steps inscribed under the slope, because a box around a
       * wedge is a wall you can see over and cannot climb. Its entry on the
       * obstacle list is its whole volume, which is what spawning keeps out
       * of, and it is checked for that further down rather than here. */
      if (m.name === 'wedge') return;
      var p = m.geometry.parameters;
      g.obstacleBoxes[i].getSize(size);

      // a quarter turn swaps width and depth, so compare the footprint either way
      var visual = [Math.min(p.width, p.depth), Math.max(p.width, p.depth)];
      var box = [Math.min(size.x, size.z), Math.max(size.x, size.z)];

      assert.close(box[0], visual[0], 0.01, 'obstacle ' + i + ' collider is the wrong width');
      assert.close(box[1], visual[1], 0.01, 'obstacle ' + i + ' collider is the wrong depth');
      assert.close(size.y, p.height, 0.01, 'obstacle ' + i + ' collider is the wrong height');
    });
  });

  it('gives a ramp steps that stay under its slope', function () {
    /* Never above the surface: a collider poking out of a ramp stops a player
     * in mid-air on nothing. Under it by a little is the cost of the trade. */
    var ramps = g.structures.filter(function (s) { return s.kind === 'wedge'; });
    assert.greater(ramps.length, 0, 'no ramps in the arena');
    ramps.forEach(function (r, i) {
      assert.greater(r.steps.length, 0, 'ramp ' + i + ' has nothing to walk up');
      r.steps.forEach(function (c) {
        assert.less(c.max.y, r.box.max.y + 0.01,
                    'ramp ' + i + ' has a step standing above its slope');
        assert.ok(g.colliders.indexOf(c) !== -1,
                  'ramp ' + i + ' has a step nothing collides with');
      });
      /* Each step is a solid block from the floor up to its own tread — the
       * balcony stairs are built the same way, because boxes centred on their
       * own middles leave gaps between treads half again as tall as the rise.
       * So what has to be small is the step up from one tread to the next. */
      var treads = r.steps.map(function (c) { return c.max.y; }).sort(function (a, b) {
        return a - b;
      });
      var below = 0;
      treads.forEach(function (top) {
        /* Well under what a player can step up, not merely within it: at the
         * full step height this is a staircase you climb in lurches, which is
         * not what a slope should feel like. */
        assert.less(top - below, g.cfg.stepHeight / 3,
                    'ramp ' + i + ' rises ' + (top - below).toFixed(2) +
                    'u at a time — that is a staircase, not a ramp');
        below = top;
      });
    });
  });

  it('only turns obstacles in quarter turns', function () {
    g.obstacleMeshes.forEach(function (m, i) {
      var quarters = m.rotation.y / (Math.PI / 2);
      assert.close(quarters, Math.round(quarters), 1e-6,
                   'obstacle ' + i + ' sits at ' + (m.rotation.y * 180 / Math.PI).toFixed(1) +
                   ' degrees, so its collider is bigger than it is');
    });
  });

  it('stops the player at the face of the cover, not short of it', function () {
    // walk into a piece of cover and check where we come to rest
    reset();
    g.setActive(true);
    var worst = 0, worstAt = '';
    for (var i = 0; i < g.obstacleBoxes.length; i += 4) {
      var box = g.obstacleBoxes[i];
      if (box.max.y < 1.2) continue;
      // a ramp is for walking up, so coming to rest at its face is exactly
      // what it must not do
      if (g.obstacleMeshes[i] && g.obstacleMeshes[i].name === 'wedge') continue;
      var c = box.getCenter(new THREE.Vector3());
      var size = box.getSize(new THREE.Vector3());
      var startX = c.x + size.x / 2 + 5;
      if (Math.abs(startX) > g.cfg.arena / 2 - 2) continue;

      reset();
      g.setActive(true);
      g.teleport(startX, g.cfg.eye, c.z);
      var probe = g.playerBox(g.state.pos, new THREE.Box3());
      if (g.colliders.some(function (o) { return o.intersectsBox(probe); })) continue;
      /* And the run-up has to be clear. Cover comes in structures now — the
       * far wall of a room, the fence around the house — so a walk at one box
       * can be stopped by another one entirely, which is correct behaviour and
       * proves nothing about the box being aimed at. */
      if (!g.hasLineOfSight(g.state.pos.clone(), c)) continue;
      g.aimAt(c);
      g.setKey('KeyW', true);
      step(3);
      g.setKey('KeyW', false);

      // the gap between the player's edge and the face of the cover
      var gap = (g.state.pos.x - g.cfg.radius) - box.max.x;
      if (gap > worst) { worst = gap; worstAt = 'obstacle ' + i; }
    }
    assert.less(worst, 0.15,
                'stopped ' + worst.toFixed(2) + 'u short of ' + worstAt);
  });

  it('registers a collider for every wall, obstacle, slider and structure', function () {
    /* One each for the four walls, the sliders and the balcony's parts, one
     * for every obstacle — and a ramp brings several, since its slope is
     * stepped. Counting the steps rather than assuming one apiece keeps this
     * honest about what is actually in the list. */
    var rampSteps = 0;
    g.structures.filter(function (s) { return s.kind === 'wedge'; }).forEach(function (r) {
      // the steps themselves rather than the formula that made them: this is
      // a count of what is in the list, not a second copy of the arithmetic
      rampSteps += r.steps.length;
    });
    var ramps = g.obstacleMeshes.filter(function (m) { return m.name === 'wedge'; }).length;
    assert.equal(g.colliders.length,
                 4 + (g.obstacleMeshes.length - ramps) + rampSteps +
                 g.movers.length + g.balcony.parts.length,
                 'collider count');
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
    // freshly placed, before any of them have drifted anywhere
    freshLevel();
    g.targets.forEach(function (t, i) {
      var d = Math.hypot(t.mesh.position.x, t.mesh.position.z);
      assert.greater(d, 7.9, 'target ' + i + ' was placed in the player lap');
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
    // the nearest clear one: a target across the arena barely covers the
    // middle pixel, so the sample lands on whatever is behind it
    var eye = new THREE.Vector3(g.state.pos.x, g.cfg.eye, g.state.pos.z);
    var t = null, best = Infinity;
    for (var i = 0; i < g.targets.length; i++) {
      var c = g.targets[i];
      if (!c.alive || !g.hasLineOfSight(eye, c.mesh.position)) continue;
      var d = eye.distanceTo(c.mesh.position);
      if (d < best) { best = d; t = c; }
    }
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
      // a ramp is walked up, not walked into: its volume is meant to be entered
      if (g.obstacleMeshes[i] && g.obstacleMeshes[i].name === 'wedge') continue;
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
        // and be a run at this box rather than at whatever stands in front of it
        if (!g.hasLineOfSight(g.state.pos.clone(), c)) continue;
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

    // pick a target we can definitely shoot, clear the rest out of the way,
    // then take that one for real: the shot is what has to finish the level
    var last = null;
    for (var i = 0; i < g.targets.length && !last; i++) {
      if (g.targets[i].alive && standClearOf(g.targets[i].mesh.position, 3)) {
        last = g.targets[i];
      }
    }
    assert.ok(last, 'no target with a clear line of sight');

    for (var j = 0; j < g.targets.length; j++) {
      var t = g.targets[j];
      if (t.alive && t !== last) g.breakTarget(t, new THREE.Vector3(0, 1, 0));
    }
    assert.equal(g.aliveCount(), 1, 'expected one target left');
    assert.equal(g.state.level, level0, 'the level turned over without the last target');

    // it drifts, so line up again each time until the shot lands
    for (var attempt = 0; attempt < 8 && g.state.level === level0; attempt++) {
      if (!standClearOf(last.mesh.position, 3)) { step(0.4); continue; }
      g.state.mag = g.cfg.magSize;
      g.state.lastShot = -1e9;
      g.shoot();
      step(0.6);
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
    var peak = 0, tucked = false, left = false, landed = false;
    // watch one jump through to the ground: running a fixed window instead can
    // catch the start of the next jump and look like it never came down
    for (var i = 0; i < 200 && !landed; i++) {
      step(1 / 60);
      peak = Math.max(peak, n.root.position.y);
      if (!n.grounded) {
        left = true;
        if (n.legL.rotation.x < -0.3) tucked = true;
      } else if (left) {
        landed = true;
      }
    }
    assert.ok(left, 'npc never left the ground');
    assert.greater(peak, 0.6, 'npc barely hopped');
    assert.ok(tucked, 'npc did not tuck its legs while airborne');
    assert.ok(landed, 'npc never came down');
    assert.close(n.root.position.y, 0, 0.01, 'npc did not land on the floor');
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
    // stand somewhere with a clear line rather than trusting that whichever
    // body the seed put third is out in the open
    var n = lineUpOnNPC();
    assert.ok(n, 'no NPC in the open to shoot at');
    var hit = g.traceShot(
      g.camera.getWorldPosition(new THREE.Vector3()),
      g.camera.getWorldDirection(new THREE.Vector3())
    );
    assert.ok(hit.npc, 'the NPC is not solid to bullets');
    assert.less(hit.distance, 5, 'bullet stopped behind the NPC');
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

describe('The balcony', function () {
  it('is built with a deck, supports, a railing and stairs', function () {
    assert.ok(g.balcony, 'no balcony');
    assert.greater(g.balcony.parts.length, 6, 'not enough pieces to be a balcony');
    var names = g.balcony.parts.map(function (p) { return p.mesh.name; });
    assert.ok(names.indexOf('balconyDeck') !== -1, 'no deck');
    assert.ok(names.indexOf('balconyPillar') !== -1, 'nothing holding it up');
    assert.ok(names.indexOf('balconyRail') !== -1, 'no railing');
    assert.ok(names.indexOf('balconyStep') !== -1, 'no way up');
  });

  it('puts the deck above head height', function () {
    assert.greater(g.balcony.height, g.cfg.playerHeight, 'you could not stand under it');
  });

  it('holds the player up when they stand on it', function () {
    reset();
    g.setActive(true);
    g.teleport(0, g.balcony.height + 3, g.balcony.z);
    step(2.5);
    assert.close(g.state.pos.y - g.cfg.eye, g.balcony.height + 0.2, 0.3,
                 'the player fell through the deck');
    assert.ok(g.state.grounded, 'not standing on it');
  });

  it('can be walked up the stairs without jumping', function () {
    reset();
    g.setActive(true);
    var steps = g.balcony.parts.filter(function (p) { return p.mesh.name === 'balconyStep'; });
    assert.greater(steps.length, 1, 'no stairs to climb');
    var lowest = steps.reduce(function (a, b) { return a.box.max.y < b.box.max.y ? a : b; });
    var c = lowest.box.getCenter(new THREE.Vector3());
    g.teleport(c.x, g.cfg.eye, c.z + 3);
    g.aimAt(new THREE.Vector3(c.x, g.cfg.eye, c.z - 6));
    var startY = g.state.pos.y;
    g.setKey('KeyW', true);
    step(5);
    g.setKey('KeyW', false);
    assert.greater(g.state.pos.y - startY, 1.5,
                   'the player never climbed: ' + (g.state.pos.y - startY).toFixed(2) + 'u');
  });

  it('does not let the player step up a whole wall', function () {
    reset();
    g.setActive(true);
    var tall = null;
    for (var i = 0; i < g.obstacleBoxes.length; i++) {
      if (g.obstacleBoxes[i].max.y > 3) { tall = g.obstacleBoxes[i]; break; }
    }
    assert.ok(tall, 'no tall cover in this arena');
    var c = tall.getCenter(new THREE.Vector3());
    g.teleport(c.x + 6, g.cfg.eye, c.z);
    g.aimAt(c);
    g.setKey('KeyW', true);
    step(3);
    g.setKey('KeyW', false);
    assert.close(g.state.pos.y, g.cfg.eye, 0.3, 'the player walked up a wall');
  });
});

describe('Moving obstacles', function () {
  it('puts a few sliders in the arena', function () {
    assert.equal(g.movers.length, g.cfg.movingObstacles, 'slider count');
    g.movers.forEach(function (m, i) {
      assert.greater(m.amp, 0, 'slider ' + i + ' does not travel');
      assert.greater(m.speed, 0, 'slider ' + i + ' has no speed');
    });
  });

  it('moves them along their track over time', function () {
    var m = g.movers[0];
    g.setWorldTime(0);
    var from = m.mesh.position.clone();
    // the sliders are slow on purpose, so sample a whole sweep rather than
    // one second, which can land on the turn where they barely move
    var travelled = 0;
    for (var t = 0.5; t <= 20; t += 0.5) {
      g.setWorldTime(t);
      travelled = Math.max(travelled, from.distanceTo(m.mesh.position));
    }
    assert.greater(travelled, 1, 'the slider barely moved across a full sweep');
    assert.less(travelled, m.amp * 2 + 0.01, 'it went further than its track');
  });

  it('is a pure function of the clock, so every client agrees', function () {
    var m = g.movers[1];
    g.setWorldTime(7.5);
    var at = m.mesh.position.clone();
    g.setWorldTime(30);
    g.setWorldTime(7.5);
    assert.less(m.mesh.position.distanceTo(at), 1e-9, 'the same time gave a different position');
  });

  it('keeps the collider with the mesh', function () {
    var m = g.movers[0];
    g.setWorldTime(3.3);
    var c = m.box.getCenter(new THREE.Vector3());
    assert.less(c.distanceTo(m.mesh.position), 0.01, 'the collider was left behind');
  });

  it('stays inside the arena for its whole run', function () {
    var lim = g.cfg.arena / 2;
    for (var t = 0; t < 30; t += 0.25) {
      g.setWorldTime(t);
      for (var i = 0; i < g.movers.length; i++) {
        var b = g.movers[i].box;
        assert.between(b.min.x, -lim, lim, 'slider ' + i + ' left the arena');
        assert.between(b.min.z, -lim, lim, 'slider ' + i + ' left the arena');
      }
    }
  });

  it('keeps the sliders off each other', function () {
    // two sharing ground pass straight through each other, and a player riding
    // one gets handed to the other as it crosses
    function sweep(m) {
      return new THREE.Box3(
        new THREE.Vector3(m.base.x - m.half.x - (m.axis.x ? m.amp : 0), 0,
                          m.base.z - m.half.z - (m.axis.z ? m.amp : 0)),
        new THREE.Vector3(m.base.x + m.half.x + (m.axis.x ? m.amp : 0), 1,
                          m.base.z + m.half.z + (m.axis.z ? m.amp : 0)));
    }
    for (var i = 0; i < g.movers.length; i++) {
      for (var j = i + 1; j < g.movers.length; j++) {
        assert.ok(!sweep(g.movers[i]).intersectsBox(sweep(g.movers[j])),
                  'sliders ' + i + ' and ' + j + ' share ground');
      }
    }
  });

  it('carries a player standing on one', function () {
    reset();
    g.setActive(true);
    var mv = g.movers[0];
    var c = mv.box.getCenter(new THREE.Vector3());
    g.teleport(c.x, mv.box.max.y + g.cfg.eye + 0.05, c.z);
    step(0.5);                                   // land on it
    assert.ok(g.state.standingOn === mv, 'not standing on the slider');

    var player = g.state.pos.clone();
    var box = mv.mesh.position.clone();
    step(3);
    var movedPlayer = new THREE.Vector3().subVectors(g.state.pos, player);
    var movedBox = new THREE.Vector3().subVectors(mv.mesh.position, box);

    assert.greater(movedBox.length(), 0.3, 'the slider did not travel far enough to tell');
    assert.close(movedPlayer.x, movedBox.x, 0.02, 'the player was left behind on x');
    assert.close(movedPlayer.z, movedBox.z, 0.02, 'the player was left behind on z');
    assert.close(g.state.pos.y - g.cfg.eye, mv.box.max.y, 0.05, 'no longer on top of it');
  });

  it('keeps a rider on board across a turnaround', function () {
    reset();
    g.setActive(true);
    var mv = g.movers[0];
    var c = mv.box.getCenter(new THREE.Vector3());
    g.teleport(c.x, mv.box.max.y + g.cfg.eye + 0.05, c.z);
    step(0.5);

    var worst = 0;
    for (var i = 0; i < 900; i++) {           // long enough to reverse a few times
      step(1 / 60);
      worst = Math.max(worst, Math.abs((g.state.pos.y - g.cfg.eye) - mv.box.max.y));
    }
    assert.less(worst, 0.1, 'fell off after ' + worst.toFixed(2) + 'u of drift');
    assert.ok(g.state.standingOn === mv, 'stopped riding it');
  });

  it('does not carry a player standing on the floor beside one', function () {
    reset();
    g.setActive(true);
    var mv = g.movers[0];
    var c = mv.box.getCenter(new THREE.Vector3());
    var size = mv.box.getSize(new THREE.Vector3());
    g.teleport(c.x + size.x / 2 + 2.5, g.cfg.eye, c.z + size.z / 2 + 2.5);
    step(0.5);
    assert.equal(g.state.standingOn, null, 'the floor counted as a slider');

    var from = g.state.pos.clone();
    step(2);
    assert.close(g.state.pos.distanceTo(from), 0, 0.01, 'the player was dragged along');
  });

  it('lets a rider walk off the edge', function () {
    reset();
    g.setActive(true);
    var mv = g.movers[0];
    var c = mv.box.getCenter(new THREE.Vector3());
    g.teleport(c.x, mv.box.max.y + g.cfg.eye + 0.05, c.z);
    step(0.5);
    assert.ok(g.state.standingOn === mv, 'not on it to begin with');

    // walk off the side and fall
    g.aimAt(new THREE.Vector3(c.x + 20, g.cfg.eye, c.z));
    g.setKey('KeyW', true);
    step(2.5);
    g.setKey('KeyW', false);
    step(1);
    assert.equal(g.state.standingOn, null, 'still riding it after walking off');
    assert.close(g.state.pos.y, g.cfg.eye, 0.35, 'did not come back down to the floor');
  });

  it('still stops a bullet where it currently stands', function () {
    reset();
    g.setWorldTime(2);
    var m = g.movers[0];
    var c = m.box.getCenter(new THREE.Vector3());
    g.teleport(c.x + 6, g.cfg.eye, c.z);
    g.aimAt(c);
    var hit = g.traceShot(g.camera.getWorldPosition(new THREE.Vector3()),
                          g.camera.getWorldDirection(new THREE.Vector3()));
    assert.less(hit.distance, 7, 'the shot went straight through the slider');
  });
});

describe('Perks', function () {
  function clearPerks() {
    g.perkSystem.clear();
    g.state.perks = {};
  }

  it('offers the five kinds', function () {
    var kinds = g.perkSystem.kinds.map(function (k) { return k.kind; }).sort().join(',');
    assert.equal(kinds, 'clip,doubleJump,fireRate,shield,speed', 'perk kinds');
  });

  it('gives the shield a shorter run than the rest', function () {
    var shield = g.perkSystem.kindByName('shield');
    assert.ok(shield, 'no shield perk');
    assert.less(g.perkSystem.durationOf('shield'), g.cfg.perkDuration,
                'the shield lasts as long as everything else');
    assert.equal(g.perkSystem.durationOf('speed'), g.cfg.perkDuration,
                 'the others should be on the standard duration');
  });

  it('says what each pickup is, above it', function () {
    freshLevel();
    clearPerks();
    var perk = g.perkSystem.spawn({ kind: 'shield', x: 8, y: 1.1, z: 8 });
    assert.ok(perk && perk.view, 'no pickup was built');
    assert.ok(perk.view.tag, 'the pickup has no label');
    assert.equal(perk.view.tag.text, 'SHIELD', 'the label says the wrong thing');
    assert.greater(perk.view.tag.sprite.position.y, 0.5, 'the label is not above it');
    assert.ok(perk.view.tag.sprite.material.depthTest,
              'the label reads through cover');
  });

  it('spawns them in the open, away from cover', function () {
    freshLevel();
    clearPerks();
    var probe = new THREE.Vector3();
    for (var i = 0; i < 12; i++) {
      var p = g.perkSystem.spawn();
      if (!p) continue;
      probe.set(p.x, 1.1, p.z);
      for (var b = 0; b < g.obstacleBoxes.length; b++) {
        assert.greater(g.obstacleBoxes[b].distanceToPoint(probe), 1.2,
                       'a perk spawned inside cover');
      }
      assert.between(p.x, -g.cfg.arena / 2, g.cfg.arena / 2, 'perk outside the arena');
    }
    clearPerks();
  });

  it('is collected by walking over it', function () {
    freshLevel();
    clearPerks();
    var p = g.perkSystem.spawn({ kind: 'speed', x: g.state.pos.x + 0.4, y: 1.1, z: g.state.pos.z });
    assert.ok(p, 'nothing spawned');
    var got = null;
    g.on('perk', function (d) { got = d; });
    g.setActive(true);
    step(0.2);
    assert.ok(got, 'walking over it did nothing');
    assert.equal(got.kind, 'speed');
    assert.equal(g.perkSystem.perks.length, 0, 'it was left on the ground');
    clearPerks();
  });

  it('runs out after its time is up', function () {
    freshLevel();
    clearPerks();
    g.grantPerk('speed');
    assert.ok(g.perkSystem.held(g.state, 'speed'), 'the perk did not take');
    step(g.cfg.perkDuration - 1);
    assert.ok(g.perkSystem.held(g.state, 'speed'), 'it expired early');
    step(2);
    assert.ok(!g.perkSystem.held(g.state, 'speed'), 'it never expired');
  });

  it('rapid fire really does fire faster', function () {
    freshLevel();
    clearPerks();
    var plain = g.fireInterval();
    g.grantPerk('fireRate');
    assert.less(g.fireInterval(), plain * 0.75, 'the interval did not shorten');

    reset();
    g.resetStats();
    g.grantPerk('fireRate');
    g.setActive(true);
    g.setFiring(true);
    step(1);
    g.setFiring(false);
    var fast = g.state.stats.shotsFired;

    reset();
    g.resetStats();
    clearPerks();
    g.setActive(true);
    g.setFiring(true);
    step(1);
    g.setFiring(false);
    var normal = g.state.stats.shotsFired;
    assert.greater(fast, normal * 1.4,
                   'rapid fire got ' + fast + ' rounds off against ' + normal);
  });

  it('the speed perk really does move faster', function () {
    freshLevel();
    clearPerks();
    function topSpeed() {
      reset();
      g.setActive(true);
      g.setKey('KeyW', true);
      var peak = 0;
      for (var i = 0; i < 200; i++) {
        g.update(1 / 120);
        peak = Math.max(peak, Math.hypot(g.state.vel.x, g.state.vel.z));
      }
      g.setKey('KeyW', false);
      return peak;
    }
    var plain = topSpeed();
    g.grantPerk('speed');
    var boosted = topSpeed();
    assert.greater(boosted, plain * 1.25, 'no faster with the perk');
    clearPerks();
  });

  it('the big clip perk holds more rounds', function () {
    freshLevel();
    clearPerks();
    var plain = g.magSize();
    g.grantPerk('clip');
    assert.greater(g.magSize(), plain, 'the magazine did not grow');
    g.state.mag = 1;
    g.reload();
    step(g.cfg.reloadMs / 1000 + 0.05);
    assert.equal(g.state.mag, g.magSize(), 'it did not fill to the bigger size');
    clearPerks();
  });

  it('the double jump perk gives exactly one extra jump', function () {
    freshLevel();
    clearPerks();
    reset();
    g.setActive(true);
    assert.equal(g.airJumpsAllowed(), 0, 'we start with a spare jump');

    g.grantPerk('doubleJump');
    assert.equal(g.airJumpsAllowed(), 1, 'the perk gave no extra jump');

    g.state.grounded = true;
    g.setKey('Space', true);
    step(0.2);
    g.setKey('Space', false);
    step(0.15);
    var risingVy = g.state.vy;
    g.setKey('Space', true);
    step(1 / 60);
    assert.greater(g.state.vy, risingVy, 'the second jump did not fire');
    g.setKey('Space', false);

    step(0.2);
    var vy = g.state.vy;
    g.setKey('Space', true);
    step(1 / 60);
    assert.less(g.state.vy, vy + 0.01, 'a third jump was allowed');
    g.setKey('Space', false);
    step(2);
    clearPerks();
  });

  it('gets you higher with the double jump than without', function () {
    freshLevel();
    clearPerks();
    function jumpPeak(withPerk) {
      reset();
      g.setActive(true);
      g.state.perks = {};
      if (withPerk) g.grantPerk('doubleJump');
      g.state.grounded = true;
      var peak = 0;
      g.setKey('Space', true);
      for (var i = 0; i < 20; i++) { g.update(1 / 60); peak = Math.max(peak, g.state.pos.y); }
      g.setKey('Space', false);
      for (var j = 0; j < 8; j++) { g.update(1 / 60); peak = Math.max(peak, g.state.pos.y); }
      g.setKey('Space', true);
      for (var k = 0; k < 60; k++) { g.update(1 / 60); peak = Math.max(peak, g.state.pos.y); }
      g.setKey('Space', false);
      step(2);
      return peak;
    }
    var plain = jumpPeak(false);
    var doubled = jumpPeak(true);
    assert.greater(doubled, plain + 0.4,
                   'double jump reached ' + doubled.toFixed(2) + ' against ' + plain.toFixed(2));
    clearPerks();
  });

  it('expires without leaving the effect behind', function () {
    freshLevel();
    clearPerks();
    var plain = g.fireInterval();
    g.grantPerk('fireRate');
    step(g.cfg.perkDuration + 0.5);
    assert.close(g.fireInterval(), plain, 0.001, 'the effect outlived the perk');
  });

  it('clears the ground when a perk times out', function () {
    freshLevel();
    clearPerks();
    var dropped = g.perkSystem.spawn({ kind: 'clip', x: 20, y: 1.1, z: 20, life: 0.5 });
    assert.equal(g.perkSystem.perks.length, 1, 'nothing on the ground');
    step(1);
    /* This one, rather than the list being empty: the world drops perks of its
     * own on a timer, and one landing during the step is not this one failing
     * to expire. */
    assert.equal(g.perkSystem.perks.indexOf(dropped), -1, 'it never timed out');
    clearPerks();
  });
});

describe('Facing the right way', function () {
  it('points a figure where it is looking, not away from it', function () {
    var fig = PB.buildFigure({
      geo: PB.figureGeometry(), shadows: false, variant: 'player',
      color: new THREE.Color(0.4, 0.6, 0.9), trim: new THREE.Color(0.2, 0.3, 0.5),
      accent: new THREE.Color(0, 0.8, 1),
    });
    // yaw 0 looks down -Z, so the visor must sit on the -Z side and the pack
    // on the +Z side, or the figure runs about with the pack in front
    var visor = fig.extras[0];
    var pack = fig.extras[1];
    assert.less(visor.position.z, 0, 'the visor is on the back of the head');
    assert.greater(pack.position.z, 0, 'the pack is on the chest');
  });

  it('turns an NPC to face the way it is running', function () {
    freshLevel();
    var n = g.npcs[0];
    step(0.5);
    // where the figure faces: its local -Z in world space
    var facing = new THREE.Vector3(0, 0, -1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), n.root.rotation.y);
    var travel = new THREE.Vector3(Math.sin(n.heading), 0, Math.cos(n.heading));
    assert.greater(facing.dot(travel), 0.9,
                   'the NPC is facing ' + facing.dot(travel).toFixed(2) + ' against its travel');
  });

  it('leans an NPC into its run rather than away from it', function () {
    freshLevel();
    var n = g.npcs[0];
    step(0.4);
    // the torso pitches forward, which is only forward if the body is the
    // right way round
    assert.greater(n.torso.rotation.x, 0, 'the torso leans backwards while running');
  });
});

describe('Jumping onto cover', function () {
  it('clears the low cover from flat ground', function () {
    reset();
    g.setActive(true);
    g.state.grounded = true;
    var peak = 0;
    g.setKey('Space', true);
    for (var i = 0; i < 40; i++) { g.update(1 / 60); peak = Math.max(peak, g.state.pos.y); }
    g.setKey('Space', false);
    step(2);
    var reach = (peak - g.cfg.eye) + g.cfg.stepHeight;
    assert.greater(reach, 2.4,
                   'a standing jump reaches ' + reach.toFixed(2) + 'u, too low for the cover');
  });

  it('lands the player on top of a low obstacle', function () {
    // Any low piece will do; some sit against a wall or another crate with no
    // room for a run-up, so work down the list until one can be reached.
    var candidates = g.obstacleBoxes
      .filter(function (b) { return b.max.y < 2.7; })
      .sort(function (a, b) { return a.max.y - b.max.y; });
    assert.greater(candidates.length, 0, 'no low cover in this arena');

    var landedOn = null;
    for (var i = 0; i < candidates.length && !landedOn; i++) {
      var low = candidates[i];
      var c = low.getCenter(new THREE.Vector3());
      var size = low.getSize(new THREE.Vector3());

      for (var side = 0; side < 4 && !landedOn; side++) {
        var dx = side === 0 ? 1 : side === 1 ? -1 : 0;
        var dz = side === 2 ? 1 : side === 3 ? -1 : 0;
        var startX = c.x + dx * (size.x / 2 + 3.0);
        var startZ = c.z + dz * (size.z / 2 + 3.0);
        if (Math.abs(startX) > g.cfg.arena / 2 - 2) continue;
        if (Math.abs(startZ) > g.cfg.arena / 2 - 2) continue;

        reset();
        g.setActive(true);
        g.teleport(startX, g.cfg.eye, startZ);
        var probe = g.playerBox(g.state.pos, new THREE.Box3());
        if (g.colliders.some(function (o) { return o.intersectsBox(probe); })) continue;

        g.aimAt(new THREE.Vector3(c.x, g.cfg.eye, c.z));
        g.setKey('KeyW', true);
        g.setKey('Space', true);
        step(1.6);
        g.setKey('Space', false);
        g.setKey('KeyW', false);
        step(1.2);
        if (Math.abs((g.state.pos.y - g.cfg.eye) - low.max.y) < 0.35) landedOn = low;
      }
    }
    assert.ok(landedOn, 'could not get on top of any low cover by jumping');
  });

  it('does not clear the tall cover on one jump', function () {
    reset();
    g.setActive(true);
    var tall = null;
    for (var i = 0; i < g.obstacleBoxes.length; i++) {
      if (g.obstacleBoxes[i].max.y > 4) { tall = g.obstacleBoxes[i]; break; }
    }
    if (!tall) return;                       // this arena has no tall pillars
    g.state.grounded = true;
    var peak = 0;
    g.setKey('Space', true);
    for (var j = 0; j < 40; j++) { g.update(1 / 60); peak = Math.max(peak, g.state.pos.y); }
    g.setKey('Space', false);
    step(2);
    assert.less((peak - g.cfg.eye) + g.cfg.stepHeight, tall.max.y,
                'a standing jump gets on top of the tall cover');
  });
});

describe('A stranded target heals itself', function () {
  function hitMessage(index, level) {
    return {
      kind: 'target', index: index, by: 7, level: level,
      origin: { x: 0, y: 1.7, z: 0 },
      point: { x: 1, y: 1, z: 1 },
      dir: { x: 0, y: 0, z: -1 },
      score: 100,
    };
  }

  it('puts back a target the server still has standing', function () {
    freshLevel();
    var index = g.targets.findIndex(function (t) { return t.alive; });
    var t = g.targets[index];

    g.breakTarget(t, new THREE.Vector3(0, 1, 0));
    assert.ok(!t.alive, 'the target did not break');
    assert.ok(!t.mesh.parent, 'it is still in the scene');

    assert.ok(g.reviveTarget(t), 'it could not be put back');
    assert.ok(t.alive, 'it is still counted as broken');
    assert.ok(t.mesh.visible, 'it came back invisible');
    assert.equal(t.mesh.parent, g.scene, 'it came back outside the scene');
  });

  it('can be shot again once it is back', function () {
    freshLevel();
    var t = findClearTarget();
    assert.ok(t, 'no clear target');
    g.breakTarget(t, new THREE.Vector3(0, 1, 0));
    g.reviveTarget(t);

    // the revived target has to be solid to a shot again, not a ghost.
    // it drifts, so line up again on each attempt.
    var landed = null;
    for (var attempt = 0; attempt < 8 && !landed; attempt++) {
      if (!standClearOf(t.mesh.position, 3)) { step(0.4); continue; }
      g.state.mag = g.cfg.magSize;
      g.state.lastShot = -1e9;
      var shot = g.shoot();
      if (shot && shot.hit.target === t) landed = shot;
      step(0.6);
    }
    assert.ok(landed, 'every shot passed through the revived target');
    assert.ok(!t.alive, 'it survived being shot');
  });

  it('brings the count back in line with the server', function () {
    freshLevel();
    // the shape of the bug: this client thinks the arena is empty while the
    // server still has one target standing, so nobody can finish the level
    var stranded = findClearTarget();
    assert.ok(stranded, 'no clear target');
    for (var i = 0; i < g.targets.length; i++) {
      if (g.targets[i].alive) g.breakTarget(g.targets[i], new THREE.Vector3(0, 1, 0));
    }
    assert.equal(g.aliveCount(), 0, 'the client should think it is empty');

    g.reviveTarget(stranded);
    assert.equal(g.aliveCount(), 1, 'the count did not come back');
    assert.ok(standClearOf(stranded.mesh.position, 3), 'cannot line up on it');
    g.state.mag = g.cfg.magSize;
    g.state.lastShot = -1e9;
    g.shoot();
    step(0.6);
    assert.ok(!stranded.alive, 'the revived target could not be shot');
    assert.equal(g.aliveCount(), 0, 'it is still counted after being shot');
  });

  it('ignores a hit adjudicated on a level we have already left', function () {
    freshLevel();
    var level = g.state.level;
    var index = g.targets.findIndex(function (t) { return t.alive; });
    var alive = g.aliveCount();

    // exactly the race: a hit from the previous level arriving after the next
    // one has been built, carrying an index that now means a different target
    g.applyServerHit(hitMessage(index, level - 1), false);
    assert.equal(g.aliveCount(), alive, 'a stale hit broke a target in this level');
    assert.ok(g.targets[index].alive, 'the wrong target was destroyed');

    // and one for the level we are actually on still lands
    g.applyServerHit(hitMessage(index, level), false);
    assert.ok(!g.targets[index].alive, 'a current hit was ignored');
  });

  it('does nothing when asked to revive a target that is already up', function () {
    freshLevel();
    var t = g.targets.find(function (t) { return t.alive; });
    assert.ok(!g.reviveTarget(t), 'reviving a standing target reported a change');
    assert.ok(t.alive, 'it is still standing');
  });
});

describe('Options', function () {
  function fakeStore() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      raw: data,
    };
  }

  it('starts from sensible defaults', function () {
    var o = PB.createOptions(fakeStore());
    assert.equal(o.get('sensitivity'), 1, 'sensitivity');
    assert.equal(o.get('masterVolume'), 0.8, 'master volume');
    assert.equal(o.get('name'), 'player', 'name');
    assert.equal(o.get('hitboxes'), false, 'hitboxes start off');
  });

  it('keeps settings in storage and reads them back', function () {
    var store = fakeStore();
    var o = PB.createOptions(store);
    o.set('name', 'ana');
    o.set('sensitivity', 2.5);
    o.set('masterVolume', 0.25);
    assert.ok(store.raw[o.key], 'nothing was written');

    var again = PB.createOptions(store);
    assert.equal(again.get('name'), 'ana', 'name did not survive');
    assert.equal(again.get('sensitivity'), 2.5, 'sensitivity did not survive');
    assert.equal(again.get('masterVolume'), 0.25, 'volume did not survive');
  });

  it('clamps anything out of range rather than trusting it', function () {
    var o = PB.createOptions(fakeStore());
    o.set('sensitivity', 999);
    assert.equal(o.get('sensitivity'), 5, 'sensitivity ceiling');
    o.set('sensitivity', -4);
    assert.equal(o.get('sensitivity'), 0.1, 'sensitivity floor');
    o.set('masterVolume', 4);
    assert.equal(o.get('masterVolume'), 1, 'volume ceiling');
  });

  it('refuses a name that would break the display', function () {
    var o = PB.createOptions(fakeStore());
    o.set('name', '');
    assert.equal(o.get('name'), 'player', 'an empty name was kept');
    o.set('name', 'a-very-long-name-indeed-far-too-long');
    assert.less(o.get('name').length, 17, 'the name was not trimmed');
    o.set('name', '<script>x</script>');
    assert.ok(o.get('name').indexOf('<') === -1, 'markup survived into the name');
  });

  it('survives storage holding rubbish', function () {
    var store = fakeStore();
    store.setItem('paintball.options', 'not json at all');
    var o = PB.createOptions(store);
    assert.equal(o.get('sensitivity'), 1, 'a corrupt store broke the defaults');

    store.setItem('paintball.options', JSON.stringify({
      sensitivity: 'fast', masterVolume: null, name: 42, nonsense: true,
    }));
    var b = PB.createOptions(store);
    assert.equal(b.get('sensitivity'), 1, 'a bad number was kept');
    assert.equal(b.get('masterVolume'), 0.8, 'a null volume was kept');
    assert.equal(b.get('name'), 'player', 'a numeric name was kept');
    assert.equal(b.all().nonsense, undefined, 'an unknown key was kept');
  });

  it('works when storage is unavailable', function () {
    var o = PB.createOptions(null);
    assert.equal(o.get('sensitivity'), 1, 'no defaults without storage');
    assert.ok(o.set('sensitivity', 2), 'setting failed without storage');
    assert.equal(o.get('sensitivity'), 2, 'the value was not held in memory');
  });

  it('tells anyone listening when something changes', function () {
    var o = PB.createOptions(fakeStore());
    var seen = [];
    o.onChange(function (k, v) { seen.push(k + '=' + v); });
    o.set('invertY', true);
    o.set('invertY', true);        // no change, so no second event
    assert.equal(seen.join(','), 'invertY=true', 'change events: ' + seen.join(','));
  });

  it('puts everything back on reset', function () {
    var o = PB.createOptions(fakeStore());
    o.set('name', 'ana');
    o.set('sensitivity', 3);
    o.reset();
    assert.equal(o.get('name'), 'player');
    assert.equal(o.get('sensitivity'), 1);
  });
});

describe('Settings that change the game', function () {
  it('turns the view faster at a higher sensitivity', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0 }));

    g.setSensitivity(1);
    var yaw0 = g.yawObj.rotation.y;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 100 }));
    var slow = Math.abs(g.yawObj.rotation.y - yaw0);

    g.setSensitivity(2);
    var yaw1 = g.yawObj.rotation.y;
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 100 }));
    var fast = Math.abs(g.yawObj.rotation.y - yaw1);

    assert.close(fast / slow, 2, 0.01, 'doubling sensitivity did not double the turn');
    g.setSensitivity(1);
    g.unbindInput(window);
  });

  it('holds sensitivity inside a usable range', function () {
    assert.equal(g.setSensitivity(1000), 5, 'no ceiling');
    assert.equal(g.setSensitivity(0), 0.1, 'no floor');
    assert.equal(g.setSensitivity('nonsense'), 1, 'a bad value was accepted');
    g.setSensitivity(1);
  });

  it('inverts the vertical look when asked', function () {
    reset();
    g.bindInput(window);
    g.setActive(true);
    window.dispatchEvent(new MouseEvent('mousemove', { movementY: 0 }));

    g.setInvertY(false);
    var p0 = g.pitchObj.rotation.x;
    window.dispatchEvent(new MouseEvent('mousemove', { movementY: 50 }));
    var normal = g.pitchObj.rotation.x - p0;

    g.setInvertY(true);
    var p1 = g.pitchObj.rotation.x;
    window.dispatchEvent(new MouseEvent('mousemove', { movementY: 50 }));
    var inverted = g.pitchObj.rotation.x - p1;

    assert.ok(normal * inverted < 0, 'inverting did not flip the direction');
    g.setInvertY(false);
    g.unbindInput(window);
  });

  it('carries the volume settings into the audio', function () {
    assert.ok(g.sfx.setVolume, 'no volume control');
    assert.equal(g.sfx.setVolume('master', 0.4), 0.4, 'master volume');
    assert.equal(g.sfx.getVolume('master'), 0.4, 'master volume not held');
    assert.equal(g.sfx.setVolume('gun', 0), 0, 'gunfire volume');
    assert.equal(g.sfx.setVolume('master', 5), 1, 'volume was not clamped');
    assert.equal(g.sfx.setVolume('master', -1), 0, 'volume was not clamped');
    g.sfx.setVolume('master', 0.8);
    g.sfx.setVolume('gun', 0.8);
  });
});

describe('Debug overlays', function () {
  it('draws a wireframe for every collider in the level', function () {
    assert.ok(g.debugView, 'no debug view');
    g.debugView.setColliders(true);
    assert.equal(g.debugView.colliderCount(), g.colliders.length,
                 'wireframe count does not match the colliders');
    assert.ok(g.debugView.colliderGroup.visible, 'the group is hidden');
  });

  it('hides them again without leaving anything behind', function () {
    g.debugView.setColliders(true);
    g.debugView.setColliders(false);
    assert.ok(!g.debugView.colliderGroup.visible, 'still visible');
    assert.equal(g.debugView.state.colliders, false, 'state not updated');
  });

  it('drags a wireframe along with the cover it belongs to', function () {
    g.debugView.setColliders(true);
    var mover = g.movers[0];
    var helper = null;
    g.debugView.colliderGroup.children.forEach(function (h) {
      if (h.box === mover.box) helper = h;
    });
    assert.ok(helper, 'the sliding cover has no wireframe');

    g.setWorldTime(0);
    helper.updateMatrixWorld(true);
    var a = helper.matrixWorld.elements.slice(12, 15).join(',');
    g.setWorldTime(9);
    helper.updateMatrixWorld(true);
    var b = helper.matrixWorld.elements.slice(12, 15).join(',');
    assert.ok(a !== b, 'the wireframe stayed behind when the cover moved');
    g.debugView.setColliders(false);
  });

  it('outlines what bullets are tested against', function () {
    freshLevel();
    g.debugView.setHitboxes(true);
    var expected = g.npcs.length + g.aliveCount();
    assert.equal(g.debugView.hitboxCount(), expected,
                 'expected an outline per NPC and live target');

    /* Every outline has to be genuinely renderable. Hanging one on the hitbox
     * itself looked right in the counts and drew nothing at all: the hitbox is
     * invisible, and three.js skips the whole subtree of an invisible object. */
    var outlines = g.debugView.hitboxGroup.userData.outlines;
    outlines.forEach(function (o, i) {
      var node = o;
      while (node) {
        assert.ok(node.visible, 'outline ' + i + ' hangs under something invisible');
        node = node.parent;
      }
    });

    // and they move with what they outline
    var npc = g.npcs[0];
    var mine = outlines.filter(function (o) {
      var n = o.parent;
      while (n) { if (n === npc.root) return true; n = n.parent; }
      return false;
    });
    assert.greater(mine.length, 0, 'the NPC has no outline attached to it');
    npc.root.position.set(11, 0, -6);
    npc.root.updateMatrixWorld(true);
    var at = new THREE.Vector3().setFromMatrixPosition(mine[0].matrixWorld);
    assert.close(at.x, 11, 0.01, 'the outline did not follow the NPC');
    assert.close(at.z, -6, 0.01, 'the outline did not follow the NPC');

    g.debugView.setHitboxes(false);
  });

  it('takes the outlines away again', function () {
    freshLevel();
    g.debugView.setHitboxes(true);
    g.debugView.setHitboxes(false);
    assert.equal(g.debugView.hitboxCount(), 0, 'outlines were left behind');
    var left = 0;
    g.npcs[0].root.traverse(function (c) { if (c.isLineSegments) left++; });
    assert.equal(left, 0, 'an outline is still attached to the NPC');
  });

  it('follows the world onto the next level', function () {
    freshLevel();
    g.debugView.setHitboxes(true);
    var before = g.debugView.hitboxCount();
    assert.greater(before, 0, 'nothing outlined to begin with');

    g.applyLevel({ level: g.state.level + 1, npcs: 3, targets: [[5, 1.5, 5, 0], [-5, 1.5, -5, 1]] });
    assert.equal(g.debugView.hitboxCount(), 3 + 2,
                 'the outlines did not follow the new level');
    g.debugView.setHitboxes(false);
    freshLevel();
  });

  it('leaves the game alone when it is off', function () {
    g.debugView.setHitboxes(false);
    g.debugView.setColliders(false);
    assert.ok(!g.debugView.colliderGroup.visible, 'colliders visible while off');
    assert.ok(!g.debugView.hitboxGroup.visible, 'hitboxes visible while off');
    assert.equal(g.debugView.hitboxCount(), 0, 'outlines left in place');
  });
});

describe('Name tags', function () {
  it('draws a readable label', function () {
    var tag = PB.createNameTag('ana', '#6ee7ff');
    assert.ok(tag.sprite, 'no sprite');
    assert.equal(tag.text, 'ana');
    assert.greater(tag.sprite.position.y, 1.8, 'the tag is not above the head');
    assert.ok(tag.sprite.material.depthTest === true,
              'the tag reads through cover, which is a wallhack');
    assert.ok(tag.sprite.material.depthWrite === false,
              'the tag writes depth and will punch through other tags');
  });

  it('sits on the figure so it follows them about', function () {
    var fig = PB.buildFigure({
      geo: PB.figureGeometry(), shadows: false, variant: 'player',
      color: new THREE.Color(0.3, 0.6, 0.9), trim: new THREE.Color(0.2, 0.3, 0.5),
      accent: new THREE.Color(0, 0.8, 1),
    });
    var tag = PB.createNameTag('bo', '#8ef2a0');
    fig.root.add(tag.sprite);
    fig.root.position.set(12, 0, -7);
    fig.root.updateMatrixWorld(true);
    var world = new THREE.Vector3().setFromMatrixPosition(tag.sprite.matrixWorld);
    assert.close(world.x, 12, 0.01, 'the tag did not move with the figure');
    assert.close(world.z, -7, 0.01, 'the tag did not move with the figure');
    assert.greater(world.y, 1.8, 'the tag is not above the head');
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
    g.aimAt(new THREE.Vector3(0, -2, 0));      // straight down: nothing can wander in
    g.shoot();
    step(1);
    assert.equal(g.state.score, 1000 + g.cfg.scoreMiss, 'a miss did not cost anything');
  });

  it('never lets the score go below zero', function () {
    freshLevel();
    g.state.score = 10;
    for (var i = 0; i < 6; i++) {
      g.teleport(0, g.cfg.eye, 0);
      g.aimAt(new THREE.Vector3(0, -2, 0));            // straight down at the floor
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
    var perksWere = g.cfg.perks;
    g.cfg.perks = false;          // a perk appearing would add to the scene too
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
    g.cfg.perks = perksWere;
  });
});

describe('Telling players from NPCs', function () {
  function build(variant) {
    return PB.buildFigure({
      geo: PB.figureGeometry(), shadows: false, variant: variant,
      color: new THREE.Color(0.5, 0.5, 0.5), trim: new THREE.Color(0.3, 0.3, 0.3),
      accent: new THREE.Color(0, 0.8, 1),
    });
  }

  it('gives a player gear an NPC does not have', function () {
    var player = build('player');
    var npc = build('npc');
    assert.ok(player.isPlayer, 'the player variant did not take');
    assert.ok(!npc.isPlayer, 'the NPC came out as a player');
    assert.greater(player.extras.length, 2, 'a player has no distinguishing parts');
    assert.equal(npc.extras.length, 0, 'an NPC picked up player gear');
  });

  it('carries a shield bubble, hidden until it is needed', function () {
    var player = build('player');
    assert.ok(player.shield, 'a player has no shield to put up');
    assert.ok(!player.shield.visible, 'the shield is up before anything happened');
    assert.ok(!build('npc').shield, 'an NPC got a shield');
  });

  it('makes the two silhouettes different', function () {
    var player = build('player');
    var npc = build('npc');
    player.root.updateMatrixWorld(true);
    npc.root.updateMatrixWorld(true);
    // only what you can actually see: the hitbox is invisible but 0.55 deep,
    // and it would swamp the comparison
    function visibleBox(root) {
      var box = new THREE.Box3();
      root.traverse(function (o) {
        if (o.isMesh && o.visible) box.expandByObject(o);
      });
      return box;
    }
    var pBox = visibleBox(player.root);
    var nBox = visibleBox(npc.root);
    assert.greater(pBox.max.z - nBox.max.z, 0.05, 'a player has no pack on their back');
    assert.greater(pBox.min.z - nBox.min.z, -0.9, 'the two are the same depth front to back');
    assert.greater(player.extras.length, 2, 'a player carries no gear an NPC does not');
    assert.equal(npc.extras.length, 0, 'an NPC picked up player gear');
  });

  it('turns the shield so it reads as a field, not a decal', function () {
    var player = build('player');
    player.shield.visible = true;
    PB.poseFigure(player, { phase: 0, grounded: true, moving: true });
    var r0 = player.shield.rotation.y;
    PB.poseFigure(player, { phase: 6, grounded: true, moving: true });
    assert.ok(Math.abs(player.shield.rotation.y - r0) > 0.001, 'the shield does not turn');
  });

  it('keeps NPC colours out of the band players use', function () {
    freshLevel();
    var hsl = {};
    g.npcs.forEach(function (n, i) {
      n.torso.material.color.getHSL(hsl);
      assert.ok(hsl.h < 0.45 || hsl.h > 0.8,
                'npc ' + i + ' is hue ' + hsl.h.toFixed(2) + ', inside the player band');
    });
  });

  it('poses a player figure the same way it poses an NPC', function () {
    var player = build('player');
    PB.poseFigure(player, { phase: 1.2, grounded: true, moving: true });
    assert.ok(Math.abs(player.legL.rotation.x) > 0.1, 'the legs did not swing');
    PB.poseFigure(player, { phase: 1.2, grounded: false, vy: 5 });
    assert.less(player.legL.rotation.x, 0, 'the legs did not tuck in the air');
  });
});

describe('Statistics belong to one player', function () {
  function hitMessage(kind, index) {
    return {
      kind: kind, index: index,
      by: 99,
      origin: { x: 0, y: 1.7, z: 0 },
      point: { x: 2, y: 1, z: 2 },
      dir: { x: 0, y: 0, z: -1 },
      normal: { x: 0, y: 1, z: 0 },
      score: 5000,
    };
  }

  it('does not count another shooter hit against our accuracy', function () {
    freshLevel();
    g.resetStats();
    var before = JSON.stringify(g.stats());
    g.applyServerHit(hitMessage('npc', 0), false);
    g.applyServerHit(hitMessage('miss'), false);
    var t = g.targets.findIndex(function (t) { return t.alive; });
    g.applyServerHit(hitMessage('target', t), false);
    assert.equal(JSON.stringify(g.stats()), before,
                 'shooting by another player moved our statistics');
  });

  it('still counts our own', function () {
    freshLevel();
    g.resetStats();
    g.applyServerHit(hitMessage('npc', 0), true);
    assert.equal(g.stats().npcsDown, 1, 'our own kill was not counted');
    assert.equal(g.stats().shotsHit, 1, 'our own hit was not counted');
    g.applyServerHit(hitMessage('miss'), true);
    assert.equal(g.stats().misses, 1, 'our own miss was not counted');
    assert.equal(g.stats().streak, 0, 'the miss did not break our streak');
  });

  it('still changes the world when somebody else shoots', function () {
    freshLevel();
    var index = g.targets.findIndex(function (t) { return t.alive; });
    g.applyServerHit(hitMessage('target', index), false);
    assert.ok(!g.targets[index].alive, 'their shot did not break the target for us');
    assert.greater(g.debris.length, 5, 'no debris from their shot');
  });

  it('marks whose hit it was so the HUD can tell', function () {
    freshLevel();
    var seen = [];
    g.on('hit', function (d) { seen.push(d.mine); });
    g.applyServerHit(hitMessage('npc', 0), true);
    g.applyServerHit(hitMessage('npc', 0), false);
    assert.equal(seen.join(','), 'true,false', 'hit events do not say who fired');
  });
});

describe('Seeing and hearing other players shoot', function () {
  it('draws a tracer along their line of fire', function () {
    freshLevel();
    var before = g.bullets.length;
    var mesh = g.showRemoteShot({
      by: 42,
      origin: { x: 0, y: 1.7, z: 0 },
      point: { x: 0, y: 1.7, z: -12 },
    });
    assert.ok(mesh, 'no tracer was created');
    assert.equal(g.bullets.length, before + 1, 'the tracer is not in flight');
    assert.less(mesh.position.distanceTo(new THREE.Vector3(0, 1.7, 0)), 0.01,
                'the tracer did not start at their muzzle');
  });

  it('flies the tracer to where their shot landed and then clears it', function () {
    freshLevel();
    while (g.bullets.length) { g.scene.remove(g.bullets[0].mesh); g.bullets.shift(); }
    g.showRemoteShot({
      by: 42,
      origin: { x: 0, y: 1.7, z: 0 },
      point: { x: 0, y: 1.7, z: -12 },
    });
    var b = g.bullets[0];
    assert.close(b.remaining, 12, 0.01, 'the tracer has the wrong distance to travel');
    step(0.05);
    assert.less(b.mesh.position.z, -1, 'the tracer did not move');
    step(0.5);
    assert.equal(g.bullets.length, 0, 'the tracer never cleared');
  });

  it('does not touch our ammunition or our statistics', function () {
    freshLevel();
    g.resetStats();
    var mag = g.state.mag;
    g.showRemoteShot({
      by: 42, origin: { x: 0, y: 1.7, z: 0 }, point: { x: 0, y: 1.7, z: -12 },
    });
    assert.equal(g.state.mag, mag, 'their shot cost us a round');
    assert.equal(g.stats().shotsFired, 0, 'their shot counted as ours');
  });

  it('ignores a malformed remote shot rather than throwing', function () {
    freshLevel();
    assert.equal(g.showRemoteShot({ by: 1 }), null, 'a shot with no origin was drawn');
    assert.equal(g.showRemoteShot({ by: 1, origin: { x: 0, y: 1, z: 0 } }), null,
                 'a shot with no landing point was drawn');
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
    //
    // Measured across the *second* break: rebuilding a level disposes its
    // target materials, so the first break after one can legitimately rebuild
    // a program that was released. What must never happen is a compile during
    // ordinary play, once everything has been drawn at least once.
    function breakOne() {
      var t = findClearTarget();
      if (!t) return false;
      g.aimAt(t.mesh.position);
      g.state.lastShot = -1e9;
      g.state.mag = g.cfg.magSize;
      g.shoot();
      // wait for the round to land rather than for a fixed time: it covers 36u
      // in the third of a second this used to allow, and the arena is eighty
      // across, so a target in plain sight can be further off than that
      for (var i = 0; i < 30 && g.bullets.length; i++) step(0.05);
      step(0.1);
      g.render();
      return !t.alive;
    }

    reset();
    g.render();
    assert.ok(breakOne(), 'could not break a target to warm up');

    var before = g.renderer.info.programs.length;
    assert.ok(breakOne(), 'could not break a second target');
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
    // and let the last one land: a round crosses 48u in the 0.4s above, which
    // was the whole arena once and is no longer half of it
    for (var w = 0; w < 40 && g.bullets.length; w++) step(0.1);
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

describe('What a shot is tested against', function () {
  function build(variant) {
    return PB.buildFigure({
      geo: PB.figureGeometry(), shadows: false, variant: variant,
      color: new THREE.Color(0.3, 0.6, 0.9), trim: new THREE.Color(0.2, 0.3, 0.5),
      accent: new THREE.Color(0, 0.8, 1),
    });
  }
  function visibleBox(fig) {
    var box = new THREE.Box3();
    fig.root.traverse(function (o) {
      if (o.isMesh && o.visible && o !== fig.hitbox) box.expandByObject(o);
    });
    return box;
  }

  it('is one definition, not a number written out in several places', function () {
    assert.ok(PB.HIT, 'no shared hit volume');
    assert.close(PB.HIT.height, PB.HIT.top - PB.HIT.bottom, 1e-6, 'height');
    assert.close(PB.HIT.midY, (PB.HIT.top + PB.HIT.bottom) / 2, 1e-6, 'middle');
  });

  it('sits on the figure exactly where the definition says', function () {
    var fig = build('player');
    fig.root.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(fig.hitbox);
    assert.close(box.min.y, PB.HIT.bottom, 0.001, 'floor of the box');
    assert.close(box.max.y, PB.HIT.top, 0.001, 'roof of the box');
    assert.close(box.max.x - box.min.x, PB.HIT.half * 2, 0.001, 'width');
    assert.close(box.max.z - box.min.z, PB.HIT.half * 2, 0.001, 'depth');
  });

  it('covers the torso and the head', function () {
    var fig = build('npc');
    PB.poseFigure(fig, { phase: 0, grounded: true, moving: false });
    fig.root.updateMatrixWorld(true);
    var hit = new THREE.Box3().setFromObject(fig.hitbox);
    [fig.torso, fig.head].forEach(function (part, i) {
      var box = new THREE.Box3().setFromObject(part);
      assert.ok(hit.containsBox(box), (i ? 'the head' : 'the torso') + ' is not inside the hitbox');
    });
  });

  it('leaves no air under the feet or over the head', function () {
    var fig = build('npc');
    PB.poseFigure(fig, { phase: 0, grounded: true, moving: false });
    fig.root.updateMatrixWorld(true);
    var body = visibleBox(fig);
    assert.less(Math.abs(body.min.y - PB.HIT.bottom), 0.06,
                'the soles are at ' + body.min.y.toFixed(2) +
                ' and the box starts at ' + PB.HIT.bottom);
    assert.less(Math.abs(body.max.y - PB.HIT.top), 0.06,
                'the crown is at ' + body.max.y.toFixed(2) +
                ' and the box ends at ' + PB.HIT.top);
  });

  it('is tighter than the figure at its most sprawling', function () {
    // it should hug the body, not the reach of a swinging leg or a held rifle
    var fig = build('player');
    var sprawl = new THREE.Box3();
    for (var p = 0; p < 6.3; p += 0.2) {
      PB.poseFigure(fig, { phase: p, grounded: true, moving: true });
      fig.root.updateMatrixWorld(true);
      sprawl.union(visibleBox(fig));
    }
    assert.greater(sprawl.max.z - sprawl.min.z, PB.HIT.half * 2 + 0.3,
                   'a running figure should reach well past its own hitbox');
    var hitVolume = PB.HIT.half * 2 * PB.HIT.height * PB.HIT.half * 2;
    assert.less(hitVolume, 0.5, 'the hit volume is ' + hitVolume.toFixed(2) + ' cubic units');
  });

  it('turns with the figure it belongs to', function () {
    var fig = build('player');
    fig.root.position.set(6, 0, -2);
    fig.root.rotation.y = Math.PI / 2;
    fig.root.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(fig.hitbox);
    var mid = box.getCenter(new THREE.Vector3());
    assert.close(mid.x, 6, 0.01, 'the box did not follow the figure');
    assert.close(mid.z, -2, 0.01, 'the box did not follow the figure');
    assert.close(mid.y, PB.HIT.midY, 0.01, 'the box is at the wrong height');
  });
});

describe('Health packs', function () {
  it('stands two of them in the arena, out of the cover', function () {
    freshLevel();
    assert.equal(g.medkits.length, 2, 'wrong number of packs');
    var probe = new THREE.Vector3();
    g.medkits.forEach(function (kit, i) {
      probe.set(kit.x, 0.9, kit.z);
      var buried = g.obstacleBoxes.some(function (b) { return b.distanceToPoint(probe) < 1; });
      assert.ok(!buried, 'pack ' + i + ' is inside the cover');
      assert.ok(Math.hypot(kit.x, kit.z) > 6, 'pack ' + i + ' is on top of the spawn');
      assert.ok(kit.ready, 'pack ' + i + ' is not out');
    });
  });

  it('draws one with a label over it', function () {
    freshLevel();
    var kit = g.medkits[0];
    assert.ok(kit.view, 'the pack was never built');
    assert.ok(kit.view.tag, 'the pack has no label');
    assert.equal(kit.view.tag.text, 'HEALTH');
    assert.ok(kit.view.tag.sprite.material.depthTest, 'the label reads through cover');
    var inScene = false;
    g.scene.traverse(function (o) { if (o === kit.view.group) inScene = true; });
    assert.ok(inScene, 'the pack is not in the world');
  });

  it('puts a hurt player back to full when they walk over one', function () {
    freshLevel();
    g.setActive(true);
    g.applyMedkits([1, 1]);
    g.setHealth(3, 10);
    var kit = g.medkits[0];
    g.teleport(kit.x, g.cfg.eye, kit.z);
    step(0.1);
    assert.equal(g.state.health, 10, 'not put back to full');
    assert.ok(!kit.ready, 'the pack is still standing there');
    assert.ok(!kit.view.group.visible, 'a pack that has been taken is still drawn');
  });

  it('leaves the pack alone for somebody on full health', function () {
    freshLevel();
    g.setActive(true);
    g.applyMedkits([1, 1]);
    g.setHealth(10, 10);
    var kit = g.medkits[1];
    g.teleport(kit.x, g.cfg.eye, kit.z);
    step(0.1);
    assert.ok(kit.ready, 'a pack was taken for nothing');
  });

  it('brings a used one back after a while', function () {
    freshLevel();
    g.setActive(true);
    g.applyMedkits([1, 1]);              // both out, whatever earlier tests did
    g.setHealth(4, 10);
    var kit = g.medkits[0];
    g.teleport(kit.x, g.cfg.eye, kit.z);
    step(0.1);
    assert.ok(!kit.ready, 'never taken');
    g.state.elapsed = kit.backAt + 0.1;
    step(1 / 60);
    assert.ok(kit.ready, 'the pack never came back');
    assert.ok(kit.view.group.visible, 'it came back invisible');
  });

  it('takes the server word for which packs are out', function () {
    freshLevel();
    g.applyMedkits([0, 1]);
    assert.ok(!g.medkits[0].ready, 'the first pack should be gone');
    assert.ok(g.medkits[1].ready, 'the second should be out');
    g.applyMedkits([1, 1]);
    assert.ok(g.medkits[0].ready, 'the first never came back');
  });
});

describe('Shields', function () {
  it('counts down and says so', function () {
    freshLevel();
    var seen = 0;
    g.on('shield', function () { seen++; });
    g.setShield(3);
    assert.equal(seen, 1, 'nothing was said about the shield going up');
    assert.ok(g.shielded(), 'not shielded');
    step(1);
    assert.close(g.state.shield, 2, 0.1, 'the shield did not run down');
    step(2.2);
    assert.equal(g.state.shield, 0, 'the shield never ran out');
    assert.ok(!g.shielded(), 'still shielded after it ran out');
  });

  it('counts the shield perk as protection too', function () {
    freshLevel();
    g.setShield(0);
    assert.ok(!g.shielded(), 'shielded with nothing running');
    g.grantPerk('shield');
    assert.ok(g.shielded(), 'the perk does not protect');
  });

  it('hangs a bubble on a figure, hidden until it is up', function () {
    var fig = PB.buildFigure({
      geo: PB.figureGeometry(), shadows: false, variant: 'player',
      color: new THREE.Color(0.3, 0.6, 0.9), trim: new THREE.Color(0.2, 0.3, 0.5),
      accent: new THREE.Color(0, 0.8, 1),
    });
    assert.ok(fig.shield, 'no bubble');
    assert.ok(!fig.shield.visible, 'the bubble is up from the start');
    assert.ok(fig.shield.material.transparent, 'the bubble is solid');
  });
});

describe('Being dead', function () {
  // Damage is the server's to decide; setHealth is how it lands here.
  function kill() {
    freshLevel();
    g.setActive(true);
    g.teleport(0, g.cfg.eye, 0);
    g.setHealth(0, g.cfg.playerHealth);
    assert.ok(g.state.dead, 'not dead');
  }

  it('goes nowhere the player asks it to', function () {
    kill();
    var at = g.state.pos.clone();
    g.setKey('KeyW', true);
    g.setKey('ShiftLeft', true);
    step(0.5);
    g.setKey('KeyW', false);
    g.setKey('ShiftLeft', false);
    assert.close(g.state.pos.x, at.x, 0.001, 'a dead player walked');
    assert.close(g.state.pos.z, at.z, 0.001, 'a dead player walked');
  });

  it('does not jump', function () {
    kill();
    g.setKey('Space', true);
    step(0.3);
    g.setKey('Space', false);
    assert.close(g.state.pos.y, g.cfg.eye, 0.001, 'a dead player jumped');
    assert.ok(g.state.grounded, 'left the floor');
  });

  it('does not turn', function () {
    kill();
    var yaw = g.yawObj.rotation.y;
    var pitch = g.pitchObj.rotation.x;
    assert.ok(!g.applyLook(120, 60), 'the look was accepted');
    assert.equal(g.yawObj.rotation.y, yaw, 'a dead player turned');
    assert.equal(g.pitchObj.rotation.x, pitch, 'a dead player looked around');
  });

  it('does not shoot or reload', function () {
    freshLevel();
    g.setActive(true);
    g.state.mag = 5;
    g.setHealth(0, g.cfg.playerHealth);
    assert.equal(g.shoot(), null, 'a dead player got a round off');
    g.setFiring(true);
    step(0.4);
    g.setFiring(false);
    assert.equal(g.state.mag, 5, 'ammo left the magazine');
    assert.ok(!g.reload(), 'reloaded from the floor');
    assert.ok(!g.state.reloading, 'a reload started anyway');
  });

  it('drops the view to just above the floor and tilts it', function () {
    kill();
    var floor = g.state.pos.y - g.cfg.eye;
    step(0.7);                                  // longer than the fall takes
    assert.between(g.yawObj.position.y - floor, 0.05, 0.6,
                   'the view did not come to rest just above the floor');
    assert.greater(Math.abs(g.camera.rotation.z), 0.3, 'the view never tilted');
  });

  it('stands the view back up on coming back', function () {
    kill();
    step(0.7);
    g.setHealth(g.cfg.playerHealth, g.cfg.playerHealth);
    step(1 / 120);
    assert.equal(g.state.deathT, 0, 'still falling');
    assert.equal(g.camera.rotation.z, 0, 'the view is still on its side');
    assert.close(g.yawObj.position.y, g.state.pos.y, 0.001, 'the view is still down');
  });

  it('puts the gun away and takes it back', function () {
    kill();
    step(1 / 120);
    assert.ok(!g.gun.visible, 'still holding the gun');
    g.setHealth(g.cfg.playerHealth, g.cfg.playerHealth);
    step(1 / 120);
    assert.ok(g.gun.visible, 'came back empty handed');
  });
});

describe('Built structures', function () {
  function walk(from, dir, seconds, watch) {
    g.setActive(true);
    Object.keys(g.keys).forEach(function (k) { g.keys[k] = false; });
    g.teleport(from[0], g.cfg.eye, from[1]);
    g.yawObj.rotation.y = Math.atan2(-dir[0], -dir[1]);
    g.setKey('KeyW', true);
    var seen = false;
    var dt = 1 / 60;
    for (var t = 0; t < seconds; t += dt) {
      g.update(dt);
      if (watch && watch()) { seen = true; break; }
    }
    g.setKey('KeyW', false);
    return seen;
  }

  it('builds a ramp that can be seen from outside it', function () {
    /* Every face wound so its front is the outside. Get one backwards and it
     * is simply not drawn, and the shape becomes something you can see
     * straight through — which is what the first version of this was. */
    var ramps = g.structures.filter(function (s) { return s.kind === 'wedge'; });
    assert.greater(ramps.length, 0, 'no ramps');
    var mesh = ramps[0].parts[0];
    var geo = mesh.geometry;
    var pos = geo.getAttribute('position');
    var idx = geo.getIndex();
    assert.ok(idx, 'the ramp has no faces');

    var mid = new THREE.Vector3();
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    var ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
    // the middle of the shape, which every outward normal must point away from
    for (var v = 0; v < pos.count; v++) {
      mid.add(new THREE.Vector3().fromBufferAttribute(pos, v));
    }
    mid.divideScalar(pos.count);

    for (var f = 0; f < idx.count; f += 3) {
      a.fromBufferAttribute(pos, idx.getX(f));
      b.fromBufferAttribute(pos, idx.getX(f + 1));
      c.fromBufferAttribute(pos, idx.getX(f + 2));
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      var outward = a.clone().add(b).add(c).divideScalar(3).sub(mid);
      assert.greater(n.dot(outward), 0,
                     'face ' + (f / 3) + ' of the ramp is wound inside out');
    }
  });

  it('keeps the ramp off the floor plane it stands on', function () {
    // a face in the same plane as the floor flickers against it from across
    // the arena; there is nothing under a ramp to see anyway
    var mesh = g.structures.filter(function (s) { return s.kind === 'wedge'; })[0].parts[0];
    var pos = mesh.geometry.getAttribute('position');
    var idx = mesh.geometry.getIndex();
    var flat = 0;
    for (var f = 0; f < idx.count; f += 3) {
      var ys = [idx.getX(f), idx.getX(f + 1), idx.getX(f + 2)]
        .map(function (i) { return pos.getY(i); });
      if (Math.max.apply(null, ys) < 0.001) flat++;
    }
    assert.equal(flat, 0, 'the ramp has a face lying in the floor');
  });

  it('sizes the hunter to the arena it is in', function () {
    /* Not a fixed number of units: the same figure would see most of a small
     * map and a third of a large one. */
    assert.close(g.cfg.hunterSight, g.cfg.arena * 0.7, 0.01, 'sight');
    assert.close(g.cfg.hunterRange, g.cfg.arena * 0.125, 0.01, 'standoff');
    assert.less(g.cfg.hunterRange, g.cfg.hunterSight, 'it stands off further than it can see');
  });

  it('puts ramps, arches and rooms in the arena', function () {
    var kinds = {};
    g.structures.forEach(function (s) { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
    assert.ok(kinds.wedge > 0, 'no ramps: ' + JSON.stringify(kinds));
    assert.ok(kinds.arch > 0, 'no arches: ' + JSON.stringify(kinds));
    assert.ok(kinds.room > 0, 'no rooms: ' + JSON.stringify(kinds));
    assert.equal(kinds.house, 1, 'wrong number of houses');
  });

  it('stands one house on an edge, with a fence and a tree', function () {
    var h = g.house;
    assert.ok(h, 'no house');
    var edge = g.cfg.arena / 2 - Math.max(Math.abs(h.x), Math.abs(h.z));
    assert.less(edge, 22, 'the house is not near an edge — ' + edge.toFixed(1) + 'u in');
    assert.ok(h.tree, 'no tree');
    var trunk = h.parts.filter(function (p) { return p.name === 'treeTrunk'; });
    assert.equal(trunk.length, 1, 'the tree has no trunk to stop a round');
    var fences = h.parts.filter(function (p) { return p.name === 'fence'; });
    assert.greater(fences.length, 6, 'the fence is barely there');
  });

  it('leaves no gap in the fence wide enough to walk through', function () {
    /* The gaps are what make it read as a fence rather than a low wall, and
     * rounds go through them — but a player who can walk through one never
     * has to jump, and the fence stops meaning anything. */
    var h = g.house;
    var runs = {};
    h.parts.filter(function (p) { return p.name === 'fence'; }).forEach(function (p) {
      var b = new THREE.Box3().setFromObject(p);
      var alongX = (b.max.x - b.min.x) > (b.max.z - b.min.z);
      var key = alongX ? 'z' + b.min.z.toFixed(1) : 'x' + b.min.x.toFixed(1);
      (runs[key] = runs[key] || []).push(alongX ? [b.min.x, b.max.x] : [b.min.z, b.max.z]);
    });
    var widest = 0;
    Object.keys(runs).forEach(function (k) {
      var segs = runs[k].sort(function (a, b) { return a[0] - b[0]; });
      for (var i = 1; i < segs.length; i++) {
        widest = Math.max(widest, segs[i][0] - segs[i - 1][1]);
      }
    });
    assert.less(widest, g.cfg.radius * 2, 'a player can walk through the fence');
  });

  it('has a fence that needs a jump and takes one', function () {
    var h = g.house;
    // low enough to clear: a standing jump reaches about two units
    var reach = (g.cfg.jump * g.cfg.jump) / (2 * g.cfg.gravity);
    assert.less(h.fence.height, reach - 0.4, 'the fence cannot be jumped');
    assert.greater(h.fence.height, g.cfg.stepHeight + 0.2, 'the fence can be walked over');
  });

  it('lets a player walk in through every doorway', function () {
    var h = g.house;
    var inside = function () {
      return Math.abs(g.state.pos.x - h.x) < h.width / 2 - 0.7 &&
             Math.abs(g.state.pos.z - h.z) < h.depth / 2 - 0.7;
    };
    var ways = 0;
    var approaches = [
      [[h.x, h.z - h.depth / 2 - 3], [0, 1]],
      [[h.x, h.z + h.depth / 2 + 3], [0, -1]],
      [[h.x - h.width / 2 - 3, h.z], [1, 0]],
      [[h.x + h.width / 2 + 3, h.z], [-1, 0]],
    ];
    approaches.forEach(function (a) {
      if (walk(a[0], a[1], 4, inside)) ways++;
    });
    assert.equal(ways, 3, 'walked in ' + ways + ' ways, expected three doorways');
  });

  it('lets a player walk up a ramp', function () {
    var wedge = g.structures.filter(function (s) { return s.kind === 'wedge'; })[0];
    assert.ok(wedge, 'no ramp to walk up');
    var box = wedge.box;
    var top = box.max.y;
    // approach from each side; one of them is the slope
    var climbed = 0;
    var mid = box.getCenter(new THREE.Vector3());
    var span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(function (d) {
      var from = [mid.x - d[0] * (span / 2 + 2.5), mid.z - d[1] * (span / 2 + 2.5)];
      var up = walk(from, d, 3, function () {
        return g.state.pos.y - g.cfg.eye > Math.min(0.5, top * 0.6);
      });
      if (up) climbed++;
    });
    assert.greater(climbed, 0, 'no way up the ramp from any side');
  });

  it('lets a player walk under an arch', function () {
    var arch = g.structures.filter(function (s) { return s.kind === 'arch'; })[0];
    assert.ok(arch, 'no arch');
    var mid = arch.box.getCenter(new THREE.Vector3());
    var span = arch.box.max.x - arch.box.min.x;
    var through = walk([mid.x, mid.z - span - 2], [0, 1], 3, function () {
      return g.state.pos.z > mid.z + 0.6;
    }) || walk([mid.x - span - 2, mid.z], [1, 0], 3, function () {
      return g.state.pos.x > mid.x + 0.6;
    });
    assert.ok(through, 'the arch cannot be walked under from either axis');
  });

  it('never hangs a target inside anything', function () {
    for (var level = 1; level <= 4; level++) {
      g.startLevel(level);
      for (var i = 0; i < g.targets.length; i++) {
        var p = g.targets[i].mesh.position;
        assert.ok(!g.insideAnything(p.x, p.z, p.y, 0),
                  'level ' + level + ': a target is sealed inside a structure');
      }
    }
    freshLevel();
  });

  it('keeps a drifting target out of them as well', function () {
    freshLevel();
    for (var t = 0; t < 25; t += 1 / 60) {
      step(1 / 60);
      for (var i = 0; i < g.targets.length; i++) {
        var tg = g.targets[i];
        if (!tg.alive) continue;
        var p = tg.mesh.position;
        assert.ok(!g.insideAnything(p.x, p.z, p.y, 0),
                  'a target drifted inside a structure');
      }
    }
  });

  it('does not let NPCs walk through anything', function () {
    freshLevel();
    var H = PB.HIT;
    var box = new THREE.Box3();
    var worst = 0;
    for (var t = 0; t < 12; t += 1 / 60) {
      step(1 / 60);
      for (var n = 0; n < g.npcs.length; n++) {
        var npc = g.npcs[n];
        if (!npc.alive) continue;
        var p = npc.root.position;
        box.min.set(p.x - H.half, npc.y + H.bottom, p.z - H.half);
        box.max.set(p.x + H.half, npc.y + H.top, p.z + H.half);
        for (var c = 0; c < g.colliders.length; c++) {
          var col = g.colliders[c];
          if (!box.intersectsBox(col)) continue;
          // resting exactly on top of something is not being inside it
          var oy = Math.min(box.max.y - col.min.y, col.max.y - box.min.y);
          if (oy <= 0.02) continue;
          var ov = Math.min(
            Math.min(box.max.x - col.min.x, col.max.x - box.min.x),
            Math.min(box.max.z - col.min.z, col.max.z - box.min.z));
          if (ov > worst) worst = ov;
        }
      }
    }
    assert.less(worst, 0.05, 'an NPC was ' + worst.toFixed(2) + 'u inside cover');
  });
});

describe('A crowd', function () {
  /* Hundreds of figures is a thing the match controls make easy, so it has to
   * cost what it has to cost and no more. */
  function casting(npc) {
    var on = false;
    npc.root.traverse(function (o) {
      if (o.isMesh && o !== npc.hitbox && o.castShadow) on = true;
    });
    return on;
  }

  it('lets every figure cast a shadow while there are few of them', function () {
    freshLevel();
    assert.less(g.npcs.length, g.cfg.shadowFigures, 'this level is already a crowd');
    g.update(1 / 60);
    g.state.elapsed += 1;                       // past the budget's own clock
    g.update(1 / 60);
    var lit = g.npcs.filter(casting).length;
    assert.equal(lit, g.npcsAlive(), 'not everything standing is casting one');
  });

  it('hands shadows to the nearest few once there is a crowd', function () {
    freshLevel();
    g.addToLevel('npc', g.cfg.shadowFigures + 40);
    g.teleport(0, g.cfg.eye, 0);
    g.state.elapsed += 1;
    g.update(1 / 60);

    var lit = g.npcs.filter(casting);
    assert.equal(lit.length, g.cfg.shadowFigures,
                 'the budget was ignored: ' + lit.length + ' casting');

    // and they are the near ones, not an arbitrary handful
    var here = new THREE.Vector3();
    g.camera.getWorldPosition(here);
    var far = 0;
    lit.forEach(function (n) {
      far = Math.max(far, Math.hypot(n.root.position.x - here.x,
                                     n.root.position.z - here.z));
    });
    var nearestDark = Infinity;
    g.npcs.filter(function (n) { return n.alive && !casting(n); }).forEach(function (n) {
      nearestDark = Math.min(nearestDark, Math.hypot(n.root.position.x - here.x,
                                                     n.root.position.z - here.z));
    });
    assert.ok(nearestDark >= far - 0.01,
              'a nearer figure went without while a further one kept its shadow');
    freshLevel();
  });

  it('never casts one from a body', function () {
    freshLevel();
    g.addToLevel('npc', g.cfg.shadowFigures + 5);
    g.teleport(0, g.cfg.eye, 0);
    var victim = g.npcs.filter(function (n) { return n.alive; })[0];
    victim.root.position.set(0.5, 0, 0.5);          // right under the camera
    g.knockDownNPC(victim);
    g.state.elapsed += 1;
    g.update(1 / 60);
    assert.ok(!casting(victim), 'a body is still casting a shadow');
    freshLevel();
  });

  it('stops working on a body once it has finished falling', function () {
    freshLevel();
    var victim = g.npcs.filter(function (n) { return n.alive; })[0];
    g.knockDownNPC(victim);
    step(4);
    assert.ok(victim.settled, 'the body never settled');
    var where = victim.root.position.clone();
    var lean = victim.root.rotation.x;
    step(2);
    assert.close(victim.root.position.y, where.y, 1e-6, 'a settled body is still moving');
    assert.close(victim.root.rotation.x, lean, 1e-6, 'a settled body is still turning');
    freshLevel();
  });
});

describe('Where the shot came from', function () {
  /* A bearing relative to the view: 0 straight ahead, positive to the right,
   * the way a compass reads. Everything drawing it just rotates by this, so
   * the sign and the wrap are the whole of it. */
  function bearingOf(from) {
    var seen = null;
    var off = g.on('hurtFrom', function (d) { seen = d; });
    g.hurtFrom(from);
    // the bus has no unsubscribe; the next call overwrites what we read
    void off;
    return seen;
  }

  it('reads zero for a round from straight ahead', function () {
    freshLevel();
    g.teleport(0, g.cfg.eye, 0);
    g.yawObj.rotation.y = 0;                 // a yaw of 0 looks down -Z
    var d = bearingOf({ x: 0, y: 1.5, z: -20 });
    assert.ok(d, 'nothing was said about where it came from');
    assert.close(d.bearing, 0, 0.02, 'straight ahead did not read as ahead');
    assert.close(d.range, 20, 0.5, 'the range is wrong');
  });

  it('reads a quarter turn for a round from either side', function () {
    freshLevel();
    g.teleport(0, g.cfg.eye, 0);
    g.yawObj.rotation.y = 0;
    assert.close(bearingOf({ x: 20, y: 1.5, z: 0 }).bearing, Math.PI / 2, 0.02,
                 'a round from the right did not read as from the right');
    assert.close(bearingOf({ x: -20, y: 1.5, z: 0 }).bearing, -Math.PI / 2, 0.02,
                 'a round from the left did not read as from the left');
  });

  it('reads a half turn for a round from behind', function () {
    freshLevel();
    g.teleport(0, g.cfg.eye, 0);
    g.yawObj.rotation.y = 0;
    var d = bearingOf({ x: 0, y: 1.5, z: 20 });
    assert.close(Math.abs(d.bearing), Math.PI, 0.02, 'a shot in the back read as ahead');
  });

  it('is measured against where the player is looking', function () {
    freshLevel();
    g.teleport(0, g.cfg.eye, 0);
    // turn a quarter to the left, and what was on our right is now ahead
    g.yawObj.rotation.y = -Math.PI / 2;
    assert.close(bearingOf({ x: 20, y: 1.5, z: 0 }).bearing, 0, 0.02,
                 'the bearing ignored which way we were facing');
    g.yawObj.rotation.y = Math.PI / 2;
    assert.close(Math.abs(bearingOf({ x: 20, y: 1.5, z: 0 }).bearing), Math.PI, 0.02,
                 'the bearing ignored which way we were facing');
    g.yawObj.rotation.y = 0;
  });

  it('says nothing about a round with nowhere to have come from', function () {
    freshLevel();
    g.teleport(0, g.cfg.eye, 0);
    var seen = 0;
    g.on('hurtFrom', function () { seen++; });
    g.hurtFrom(null);
    g.hurtFrom({ x: 0, y: g.cfg.eye, z: 0 });      // exactly on top of us
    assert.equal(seen, 0, 'a bearing was invented out of nothing');
  });

  it('comes with a hunter round that lands, and not one that misses', function () {
    freshLevel();
    g.setActive(true);
    g.setHealth(g.cfg.playerHealth, g.cfg.playerHealth);
    g.setShield(0);
    g.state.perks = {};              // whatever an earlier suite left running
    g.teleport(0, g.cfg.eye, 0);
    var marks = [];
    g.on('hurtFrom', function (d) { marks.push(d); });

    // straight down the middle of the player, from twelve units in front
    g.takeNpcRound({
      origin: { x: 0, y: 1.5, z: -12 }, dir: { x: 0, y: 0, z: 1 },
      point: { x: 0, y: 1.5, z: 30 }, distance: 42,
    });
    assert.equal(marks.length, 1, 'a round that hit said nothing about itself');
    assert.close(marks[0].bearing, 0, 0.05, 'it came from in front of us');

    // and one that goes wide says nothing
    g.takeNpcRound({
      origin: { x: 0, y: 1.5, z: -12 }, dir: { x: 1, y: 0, z: 0 },
      point: { x: 30, y: 1.5, z: -12 }, distance: 42,
    });
    assert.equal(marks.length, 1, 'a round that missed still marked the screen');
  });
});

describe('Hunters', function () {
  /* Its own world, with the red one in it and nothing else moving: the shared
   * game deliberately has no hunter, and a wandering crowd would decide these
   * outcomes by walking through the line of fire. */
  var hg = null;

  function hunterGame() {
    if (hg) return hg;
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;width:320px;height:200px';
    document.body.appendChild(host);
    /* Bare ground on purpose: no cover, no house, nothing else walking about.
     * What is being measured is what the hunter does about a player it can or
     * cannot see, and an arena full of crates decides that instead. Cover goes
     * up per test, through withCover, exactly where it is wanted. */
    hg = global.createGame({
      container: host, seed: SEED, audio: false, shadows: false,
      hunters: 1, npcsPerLevel: 0, targetsPerLevel: 0,
      obstacles: 0, movingObstacles: 0, house: false,
    });
    return hg;
  }

  // The hunter, the player, and a clear line between them.
  function faceOff(gap) {
    var h = hunterGame();
    h.startLevel(1);
    h.setActive(true);
    h.setHealth(h.cfg.playerHealth, h.cfg.playerHealth);
    h.setShield(0);
    h.state.elapsed = 0;
    var e = h.hunters()[0];
    h.teleport(0, h.cfg.eye, 0);
    e.root.position.set(0, 0, -(gap === undefined ? 12 : gap));
    e.heading = 0;                       // (sin h, cos h) is +Z: straight at them
    e.mark = null;
    e.quarry = null;
    e.sawAt = -1e9;
    e.sightSince = 0;
    e.nextShot = 0;
    e.root.updateMatrixWorld(true);
    h.aimAt(new THREE.Vector3(e.root.position.x, 1.2, e.root.position.z));
    return { g: h, e: e };
  }

  function stepGame(h, seconds) {
    var dt = 1 / 120;
    for (var t = 0; t < seconds; t += dt) h.update(dt);
  }

  // A slab of cover between the two of them, for as long as `fn` runs.
  function withCover(h, z, fn) {
    var wall = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 0.5),
                              new THREE.MeshBasicMaterial());
    wall.position.set(0, 1.5, z);
    wall.name = 'test-cover';
    h.scene.add(wall);
    wall.updateMatrixWorld(true);
    h.solidMeshes.push(wall);
    try {
      fn();
    } finally {
      var at = h.solidMeshes.indexOf(wall);
      if (at !== -1) h.solidMeshes.splice(at, 1);
      h.scene.remove(wall);
    }
  }

  it('puts exactly one red enemy in every level', function () {
    var h = hunterGame();
    h.startLevel(1);
    assert.equal(h.hunters().length, 1, 'wrong number of hunters');
    assert.ok(h.npcs[0].hunter, 'the hunter is not the first NPC');
    // both sides rebuild a level from a count, so the index is the agreement
    var red = h.npcs[0].fig.materials[0].color;
    assert.greater(red.r, 0.5, 'the hunter is not red');
    assert.less(red.g, 0.2, 'the hunter is not red');
    assert.less(red.b, 0.2, 'the hunter is not red');
    var count = h.npcs.length;
    h.startLevel(2);
    assert.equal(h.hunters().length, 1, 'the next level came without one');
    assert.equal(h.npcs.length, count + 1, 'the level did not grow by one NPC');
  });

  it('shoots at a player it can see, once it has taken a moment', function () {
    var set = faceOff(12);
    var shots = [];
    set.g.on('npcShot', function (s) { shots.push(s); });

    stepGame(set.g, set.g.cfg.hunterReaction * 0.6);
    assert.equal(shots.length, 0, 'it fired before it could have reacted');

    stepGame(set.g, 2.5);
    assert.greater(shots.length, 1, 'it never fired');
    assert.ok(set.e.mark, 'it never marked where the player was');
  });

  it('does not shoot at somebody behind it', function () {
    var set = faceOff(12);
    var shots = [];
    set.g.on('npcShot', function (s) { shots.push(s); });
    set.e.heading = Math.PI;             // turned round: the player is behind it
    stepGame(set.g, 1.0);
    assert.equal(shots.length, 0, 'it shot somebody it could not see');
  });

  it('does not shoot through cover', function () {
    var set = faceOff(12);
    var shots = [];
    set.g.on('npcShot', function (s) { shots.push(s); });
    withCover(set.g, -3, function () {
      stepGame(set.g, 1.5);
    });
    assert.equal(shots.length, 0, 'it shot through cover');
    // and picks its moment again the instant the way is clear
    stepGame(set.g, 1.5);
    assert.greater(shots.length, 0, 'it never fired with a clear line');
  });

  it('misses about as often as it hits', function () {
    /* Average aim, and the point of the whole thing: a cone rather than a
     * line. Perfect aim would land every round at this range, and no aim at
     * all would land none. */
    var set = faceOff(14);
    var fired = 0, landed = 0;
    set.g.on('npcShot', function () { fired++; });
    set.g.on('hurt', function () { landed++; });
    // stand still and take it, topped back up so a death never cuts it short
    for (var round = 0; round < 200 && fired < 40; round++) {
      set.g.setHealth(set.g.cfg.playerHealth, set.g.cfg.playerHealth);
      stepGame(set.g, 0.2);
    }
    assert.greater(fired, 20, 'it barely fired');
    var share = landed / fired;
    assert.between(share, 0.15, 0.9, 'aim is ' + (share * 100).toFixed(0) + '% — not average');
  });

  it('takes health off the player it hits, and no score off them', function () {
    var set = faceOff(9);
    var score = set.g.state.score;
    var health = set.g.state.health;
    var landed = false;
    for (var i = 0; i < 200 && !landed; i++) {
      stepGame(set.g, 0.1);
      landed = set.g.state.health < health;
    }
    assert.ok(landed, 'nothing ever landed');
    assert.equal(set.g.state.score, score, 'being shot at cost the player points');
  });

  it('remembers where you were and comes looking', function () {
    var set = faceOff(18);
    stepGame(set.g, 0.5);
    assert.ok(set.e.mark, 'it never marked where the player was');

    // out of sight: the mark stays, and it walks in on it anyway
    var from = set.e.root.position.distanceTo(set.g.state.pos);
    withCover(set.g, -3, function () {
      stepGame(set.g, 1.5);
    });
    var to = set.e.root.position.distanceTo(set.g.state.pos);
    assert.ok(set.e.mark, 'it forgot immediately');
    assert.less(to, from - 1, 'it did not close on where it last saw them');
  });

  it('gives up on a sighting that has gone stale', function () {
    var set = faceOff(16);
    stepGame(set.g, 0.5);
    assert.ok(set.e.mark, 'nothing to forget');
    // no targets at all is the same as never seeing one again
    set.g.setHunterTargets(function () { return []; });
    stepGame(set.g, set.g.cfg.hunterMemory + 0.5);
    assert.equal(set.e.mark, null, 'it is still working from a sighting it lost');
    assert.equal(set.e.quarry, null, 'it is still hunting somebody it cannot see');
    set.g.setHunterTargets(null);
  });

  it('stays on its quarry unless another looks easier', function () {
    var set = faceOff(12);
    var here = { id: 1, x: 0, y: set.g.cfg.eye, z: 0, health: 10 };
    var alsoHere = { id: 2, x: 1.2, y: set.g.cfg.eye, z: 0.6, health: 10 };
    set.g.setHunterTargets(function () { return [here, alsoHere]; });

    stepGame(set.g, 0.6);
    var first = set.e.quarry;
    assert.ok(first === 1 || first === 2, 'it settled on nobody');

    // the other one is a little nearer, which is not reason enough to switch
    stepGame(set.g, 1.0);
    assert.equal(set.e.quarry, first, 'it swapped target for no good reason');

    // now the other one is nearly finished: worth turning to
    var other = first === 1 ? alsoHere : here;
    other.health = 1;
    stepGame(set.g, 0.6);
    assert.equal(set.e.quarry, other.id, 'it stayed on the harder target');
    set.g.setHunterTargets(null);
  });

  it('leaves the player alone while they are dead, and while shielded', function () {
    var set = faceOff(10);
    set.g.setShield(5);
    var health = set.g.state.health;
    stepGame(set.g, 3);
    assert.equal(set.g.state.health, health, 'a shielded player was hurt');
    set.g.setShield(0);

    set.g.setHealth(0, set.g.cfg.playerHealth);
    assert.ok(set.g.state.dead, 'not dead');
    var shots = [];
    set.g.on('npcShot', function (s) { shots.push(s); });
    stepGame(set.g, 1.5);
    assert.equal(shots.length, 0, 'it kept shooting a body');
  });

  it('brings the player back on its own when there is no server to', function () {
    var set = faceOff(10);
    set.g.setHealth(0, set.g.cfg.playerHealth);
    var fell = set.g.state.pos.clone();
    assert.ok(set.g.state.dead, 'not dead');
    stepGame(set.g, set.g.cfg.respawnDelay + 0.3);
    assert.ok(!set.g.state.dead, 'never came back');
    assert.equal(set.g.state.health, set.g.cfg.playerHealth, 'came back hurt');
    assert.greater(set.g.state.shield, 0, 'came back with no protection');
    assert.greater(set.g.state.pos.distanceTo(fell), 1,
                   'came back standing where they fell');
  });

  it('takes several rounds to put down, unlike a wanderer', function () {
    var set = faceOff(12);
    var e = set.e;
    assert.equal(e.health, set.g.cfg.hunterHealth, 'it did not start whole');
    assert.greater(e.maxHealth, 1, 'it is as soft as a wanderer');

    var down = null;
    for (var i = 1; i < set.g.cfg.hunterHealth; i++) {
      down = set.g.hitNPC(e, 1);
      assert.ok(!down.killed, 'round ' + i + ' of ' + set.g.cfg.hunterHealth + ' finished it');
      assert.ok(e.alive, 'it went down early');
      assert.equal(down.health, set.g.cfg.hunterHealth - i, 'the wrong amount came off');
    }
    down = set.g.hitNPC(e, 1);
    assert.ok(down.killed, 'the last round did not finish it');
    assert.ok(!e.alive, 'it survived every round it has');
  });

  it('pays out only on the round that finishes it, and pays more', function () {
    var set = faceOff(12);
    set.g.startLevel(1);
    var e = set.g.hunters()[0];
    assert.ok(e, 'no hunter');
    /* Something else left standing, so putting the hunter down does not also
     * clear the level: the completion bonus would land in the same total and
     * this would be measuring both at once. */
    set.g.spawnTarget(20, 2, 20, false);

    var score = set.g.state.score;
    set.g.hitNPC(e, 1);
    assert.equal(set.g.state.score, score, 'a hit that did not finish it paid out');

    while (e.alive) set.g.hitNPC(e, 1);
    assert.equal(set.g.state.score - score, set.g.cfg.scoreHunter,
                 'putting it down paid the wrong amount');
    assert.greater(set.g.cfg.scoreHunter, set.g.cfg.scoreNpc,
                   'it is worth no more than a wanderer');
  });

  it('sends one more of them every few levels', function () {
    var h = hunterGame();
    var seen = [];
    [1, 2, 4, 5, 8, 9, 40].forEach(function (level) {
      h.startLevel(level);
      seen.push([level, h.hunters().length]);
      h.hunters().forEach(function (e, i) {
        assert.ok(h.npcs[i] === e, 'the hunters are not the first NPCs of the level');
      });
    });
    var at = function (level) {
      return seen.filter(function (s) { return s[0] === level; })[0][1];
    };
    assert.equal(at(1), h.cfg.hunters, 'level one has the wrong number');
    assert.equal(at(4), h.cfg.hunters, 'it grew before it should have');
    assert.equal(at(5), h.cfg.hunters + 1, 'it never grew');
    assert.equal(at(9), h.cfg.hunters + 2, 'it stopped growing');
    assert.equal(at(40), h.cfg.hunterMax, 'it grew past its own ceiling');
    h.startLevel(1);
  });

  it('wears what is left of it once it has been hit', function () {
    var set = faceOff(12);
    set.g.startLevel(1);
    var e = set.g.hunters()[0];
    assert.ok(e.bar, 'a hunter has nothing to show its health on');
    // and something else standing, so putting it down does not clear the
    // level and take the figure being inspected with it
    set.g.spawnTarget(20, 2, 20, false);
    stepGame(set.g, 1 / 60);
    assert.ok(!e.bar.sprite.visible, 'an untouched hunter is advertising its health');
    set.g.hitNPC(e, 1);
    stepGame(set.g, 1 / 60);
    assert.ok(e.bar.sprite.visible, 'a hurt hunter shows nothing');
    while (e.alive) set.g.hitNPC(e, 1);
    stepGame(set.g, 1 / 60);
    assert.ok(!e.bar.sprite.visible, 'a body is still wearing a health bar');
  });

  it('leaves a wanderer as soft as it always was', function () {
    freshLevel();
    var wanderer = g.npcs.filter(function (n) { return !n.hunter && n.alive; })[0];
    assert.ok(wanderer, 'no wanderer to shoot');
    assert.equal(wanderer.maxHealth, 1, 'a wanderer now takes more than one round');
    var down = g.hitNPC(wanderer, 1);
    assert.ok(down.killed, 'one round no longer puts a wanderer down');
  });

  it('goes down to a round like anything else, and finishes the level', function () {
    var set = faceOff(12);
    var level = set.g.state.level;
    var down = 0;
    set.g.on('npcDown', function () { down++; });
    set.g.knockDownNPC(set.e);
    assert.ok(!set.e.alive, 'it survived');
    assert.equal(down, 1, 'nothing was said about it going down');
    // it is the only thing standing in this level, so that clears it
    assert.equal(set.g.state.level, level + 1, 'the level did not turn over');
  });
});

describe('Lifetime statistics', function () {
  function store() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      raw: data,
    };
  }

  it('starts empty', function () {
    var career = PB.createCareer(store());
    var all = career.all();
    assert.equal(all.shotsFired, 0);
    assert.equal(all.accuracy, 0);
    assert.equal(all.sessions, 0);
  });

  it('adds up what happened since the last fold, and no more', function () {
    var career = PB.createCareer(store());
    career.fold({ shotsFired: 10, shotsHit: 6, bestScore: 400 });
    assert.equal(career.all().shotsFired, 10);
    career.fold({ shotsFired: 10, shotsHit: 6, bestScore: 400 });
    assert.equal(career.all().shotsFired, 10, 'the same session was counted twice');
    career.fold({ shotsFired: 14, shotsHit: 9, bestScore: 900 });
    assert.equal(career.all().shotsFired, 14, 'the difference was not added on');
    assert.equal(career.all().shotsHit, 9);
    assert.close(career.all().accuracy, 9 / 14, 0.001, 'accuracy off the totals');
  });

  it('keeps the best of the bests rather than the latest', function () {
    var career = PB.createCareer(store());
    career.fold({ bestScore: 900, bestStreak: 7, longestShot: 22 });
    career.fold({ bestScore: 300, bestStreak: 2, longestShot: 4 });
    var all = career.all();
    assert.equal(all.bestScore, 900, 'a worse score overwrote the best');
    assert.equal(all.bestStreak, 7);
    assert.equal(all.longestShot, 22);
  });

  it('survives a reload', function () {
    var shared = store();
    var first = PB.createCareer(shared);
    first.fold({ shotsFired: 30, shotsHit: 20, kills: 3, deaths: 1 });
    var second = PB.createCareer(shared);
    var all = second.all();
    assert.equal(all.shotsFired, 30, 'nothing came back from storage');
    assert.equal(all.kills, 3);
    assert.equal(all.deaths, 1);
  });

  it('counts a fresh page as one more session', function () {
    var shared = store();
    PB.createCareer(shared).fold({ shotsFired: 1 });
    PB.createCareer(shared).fold({ shotsFired: 1 });
    assert.equal(PB.createCareer(shared).all().sessions, 2, 'sessions not counted');
  });

  it('shrugs off rubbish in storage', function () {
    var shared = store();
    shared.setItem('paintball.career', '{"shotsFired":"lots","kills":-4,"bestScore":null}');
    var all = PB.createCareer(shared).all();
    assert.equal(all.shotsFired, 0, 'a nonsense total was kept');
    assert.equal(all.kills, 0, 'a negative total was kept');
    assert.equal(all.bestScore, 0);
  });

  it('never lets a session fold in a number that went backwards', function () {
    // a reset mid-session must not subtract from the career
    var career = PB.createCareer(store());
    career.fold({ shotsFired: 40 });
    career.fold({ shotsFired: 0 });
    assert.equal(career.all().shotsFired, 40, 'the career went down');
  });
});

describe('Settings that were actually chosen', function () {
  function store(seed) {
    var data = seed || {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      raw: data,
    };
  }

  it('knows a default from a choice', function () {
    var opts = PB.createOptions(store());
    assert.equal(opts.get('name'), 'player', 'no default name');
    assert.ok(!opts.has('name'), 'a name nobody picked reads as chosen');
    opts.set('name', 'player');
    assert.ok(opts.has('name'), 'picking the same as the default did not count');
  });

  it('remembers the choice across a reload', function () {
    var shared = store();
    PB.createOptions(shared).set('name', 'ana');
    var back = PB.createOptions(shared);
    assert.ok(back.has('name'), 'the choice did not survive');
    assert.equal(back.get('name'), 'ana');
  });

  it('forgets the choices on a reset', function () {
    var opts = PB.createOptions(store());
    opts.set('name', 'ana');
    opts.reset();
    assert.ok(!opts.has('name'), 'a reset left the name looking chosen');
    assert.equal(opts.get('name'), 'player');
  });

  it('carries a fight-other-players switch, on by default', function () {
    var opts = PB.createOptions(store());
    assert.equal(opts.get('pvp'), true, 'players start out of the fight');
    opts.set('pvp', false);
    assert.equal(opts.get('pvp'), false);
  });
});

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

  /* The shared world has no hunter in it. Nearly every test here stands the
   * player still in the open for seconds at a time, which is exactly what the
   * red one is built to punish — one suite would be testing the game and the
   * next would be testing whether it got shot. The Hunters suite builds its
   * own world with one in it. */
  g = freshGame({ hunters: 0 });

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
