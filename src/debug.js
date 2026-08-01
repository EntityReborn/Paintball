/* Debug overlays: what the game actually collides and shoots against.
 *
 * These draw the real data structures rather than copies of them — the
 * collider wireframes hold the same Box3 objects the player is resolved
 * against, and the hitbox outlines are parented to the very meshes bullets
 * are raycast at. If an overlay disagrees with what happens in play, the
 * overlay is right and something else is wrong.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createDebug = function (ctx) {
  var THREE = global.THREE;
  var scene = ctx.scene, cfg = ctx.cfg;

  var colliderGroup = new THREE.Group();
  var hitboxGroup = new THREE.Group();
  colliderGroup.name = 'debugColliders';
  hitboxGroup.name = 'debugHitboxes';
  colliderGroup.visible = false;
  hitboxGroup.visible = false;
  scene.add(colliderGroup, hitboxGroup);

  var COLOURS = {
    wall: 0x5b8dd6,
    obstacle: 0x39d0ff,
    mover: 0xffb03a,
    structure: 0xa78bfa,
    hitbox: 0xff5d5d,
    target: 0x8ef2a0,
  };

  var mats = {};
  function lineMat(colour) {
    if (!mats[colour]) {
      mats[colour] = new THREE.LineBasicMaterial({ color: colour, depthTest: true });
    }
    return mats[colour];
  }

  var state = { colliders: false, hitboxes: false };
  var built = { colliders: false, hitboxes: false };

  function clear(group) {
    for (var i = group.children.length - 1; i >= 0; i--) {
      group.remove(group.children[i]);
    }
  }

  /* Which kind of thing a collider belongs to, so the overlay is readable
   * rather than a uniform box soup. */
  function classify(box) {
    var i;
    for (i = 0; i < ctx.movers.length; i++) if (ctx.movers[i].box === box) return 'mover';
    if (ctx.balcony && ctx.balcony.parts) {
      for (i = 0; i < ctx.balcony.parts.length; i++) {
        if (ctx.balcony.parts[i].box === box) return 'structure';
      }
    }
    if (ctx.obstacleBoxes.indexOf(box) !== -1) return 'obstacle';
    return 'wall';
  }

  function buildColliders() {
    clear(colliderGroup);
    for (var i = 0; i < ctx.colliders.length; i++) {
      var box = ctx.colliders[i];
      // Box3Helper keeps a reference to the box and re-reads it every frame,
      // so the sliding cover drags its wireframe along for free
      var helper = new THREE.Box3Helper(box, COLOURS[classify(box)]);
      helper.material = lineMat(COLOURS[classify(box)]);
      colliderGroup.add(helper);
    }
    built.colliders = true;
  }

  var boxGeo = null;

  function outlineOf(mesh, colour) {
    var edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry), lineMat(colour));

    /* A hitbox is invisible, and three.js skips the whole subtree of an
     * invisible object — an outline hung on one would never be drawn, which
     * is exactly what happened to the NPC boxes. Attach it to the same parent
     * instead and copy the transform, so it still follows the figure. */
    var host = mesh.visible ? mesh : (mesh.parent || scene);
    if (host !== mesh) {
      edges.position.copy(mesh.position);
      edges.quaternion.copy(mesh.quaternion);
      edges.scale.copy(mesh.scale);
    }
    host.add(edges);
    return edges;
  }

  function buildHitboxes() {
    clear(hitboxGroup);
    var made = [];

    // the boxes bullets are actually tested against
    for (var i = 0; i < ctx.solidMeshes.length; i++) {
      var m = ctx.solidMeshes[i];
      if (!m.userData || !m.userData.npc) continue;
      made.push(outlineOf(m, COLOURS.hitbox));
    }

    // remote players carry the same kind of box
    if (ctx.remoteHitboxes) {
      for (var r = 0; r < ctx.remoteHitboxes.length; r++) {
        made.push(outlineOf(ctx.remoteHitboxes[r], COLOURS.hitbox));
      }
    }

    // targets are raycast as their own mesh, so outline that
    for (var t = 0; t < ctx.targets.length; t++) {
      if (!ctx.targets[t].alive) continue;
      made.push(outlineOf(ctx.targets[t].mesh, COLOURS.target));
    }

    hitboxGroup.userData.outlines = made;
    built.hitboxes = true;
    return made;
  }

  function tearDownHitboxes() {
    var made = hitboxGroup.userData.outlines || [];
    for (var i = 0; i < made.length; i++) {
      if (made[i].parent) made[i].parent.remove(made[i]);
      made[i].geometry.dispose();
    }
    hitboxGroup.userData.outlines = [];
    built.hitboxes = false;
  }

  function setColliders(on) {
    state.colliders = !!on;
    if (state.colliders && !built.colliders) buildColliders();
    colliderGroup.visible = state.colliders;
    return state.colliders;
  }

  function setHitboxes(on) {
    state.hitboxes = !!on;
    if (state.hitboxes) {
      if (built.hitboxes) tearDownHitboxes();
      buildHitboxes();
    } else if (built.hitboxes) {
      tearDownHitboxes();
    }
    hitboxGroup.visible = state.hitboxes;
    return state.hitboxes;
  }

  // The world can change under us: a new level brings new NPCs and targets.
  function refresh() {
    if (state.hitboxes) setHitboxes(true);
    if (state.colliders) buildColliders();
  }

  return {
    setColliders: setColliders,
    setHitboxes: setHitboxes,
    refresh: refresh,
    state: state,
    colliderGroup: colliderGroup,
    hitboxGroup: hitboxGroup,
    colliderCount: function () { return colliderGroup.children.length; },
    hitboxCount: function () { return (hitboxGroup.userData.outlines || []).length; },
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
