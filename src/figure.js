/* The low-poly humanoid, shared by the NPCs and by remote players.
 *
 * Body parts hang off pivots so the run cycle and the airborne tuck are pure
 * rotations — no skinning, no animation data, just a phase.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.FIGURE_HEIGHT = 1.8;

/* What a round is actually tested against, in the figure's own space.
 *
 * Defined once because three places have to agree on it: the box hung on the
 * figure here, which is what the client raycasts; the box the server builds
 * for a player; and the one the server rewinds through. Written out separately
 * in each, they drift, and a drifted hitbox is a shot that lands on one screen
 * and not on the other.
 *
 * It hugs the body rather than the pose. The figure measures ±0.23 across the
 * torso and stands 0.12 to 1.76 off the ground, so this covers it with very
 * little to spare — where the old box was 0.72 wide with a hand's width of air
 * under the feet, sized for arms held out and a leg at the top of its swing.
 * You cannot be shot by the far end of your own rifle or by a boot thrown out
 * behind you, which is how it should be.
 *
 * Square in plan on purpose: the figure turns with its owner and the server's
 * box does not, so anything else would make a player easier to hit from the
 * side than from the front. */
PB.HIT = {
  half: 0.26,        // across, and front to back
  bottom: 0.10,      // the soles, not the ground beneath them
  top: 1.78,         // the crown, not a round number above it
};
PB.HIT.height = PB.HIT.top - PB.HIT.bottom;
PB.HIT.midY = (PB.HIT.top + PB.HIT.bottom) / 2;

/* Turn a figure to face the way it is going.
 *
 * A heading is a direction of travel — (sin h, cos h) — while a figure's front
 * is its local -Z, so the two are a half turn apart. That half turn belongs in
 * one place because two of them need it: the engine, simulating an NPC, and a
 * client drawing one from a snapshot. Written out in only the first of those,
 * every NPC in a networked game walked backwards — which nobody noticed for as
 * long as they only wandered, and which was unmissable the moment one of them
 * started walking at people.
 *
 * Players are not turned through here: a yaw of 0 already looks down -Z, the
 * same way the camera does, so their figures take their yaw unchanged. */
PB.faceHeading = function (obj, heading) {
  obj.rotation.y = heading + Math.PI;
  return obj.rotation.y;
};

