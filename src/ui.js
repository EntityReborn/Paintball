/* The pause-screen panels: options and debug.
 *
 * Both live outside the menu element on purpose. Clicking the menu is what
 * grabs the pointer and starts play, so a panel nested inside it would drop
 * the player into the game every time they reached for a slider.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createUI = function (opts) {
  var doc = global.document;
  var options = opts.options;
  var getGame = opts.getGame || function () { return null; };
  var getNet = opts.getNet || function () { return null; };

  var root = doc.getElementById('panels');
  var openPanel = null;

  function el(id) { return doc.getElementById(id); }

  function show(name) {
    openPanel = openPanel === name ? null : name;
    ['options', 'debug'].forEach(function (p) {
      var node = el('panel-' + p);
      if (node) node.classList.toggle('on', openPanel === p);
    });
    if (root) root.classList.toggle('on', !!openPanel);
    return openPanel;
  }

  function close() {
    openPanel = null;
    ['options', 'debug'].forEach(function (p) {
      var node = el('panel-' + p);
      if (node) node.classList.remove('on');
    });
    if (root) root.classList.remove('on');
  }

  /* Everything the options panel drives. Each entry says how to read the
   * control and what to do with the value, so applying saved settings at boot
   * and reacting to a change are the same code path. */
  var apply = {
    name: function (v) {
      var net = getNet();
      if (net) net.setName && net.setName(v);
    },
    sensitivity: function (v) {
      var game = getGame();
      if (game) game.setSensitivity(v);
    },
    invertY: function (v) {
      var game = getGame();
      if (game) game.setInvertY(v);
    },
    masterVolume: function (v) {
      var game = getGame();
      if (game && game.sfx && game.sfx.setVolume) game.sfx.setVolume('master', v);
    },
    gunVolume: function (v) {
      var game = getGame();
      if (game && game.sfx && game.sfx.setVolume) game.sfx.setVolume('gun', v);
    },
    showNames: function (v) {
      var net = getNet();
      if (net && net.setShowNames) net.setShowNames(v);
    },
    pvp: function (v) {
      var net = getNet();
      if (net && net.setPvp) net.setPvp(v);
    },
    hitboxes: function (v) {
      var game = getGame();
      if (game && game.debugView) game.debugView.setHitboxes(v);
    },
    colliders: function (v) {
      var game = getGame();
      if (game && game.debugView) game.debugView.setColliders(v);
    },
  };

  function applyAll() {
    var all = options.all();
    for (var k in apply) {
      if (Object.prototype.hasOwnProperty.call(apply, k)) apply[k](all[k]);
    }
    return all;
  }

  function bindRange(id, key, format) {
    var input = el(id);
    var out = el(id + '-value');
    if (!input) return;
    input.value = options.get(key);
    if (out) out.textContent = format(options.get(key));
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      options.set(key, v);
      if (out) out.textContent = format(options.get(key));
      apply[key](options.get(key));
    });
  }

  function bindToggle(id, key) {
    var input = el(id);
    if (!input) return;
    input.checked = !!options.get(key);
    input.addEventListener('change', function () {
      options.set(key, input.checked);
      input.checked = !!options.get(key);
      apply[key](options.get(key));
    });
  }

  function bindText(id, key) {
    var input = el(id);
    if (!input) return;
    input.value = options.get(key);
    var commit = function () {
      options.set(key, input.value);
      input.value = options.get(key);       // show what was actually kept
      apply[key](options.get(key));
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
  }

  function wire() {
    // opening a panel must not also start the game
    [['btn-options', 'options'], ['btn-debug', 'debug']].forEach(function (pair) {
      var button = el(pair[0]);
      if (!button) return;
      button.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        show(pair[1]);
      });
    });

    if (root) {
      root.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    ['close-options', 'close-debug'].forEach(function (id) {
      var b = el(id);
      if (b) b.addEventListener('click', function (e) { e.stopPropagation(); close(); });
    });

    var resetButton = el('reset-options');
    if (resetButton) {
      resetButton.addEventListener('click', function (e) {
        e.stopPropagation();
        options.reset();
        refresh();
        applyAll();
      });
    }

    bindText('opt-name', 'name');
    bindRange('opt-sensitivity', 'sensitivity', function (v) { return v.toFixed(2) + 'x'; });
    bindRange('opt-master', 'masterVolume', function (v) { return Math.round(v * 100) + '%'; });
    bindRange('opt-gun', 'gunVolume', function (v) { return Math.round(v * 100) + '%'; });
    bindToggle('opt-invert', 'invertY');
    bindToggle('opt-names', 'showNames');
    bindToggle('opt-pvp', 'pvp');
    bindToggle('dbg-hitboxes', 'hitboxes');
    bindToggle('dbg-colliders', 'colliders');
  }

  // Push stored values back into the controls (after a reset, say).
  function refresh() {
    var all = options.all();
    var set = function (id, value, checkbox) {
      var node = el(id);
      if (!node) return;
      if (checkbox) node.checked = !!value; else node.value = value;
    };
    set('opt-name', all.name);
    set('opt-sensitivity', all.sensitivity);
    set('opt-master', all.masterVolume);
    set('opt-gun', all.gunVolume);
    set('opt-invert', all.invertY, true);
    set('opt-names', all.showNames, true);
    set('opt-pvp', all.pvp, true);
    set('dbg-hitboxes', all.hitboxes, true);
    set('dbg-colliders', all.colliders, true);

    var label = function (id, text) {
      var node = el(id);
      if (node) node.textContent = text;
    };
    label('opt-sensitivity-value', all.sensitivity.toFixed(2) + 'x');
    label('opt-master-value', Math.round(all.masterVolume * 100) + '%');
    label('opt-gun-value', Math.round(all.gunVolume * 100) + '%');
  }

  wire();
  refresh();

  return {
    show: show, close: close, refresh: refresh, applyAll: applyAll,
    isOpen: function () { return openPanel; },
    apply: apply,
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
