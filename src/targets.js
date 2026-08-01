/* Targets: spawning, the slow drift of the wandering ones, breaking.
 *
 * Part of the Paintball engine. Classic script, no modules: the game has to
 * run straight off the filesystem, where Chrome refuses to load ES modules.
 * Every builder takes the shared context created by createGame and returns
 * the handful of things the rest of the engine needs.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createTargets = function (ctx) {
  var THREE = global.THREE;
  var cfg = ctx.cfg, rand = ctx.rand, half = ctx.half, scene = ctx.scene;
  var obstacleBoxes = ctx.obstacleBoxes, fx = ctx.fx;
  var targets = [];
  var targetGeo = ctx.targetGeo;

  function spawnTarget(x, y, z, wander) {
    var mat = new THREE.MeshStandardMaterial({
      color: wander ? 0xffb03a : 0xff4d4d,
      emissive: wander ? 0xd97a10 : 0xff2a2a, emissiveIntensity: 0.55,
      roughness: 0.35, metalness: 0.15, flatShading: true,
    });
    var mesh = new THREE.Mesh(targetGeo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.name = 'target';
    scene.add(mesh);

    var halo = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 24),
      new THREE.MeshBasicMaterial({
        color: wander ? 0xffd08a : 0xff8080,
        side: THREE.DoubleSide, transparent: true, opacity: 0.45,
      })
    );
    mesh.add(halo);

    var heading = rand() * Math.PI * 2;
    var speed = 1.1 + rand() * 1.3;
    var t = {
      mesh: mesh, halo: halo, base: y, phase: rand() * Math.PI * 2, alive: true,
      wander: !!wander,
      vel: new THREE.Vector3(Math.sin(heading) * speed, 0, Math.cos(heading) * speed),
      turn: (rand() - 0.5) * 0.6,          // slow curve to the drift
    };
    mesh.updateMatrixWorld(true);
    targets.push(t);
    return t;
  }

  var _v = new THREE.Vector3();

  function spawnTargets() {
    var placed = 0, guard = 0;
    while (placed < cfg.targetsPerLevel && guard++ < 4000) {
      var x = (rand() - 0.5) * (cfg.arena - 6);
      var z = (rand() - 0.5) * (cfg.arena - 6);
      if (Math.hypot(x, z) < 8) continue;                              // never on the player
      var y = 1.2 + rand() * 2.6;
      _v.set(x, y, z);
      var tooClose = targets.some(function (t) {
        return t.alive && Math.hypot(t.mesh.position.x - x, t.mesh.position.z - z) < 4;
      });
      if (tooClose) continue;
      var buried = obstacleBoxes.some(function (b) { return b.distanceToPoint(_v) < 0.9; });
      if (buried) continue;
      // a fixed share drift, so every level has both kinds
      spawnTarget(x, y, z, placed < Math.round(cfg.targetsPerLevel * cfg.wanderingTargets));
      placed++;
    }
    return placed;
  }

  // Drifting targets curve slowly and turn away from walls and cover.
  var _targetNext = new THREE.Vector3();

  function moveTarget(t, dt) {
    if (!t.wander || !t.alive) return;
    var p = t.mesh.position;

    var a = t.turn * dt;                                  // gentle curve
    var vx = t.vel.x * Math.cos(a) - t.vel.z * Math.sin(a);
    var vz = t.vel.x * Math.sin(a) + t.vel.z * Math.cos(a);
    t.vel.x = vx; t.vel.z = vz;

    var lim = half - 2.5;
    _targetNext.set(p.x + t.vel.x * dt, t.base, p.z + t.vel.z * dt);

    if (_targetNext.x < -lim || _targetNext.x > lim) { t.vel.x *= -1; _targetNext.x = p.x; }
    if (_targetNext.z < -lim || _targetNext.z > lim) { t.vel.z *= -1; _targetNext.z = p.z; }

    var blocked = false;
    for (var i = 0; i < obstacleBoxes.length; i++) {
      if (obstacleBoxes[i].distanceToPoint(_targetNext) < 1.1) { blocked = true; break; }
    }
    if (blocked) {
      t.vel.x *= -1;
      t.vel.z *= -1;
      t.turn = -t.turn;
      return;
    }
    p.x = _targetNext.x;
    p.z = _targetNext.z;
  }

  // A break borrows shards and a flash light from the effect pools.
  function breakTarget(t, dir) {
    t.alive = false;
    var pos = t.mesh.position.clone();
    t.mesh.visible = false;
    scene.remove(t.mesh);

    for (var i = 0; i < 16; i++) {
      var s = fx.takeShard();
      if (!s) break;
      s.visible = true;
      s.position.copy(pos);
      s.rotation.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
      s.scale.setScalar(1);
      var v = new THREE.Vector3(rand() - 0.5, rand() * 0.7, rand() - 0.5)
        .normalize().multiplyScalar(4 + rand() * 6).addScaledVector(dir, 5);
      fx.debris.push({
        mesh: s, vel: v, life: 1.6,
        spin: new THREE.Vector3((rand() - .5) * 14, (rand() - .5) * 14, (rand() - .5) * 14),
      });
    }

    var f = fx.nextFlash();
    f.light.position.copy(pos);
    f.life = 0.28;
  }

  /* Put a target back.
   *
   * The server decides what is standing. A client that broke one the server
   * still has alive currently has no way to undo it, so that target stays
   * invisible and unkillable and the level can never be finished — reloading
   * is the only way out, because that rebuilds from the server's description.
   */
  function reviveTarget(t) {
    if (!t || t.alive) return false;
    t.alive = true;
    t.mesh.visible = true;
    if (!t.mesh.parent) scene.add(t.mesh);
    t.mesh.updateMatrixWorld(true);
    return true;
  }

  function aliveCount() {
    var n = 0;
    for (var i = 0; i < targets.length; i++) if (targets[i].alive) n++;
    return n;
  }

  return {
    targets: targets, spawnTarget: spawnTarget, spawnTargets: spawnTargets,
    moveTarget: moveTarget, breakTarget: breakTarget, reviveTarget: reviveTarget,
    aliveCount: aliveCount,
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