PB.buildFigure = function (opts) {
  var THREE = global.THREE;
  var shadows = opts.shadows !== false;
  var geo = opts.geo || PB.figureGeometry();
  var isPlayer = opts.variant === 'player';

  var body = new THREE.MeshStandardMaterial({
    color: opts.color, roughness: 0.75, flatShading: true,
  });
  var trim = new THREE.MeshStandardMaterial({
    color: opts.trim || opts.color, roughness: 0.8, flatShading: true,
  });

  function limb(g, mat, pivotY, side, length) {
    var pivot = new THREE.Object3D();
    pivot.position.set(side, pivotY, 0);
    var mesh = new THREE.Mesh(g, mat);
    mesh.position.y = -length / 2;
    mesh.castShadow = shadows;
    pivot.add(mesh);
    return pivot;
  }

  var root = new THREE.Group();
  root.name = opts.name || 'figure';

  var torso = new THREE.Mesh(geo.torso, body);
  torso.position.y = 1.16;
  torso.castShadow = shadows;
  root.add(torso);

  var head = new THREE.Mesh(geo.head, body);
  head.position.y = 1.62;
  head.castShadow = shadows;
  root.add(head);

  var armL = limb(geo.limbUpper, trim, 1.40, -0.30, 0.50);
  var armR = limb(geo.limbUpper, trim, 1.40, 0.30, 0.50);
  var legL = limb(geo.leg, trim, 0.82, -0.12, 0.70);
  var legR = limb(geo.leg, trim, 0.82, 0.12, 0.70);
  root.add(armL, armR, legL, legR);

  // one invisible box catches the bullets for the whole figure
  var hitbox = new THREE.Mesh(geo.hit, new THREE.MeshBasicMaterial());
  hitbox.position.y = PB.HIT.midY;
  hitbox.visible = false;
  root.add(hitbox);

  var materials = [body, trim];
  var extras = [];
  var shield = null;

  /* A player has to be readable as a player at a glance — the same box body in
   * a different colour is not enough when NPCs come in every hue. Players get
   * a visor, a pack on the back and a weapon in hand. */
  if (isPlayer) {
    var visorMat = new THREE.MeshStandardMaterial({
      color: 0x101820, roughness: 0.25, metalness: 0.6,
      emissive: opts.accent || 0x39d0ff, emissiveIntensity: 0.45,
    });
    var gearMat = new THREE.MeshStandardMaterial({
      color: 0x1c222c, roughness: 0.8, flatShading: true,
    });
    materials.push(visorMat, gearMat);

    var visor = new THREE.Mesh(geo.visor, visorMat);
    visor.position.set(0, 1.63, -0.15);
    root.add(visor);
    extras.push(visor);

    var pack = new THREE.Mesh(geo.pack, gearMat);
    pack.position.set(0, 1.22, 0.2);
    pack.castShadow = shadows;
    root.add(pack);
    extras.push(pack);

    // carried weapon, held out in front in the right hand
    var held = new THREE.Mesh(geo.weapon, gearMat);
    held.position.set(0, -0.32, -0.26);
    armR.add(held);
    extras.push(held);

    /* A bubble that goes up while they cannot be hurt — just after they
     * respawn, or while they are holding the shield. Additive and unlit so it
     * reads as a field rather than another piece of kit. */
    var shieldMat = new THREE.MeshBasicMaterial({
      color: 0x8ef2ff, transparent: true, opacity: 0.22,
      depthWrite: false, side: THREE.DoubleSide,
    });
    shieldMat.name = 'shieldMat';       // never restyled with the body
    materials.push(shieldMat);
    shield = new THREE.Mesh(geo.shield, shieldMat);
    shield.position.y = 0.95;
    shield.visible = false;
    shield.name = 'shield';
    root.add(shield);
  }

  return {
    root: root, torso: torso, head: head,
    armL: armL, armR: armR, legL: legL, legR: legR, hitbox: hitbox,
    shield: shield,
    isPlayer: isPlayer,
    extras: extras,
    materials: materials,
  };
};

/* A name that floats over a figure or a pickup. Drawn into a canvas and
 * redrawn only when the text changes, which is rare — a player renaming
 * themselves, and nothing else. */
PB.createNameTag = function (text, colour, opts) {
  var THREE = global.THREE;
  var o = opts || {};
  var canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  var tex = new THREE.CanvasTexture(canvas);
  /* Depth-tested, so a name is hidden by whatever the player is hidden by.
   * Drawn without writing depth, so two tags never punch holes in each other.
   * These used to ignore depth entirely, which turned every tag into a
   * wallhack: you could read where somebody was through solid cover. */
  var mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false,
  });
  var sprite = new THREE.Sprite(mat);
  sprite.scale.set(o.scale || 2.2, (o.scale || 2.2) / 4, 1);
  sprite.position.y = o.y === undefined ? 2.05 : o.y;
  sprite.renderOrder = 7;
  sprite.name = 'nameTag';

  var tag = { sprite: sprite, texture: tex, material: mat, text: '' };

  tag.set = function (next) {
    var s = (next === undefined || next === null ? '' : String(next));
    if (s === tag.text) return tag;
    tag.text = s;
    var c = canvas.getContext('2d');
    c.clearRect(0, 0, 256, 64);
    c.font = 'bold ' + (o.font || 34) + 'px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 8;
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(s, 128, 34);
    c.fillStyle = colour || '#e6edf3';
    c.fillText(s, 128, 34);
    tex.needsUpdate = true;
    return tag;
  };

  tag.set(text);
  return tag;
};

/* A health bar to float over somebody's head. Redrawn only when the number
 * changes — a canvas repaint per frame for every player would be wasteful. */
