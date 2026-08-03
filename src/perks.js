/* Perks: pickups that turn up around the arena and buy you a short advantage.
 *
 * The spawn schedule and the pickups themselves are simulation, not decoration,
 * so this runs headless on the server too — in a networked game the server
 * decides what exists and who collected it, and the clients follow.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

/* Each kind says how it changes the rules. The engine asks through
 * perkFactor()/perkFlag() rather than reading these directly, so a perk can
 * be added here without touching movement or shooting. */
PB.PERK_KINDS = [
  { kind: 'fireRate', label: 'RAPID FIRE', color: 0xffb03a, fireRate: 0.5 },
  { kind: 'speed', label: 'SPRINTER', color: 0x6ee7ff, speed: 1.45 },
  { kind: 'clip', label: 'BIG CLIP', color: 0xa78bfa, clip: 2 },
  { kind: 'doubleJump', label: 'DOUBLE JUMP', color: 0x8ef2a0, airJumps: 1 },
  /* Shielded is shielded — there is no partial version of not being hurt, so
   * this one is deliberately short. Fifteen seconds of it, the length of every
   * other perk, is most of a firefight. */
  { kind: 'shield', label: 'SHIELD', color: 0x8ef2ff, shield: 1, duration: 6 },
];

PB.createPerks = function (ctx) {
  var THREE = global.THREE;
  var cfg = ctx.cfg, rand = ctx.rand, half = ctx.half, scene = ctx.scene;
  var state = ctx.state, emit = ctx.emit;
  var obstacleBoxes = ctx.obstacleBoxes;

  var perks = [];
  var nextId = 1;
  var sinceSpawn = 0;

  var geo = cfg.headless ? null : {
    core: new THREE.OctahedronGeometry(0.42, 0),
    ring: new THREE.TorusGeometry(0.62, 0.06, 6, 16),
  };

  /* One material per kind, built up front and never disposed.
   *
   * Making them when a perk spawns means three.js compiles the shader on the
   * frame it first appears, which is a hitch in the middle of play — the same
   * problem the debris pool had. Existing at startup means the warm-up pass
   * covers them. */
  var mats = {};
  if (!cfg.headless) {
    PB.PERK_KINDS.forEach(function (def) {
      mats[def.kind] = {
        core: new THREE.MeshStandardMaterial({
          color: def.color, emissive: def.color, emissiveIntensity: 0.7,
          roughness: 0.3, flatShading: true,
        }),
        ring: new THREE.MeshBasicMaterial({
          color: def.color, transparent: true, opacity: 0.5,
        }),
      };
      // a hidden instance so the warm-up render has something to compile
      var warm = new THREE.Mesh(geo.core, mats[def.kind].core);
      var warmRing = new THREE.Mesh(geo.ring, mats[def.kind].ring);
      warm.visible = warmRing.visible = false;
      warm.name = warmRing.name = 'perkWarmUp';
      scene.add(warm, warmRing);
    });
  }

  function kindByName(name) {
    for (var i = 0; i < PB.PERK_KINDS.length; i++) {
      if (PB.PERK_KINDS[i].kind === name) return PB.PERK_KINDS[i];
    }
    return null;
  }

  function build(def, x, y, z) {
    if (cfg.headless) return null;
    var group = new THREE.Group();
    var core = new THREE.Mesh(geo.core, mats[def.kind].core);
    var ring = new THREE.Mesh(geo.ring, mats[def.kind].ring);
    ring.rotation.x = Math.PI / 2;
    group.add(core, ring);
    // what it is, said out loud: the colours alone do not tell a new player
    // whether the orange one is worth crossing the arena for
    // clear of the ring, which is 0.62 across and bobs with the pickup
    var tag = PB.createNameTag(def.label, '#' + def.color.toString(16).padStart(6, '0'),
                               { y: 1.35, scale: 1.9, font: 30 });
    group.add(tag.sprite);
    group.position.set(x, y, z);
    group.name = 'perk';
    scene.add(group);
    return { group: group, core: core, ring: ring, tag: tag };
  }

  var _spot = new THREE.Vector3();

  function clearSpot() {
    for (var tries = 0; tries < 60; tries++) {
      var x = (rand() - 0.5) * (cfg.arena - 10);
      var z = (rand() - 0.5) * (cfg.arena - 10);
      if (Math.hypot(x, z) < 5) continue;
      _spot.set(x, 1.1, z);
      var clash = false;
      for (var i = 0; i < obstacleBoxes.length; i++) {
        if (obstacleBoxes[i].distanceToPoint(_spot) < 1.4) { clash = true; break; }
      }
      if (clash) continue;
      for (var p = 0; p < perks.length; p++) {
        if (Math.hypot(perks[p].x - x, perks[p].z - z) < 6) { clash = true; break; }
      }
      if (clash) continue;
      return { x: x, z: z };
    }
    return null;
  }

  // Put one out. `spec` lets the server replay an exact perk onto a client.
  function spawn(spec) {
    var def = spec && spec.kind ? kindByName(spec.kind)
      : PB.PERK_KINDS[Math.floor(rand() * PB.PERK_KINDS.length)];
    if (!def) return null;

    var at = spec && typeof spec.x === 'number'
      ? { x: spec.x, z: spec.z }
      : clearSpot();
    if (!at) return null;

    var y = spec && typeof spec.y === 'number' ? spec.y : 1.1;
    var perk = {
      id: spec && spec.id ? spec.id : nextId++,
      kind: def.kind, def: def,
      x: at.x, y: y, z: at.z,
      life: spec && spec.life ? spec.life : cfg.perkLife,
      phase: rand() * 6.28,
      view: build(def, at.x, y, at.z),
    };
    if (perk.id >= nextId) nextId = perk.id + 1;
    perks.push(perk);
    emit('perkSpawn', perk);
    return perk;
  }

  function remove(perk) {
    var i = perks.indexOf(perk);
    if (i !== -1) perks.splice(i, 1);
    // the materials are shared between every perk of this kind, so they stay —
    // the label is this pickup's own, so it goes
    if (perk.view) {
      scene.remove(perk.view.group);
      if (perk.view.tag) {
        perk.view.tag.material.dispose();
        perk.view.tag.texture.dispose();
      }
    }
  }

  function byId(id) {
    for (var i = 0; i < perks.length; i++) if (perks[i].id === id) return perks[i];
    return null;
  }

  /* Hand the effect to a player. `holder` is the timer bag — the local player's
   * state, or a player record on the server. */
  function grant(holder, kind) {
    var def = kindByName(kind);
    if (!def) return false;
    holder.perks = holder.perks || {};
    // most last the standard time; a kind may ask for its own
    holder.perks[kind] = def.duration || cfg.perkDuration;
    return true;
  }

  // How long a kind runs for, so the client can say so when it is picked up.
  function durationOf(kind) {
    var def = kindByName(kind);
    return (def && def.duration) || cfg.perkDuration;
  }

  function tickHolder(holder, dt) {
    if (!holder.perks) return;
    for (var k in holder.perks) {
      if (!Object.prototype.hasOwnProperty.call(holder.perks, k)) continue;
      holder.perks[k] -= dt;
      if (holder.perks[k] <= 0) {
        delete holder.perks[k];
        if (holder === state) emit('perkExpired', { kind: k });
      }
    }
  }

  function held(holder, kind) {
    return !!(holder && holder.perks && holder.perks[kind] > 0);
  }

  // Whatever a perk multiplies, or 1 when it is not held.
  function factor(holder, field) {
    var out = 1;
    if (!holder || !holder.perks) return out;
    for (var i = 0; i < PB.PERK_KINDS.length; i++) {
      var def = PB.PERK_KINDS[i];
      if (def[field] && holder.perks[def.kind] > 0) out *= def[field];
    }
    return out;
  }

  function bonus(holder, field) {
    var out = 0;
    if (!holder || !holder.perks) return out;
    for (var i = 0; i < PB.PERK_KINDS.length; i++) {
      var def = PB.PERK_KINDS[i];
      if (def[field] && holder.perks[def.kind] > 0) out += def[field];
    }
    return out;
  }

  // Anything within reach of this position, nearest first.
  function pickUpAt(x, z, y) {
    for (var i = 0; i < perks.length; i++) {
      var p = perks[i];
      var flat = Math.hypot(p.x - x, p.z - z);
      if (flat > cfg.perkRadius) continue;
      if (typeof y === 'number' && Math.abs(p.y - y) > 2.2) continue;
      return p;
    }
    return null;
  }

  function update(dt, playerPos) {
    if (!cfg.perks) return;

    sinceSpawn += dt;
    if (sinceSpawn >= cfg.perkEvery) {
      sinceSpawn = 0;
      if (perks.length < cfg.perkMax) spawn();
    }

    for (var i = perks.length - 1; i >= 0; i--) {
      var p = perks[i];
      p.life -= dt;
      p.phase += dt;
      if (p.view) {
        p.view.group.rotation.y += dt * 1.6;
        p.view.group.position.y = p.y + Math.sin(p.phase * 2) * 0.16;
        p.view.ring.rotation.z += dt * 0.9;
        p.view.group.updateMatrixWorld(true);
      }
      if (p.life <= 0) remove(p);
    }

    // single player collects by walking over them; networked play leaves this
    // to the server, which tells us who picked up what
    if (playerPos && !state.networked) {
      var got = pickUpAt(playerPos.x, playerPos.z, playerPos.y - cfg.eye);
      if (got) {
        grant(state, got.kind);
        emit('perk', { kind: got.kind, id: got.id, label: got.def.label, mine: true });
        remove(got);
      }
    }
  }

  function describe() {
    return perks.map(function (p) {
      return [p.id, p.kind, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
              +p.life.toFixed(1)];
    });
  }

  // Rebuild the list from the server's description.
  function applyList(list) {
    var wanted = {};
    var i, entry;
    for (i = 0; i < list.length; i++) wanted[list[i][0]] = list[i];

    for (i = perks.length - 1; i >= 0; i--) {
      if (!wanted[perks[i].id]) remove(perks[i]);
    }
    for (i = 0; i < list.length; i++) {
      entry = list[i];
      var have = byId(entry[0]);
      if (have) { have.life = entry[5]; continue; }
      spawn({ id: entry[0], kind: entry[1], x: entry[2], y: entry[3], z: entry[4],
              life: entry[5] });
    }
  }

  function clear() {
    for (var i = perks.length - 1; i >= 0; i--) remove(perks[i]);
  }

  return {
    perks: perks, kinds: PB.PERK_KINDS, kindByName: kindByName,
    spawn: spawn, remove: remove, byId: byId, clear: clear,
    grant: grant, tickHolder: tickHolder, held: held, durationOf: durationOf,
    factor: factor, bonus: bonus, pickUpAt: pickUpAt,
    update: update, describe: describe, applyList: applyList,
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
