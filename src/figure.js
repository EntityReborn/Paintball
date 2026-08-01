/* The low-poly humanoid, shared by the NPCs and by remote players.
 *
 * Body parts hang off pivots so the run cycle and the airborne tuck are pure
 * rotations — no skinning, no animation data, just a phase.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.FIGURE_HEIGHT = 1.8;

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
  hitbox.position.y = PB.FIGURE_HEIGHT / 2;
  hitbox.visible = false;
  root.add(hitbox);

  var materials = [body, trim];
  var extras = [];

  /* A player has to be readable as a player at a glance — the same box body in
   * a different colour is not enough when NPCs come in every hue. Players get
   * a visor, a pack on the back, a weapon in hand and a marker overhead. */
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

    // a floating marker so a player reads as one across the arena
    var markMat = new THREE.MeshBasicMaterial({
      color: opts.accent || 0x39d0ff, transparent: true, opacity: 0.85,
      depthTest: false,
    });
    materials.push(markMat);
    var mark = new THREE.Mesh(geo.marker, markMat);
    mark.position.y = 2.25;
    mark.renderOrder = 4;
    root.add(mark);
    extras.push(mark);

    root.userData.marker = mark;
  }

  return {
    root: root, torso: torso, head: head,
    armL: armL, armR: armR, legL: legL, legR: legR, hitbox: hitbox,
    marker: root.userData.marker || null,
    isPlayer: isPlayer,
    extras: extras,
    materials: materials,
  };
};

PB.figureGeometry = function () {
  var THREE = global.THREE;
  return {
    torso: new THREE.BoxGeometry(0.46, 0.60, 0.26),
    head: new THREE.BoxGeometry(0.28, 0.28, 0.28),
    limbUpper: new THREE.BoxGeometry(0.13, 0.50, 0.15),
    leg: new THREE.BoxGeometry(0.17, 0.70, 0.19),
    hit: new THREE.BoxGeometry(0.72, PB.FIGURE_HEIGHT, 0.55),
    visor: new THREE.BoxGeometry(0.30, 0.10, 0.04),
    pack: new THREE.BoxGeometry(0.34, 0.38, 0.16),
    weapon: new THREE.BoxGeometry(0.09, 0.09, 0.46),
    marker: new THREE.OctahedronGeometry(0.13, 0),
  };
};

/* Pose a figure. `phase` advances with distance travelled, so the legs stay in
 * step with the ground whether the figure is an NPC deciding its own path or a
 * remote player being interpolated between snapshots. */
PB.poseFigure = function (fig, o) {
  // the overhead marker bobs and spins so it catches the eye
  if (fig.marker) {
    fig.marker.rotation.y = (o.phase || 0) * 0.5;
    fig.marker.position.y = 2.25 + Math.sin((o.phase || 0) * 0.8) * 0.06;
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
