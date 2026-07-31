/* Pooled visuals: floating score labels, debris shards, break flashes.
 *
 * Part of the Paintball engine. Classic script, no modules: the game has to
 * run straight off the filesystem, where Chrome refuses to load ES modules.
 * Every builder takes the shared context created by createGame and returns
 * the handful of things the rest of the engine needs.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createEffects = function (ctx) {
  var THREE = global.THREE;
  var cfg = ctx.cfg, rand = ctx.rand, scene = ctx.scene, state = ctx.state, emit = ctx.emit;
  var shardGeo = ctx.shardGeo;

  /* -------------------------------------------------- score indicators */
  /* Little "+250" / "-25" labels that float up where something was hit or
   * missed. Pooled sprites with their own canvas, so showing one costs a
   * texture upload and nothing else. */
  var indicatorPool = [];
  var indicators = [];
  var nextIndicator = 0;

  for (var ip = 0; ip < (cfg.headless ? 0 : 14); ip++) {
    var icanvas = document.createElement('canvas');
    icanvas.width = 256;
    icanvas.height = 128;
    var itex = new THREE.CanvasTexture(icanvas);
    var imat = new THREE.SpriteMaterial({
      map: itex, transparent: true, depthTest: false, depthWrite: false,
    });
    var isprite = new THREE.Sprite(imat);
    isprite.scale.set(1.7, 0.85, 1);
    isprite.visible = false;
    isprite.renderOrder = 6;
    isprite.name = 'indicator';
    scene.add(isprite);
    indicatorPool.push({ sprite: isprite, canvas: icanvas, tex: itex, mat: imat, life: 0 });
  }

  function drawIndicator(item, text, color) {
    var c = item.canvas.getContext('2d');
    c.clearRect(0, 0, 256, 128);
    c.font = 'bold 74px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 12;
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.9)';
    c.strokeText(text, 128, 64);
    c.fillStyle = color;
    c.fillText(text, 128, 64);
    item.tex.needsUpdate = true;
  }

  function spawnIndicator(delta, pos) {
    if (!delta || !pos || !indicatorPool.length) return null;
    var item = indicatorPool[nextIndicator];
    nextIndicator = (nextIndicator + 1) % indicatorPool.length;
    for (var i = 0; i < indicators.length; i++) {
      if (indicators[i] === item) { indicators.splice(i, 1); break; }
    }
    drawIndicator(item, (delta > 0 ? '+' : '') + delta, delta > 0 ? '#8ef2a0' : '#ff7676');
    item.sprite.position.copy(pos);
    item.sprite.position.y += 0.55;
    item.sprite.visible = true;
    item.mat.opacity = 1;
    item.life = 1.15;
    indicators.push(item);
    return item;
  }

  /* Score never drops below zero. The floating label shows the nominal value,
   * because a player who misses at zero still needs to see that it cost them;
   * the score readout is the source of truth for what actually landed. */
  function addScore(delta, worldPos) {
    var before = state.score;
    state.score = Math.max(0, state.score + delta);
    var applied = state.score - before;
    emit('score', { score: state.score, delta: applied, nominal: delta });
    if (worldPos) spawnIndicator(delta, worldPos);
    return applied;
  }

  /* Everything a break needs is allocated once, up front.
   *
   * Adding or removing a light at runtime makes three.js recompile every
   * material in the scene, which is what made each destroyed target hitch.
   * The flash lights below live in the scene permanently at zero intensity,
   * and the shards are recycled, so a break allocates nothing. */
  var SHARDS_PER_BREAK = 16;
  var shardPool = [];
  var debris = [];

  // Opaque and shadowless on purpose: transparent shadow casters appearing all
  // at once is what actually cost ~300ms on the frame a target broke. The
  // shards fade by shrinking instead, which reads the same at this size.
  var shardMat = new THREE.MeshStandardMaterial({
    color: 0xff5555, emissive: 0xaa1111, emissiveIntensity: 0.5, flatShading: true,
  });
  for (var sp = 0; sp < (cfg.headless ? 0 : SHARDS_PER_BREAK * 3); sp++) {
    var shard = new THREE.Mesh(shardGeo, shardMat);
    shard.visible = false;
    shard.castShadow = false;
    shard.name = 'shard';
    scene.add(shard);
    shardPool.push(shard);
  }

  var flashPool = [];
  for (var fp = 0; fp < (cfg.headless ? 0 : 3); fp++) {
    var fl = new THREE.PointLight(0xff6644, 0, 12);
    fl.name = 'breakFlash';
    scene.add(fl);
    flashPool.push({ light: fl, life: 0 });
  }
  var nextFlash = 0;

  function takeShard() {
    for (var i = 0; i < shardPool.length; i++) {
      if (!shardPool[i].visible) return shardPool[i];
    }
    return null;                       // all in flight, skip rather than allocate
  }

  return {
    indicators: indicators, indicatorPool: indicatorPool,
    spawnIndicator: spawnIndicator, addScore: addScore,
    shardPool: shardPool, debris: debris, takeShard: takeShard,
    flashPool: flashPool, nextFlash: function () {
      var f = flashPool[nextFlash];
      nextFlash = (nextFlash + 1) % flashPool.length;
      return f;
    },
    updateFlashes: function (dt) {
      for (var f = 0; f < flashPool.length; f++) {
        var fl = flashPool[f];
        if (fl.life <= 0) continue;
        fl.life -= dt;
        fl.light.intensity = 14 * Math.max(0, fl.life / 0.28);
      }
    },
    updateIndicators: function (dt) {
      for (var q = indicators.length - 1; q >= 0; q--) {
        var ind = indicators[q];
        ind.life -= dt;
        ind.sprite.position.y += dt * 1.15;
        ind.mat.opacity = Math.max(0, Math.min(1, ind.life / 0.45));
        if (ind.life <= 0) { ind.sprite.visible = false; indicators.splice(q, 1); }
      }
    },
    updateDebris: function (dt) {
      for (var d = debris.length - 1; d >= 0; d--) {
        var p = debris[d];
        p.vel.y -= cfg.gravity * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        if (p.mesh.position.y < 0.1) {
          p.mesh.position.y = 0.1;
          p.vel.y *= -0.35;
          p.vel.multiplyScalar(0.7);
        }
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
        p.life -= dt;
        if (p.life < 0.6) p.mesh.scale.setScalar(Math.max(0.001, p.life / 0.6));
        if (p.life <= 0) { p.mesh.visible = false; debris.splice(d, 1); }
      }
    },
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