PB.createHealthBar = function () {
  var THREE = global.THREE;
  var canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 20;
  var tex = new THREE.CanvasTexture(canvas);
  // depth-tested for the same reason the name is: no reading somebody's
  // health through the crate they are hiding behind
  var mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false,
  });
  var sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.5, 0.23, 1);
  sprite.position.y = 2.32;
  sprite.renderOrder = 8;
  sprite.name = 'healthBar';
  sprite.visible = false;

  var shown = -1;

  function draw(fraction) {
    var c = canvas.getContext('2d');
    c.clearRect(0, 0, 128, 20);
    c.fillStyle = 'rgba(0,0,0,0.72)';
    c.fillRect(0, 0, 128, 20);
    var w = Math.max(0, Math.min(1, fraction)) * 120;
    // green while healthy, amber when worn down, red when nearly gone
    c.fillStyle = fraction > 0.6 ? '#8ef2a0' : fraction > 0.3 ? '#ffb03a' : '#ff6b6b';
    c.fillRect(4, 4, w, 12);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 2;
    c.strokeRect(1, 1, 126, 18);
    tex.needsUpdate = true;
  }

  return {
    sprite: sprite, texture: tex, material: mat,
    /* Only ever shown on somebody who has been hurt. */
    set: function (health, max) {
      var f = max > 0 ? health / max : 1;
      if (f !== shown) { draw(f); shown = f; }
      sprite.visible = f < 1 && health > 0;
      return sprite.visible;
    },
  };
};

PB.figureGeometry = function () {
  var THREE = global.THREE;
  return {
    torso: new THREE.BoxGeometry(0.46, 0.60, 0.26),
    head: new THREE.BoxGeometry(0.28, 0.28, 0.28),
    limbUpper: new THREE.BoxGeometry(0.13, 0.50, 0.15),
    leg: new THREE.BoxGeometry(0.17, 0.70, 0.19),
    hit: new THREE.BoxGeometry(PB.HIT.half * 2, PB.HIT.height, PB.HIT.half * 2),
    visor: new THREE.BoxGeometry(0.30, 0.10, 0.04),
    pack: new THREE.BoxGeometry(0.34, 0.38, 0.16),
    weapon: new THREE.BoxGeometry(0.09, 0.09, 0.46),
    shield: new THREE.SphereGeometry(1.05, 14, 10),
  };
};

/* Pose a figure. `phase` advances with distance travelled, so the legs stay in
 * step with the ground whether the figure is an NPC deciding its own path or a
 * remote player being interpolated between snapshots. */
PB.poseFigure = function (fig, o) {
  // the shield turns slowly so it reads as a field rather than a decal
  if (fig.shield && fig.shield.visible) {
    fig.shield.rotation.y = (o.phase || 0) * 0.25;
  }
  if (o.grounded) {
    var swing = Math.sin(o.phase);
    var amp = o.moving === undefined ? 1 : (o.moving ? 1 : 0);
    fig.legL.rotation.x = swing * 0.85 * amp;
    fig.legR.rotation.x = -swing * 0.85 * amp;
    fig.armL.rotation.x = -swing * 0.65 * amp;
    fig.armR.rotation.x = swing * 0.65 * amp;
    fig.torso.rotation.x = 0.12 * amp + Math.abs(swing) * 0.04 * amp;
    fig.torso.position.y = 1.16 + Math.abs(Math.sin(o.phase * 2)) * 0.05 * amp;
    fig.head.position.y = 1.62 + Math.abs(Math.sin(o.phase * 2)) * 0.05 * amp;
  } else {
    var tuck = Math.min(1, Math.abs(o.vy || 0) / 7 + 0.35);
    fig.legL.rotation.x = -0.9 * tuck;
    fig.legR.rotation.x = -0.45 * tuck;
    fig.armL.rotation.x = -2.1 * tuck;
    fig.armR.rotation.x = -2.1 * tuck;
    fig.torso.rotation.x = -0.15;
    fig.torso.position.y = 1.16;
    fig.head.position.y = 1.62;
  }
};

})(typeof window !== 'undefined' ? window : globalThis);
