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

  var PANELS = ['options', 'match', 'debug'];

  function show(name) {
    openPanel = openPanel === name ? null : name;
    PANELS.forEach(function (p) {
      var node = el('panel-' + p);
      if (node) node.classList.toggle('on', openPanel === p);
    });
    if (root) root.classList.toggle('on', !!openPanel);
    if (openPanel === 'match') refreshMatch();
    return openPanel;
  }

  function close() {
    openPanel = null;
    PANELS.forEach(function (p) {
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
    /* Both sides of it: the room has to be told, because it decides who may
     * hurt whom, and our own world has to be told, because its hunters are
     * ours and there is no server in a single-player game to ask. */
    mode: function (v) {
      var net = getNet();
      if (net && net.setMode) net.setMode(v);
      var game = getGame();
      if (game && game.setMode) game.setMode(v);
      var note = el('mode-note');
      if (note) note.textContent = PB.modeOf(v).hint;
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

  function bindSelect(id, key) {
    var input = el(id);
    if (!input) return;
    input.value = options.get(key);
    input.addEventListener('change', function () {
      options.set(key, input.value);
      input.value = options.get(key);       // show what was actually kept
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

  /* ------------------------------------------------------- the controls */
  /* Online these do not belong to this player: the room restarts, and the
   * room is told who did it. Offline they are simply this game's. Either way
   * the panel says which it is, because "restart" meaning "restart for four
   * other people" is worth knowing before pressing it. */
  var onlineNow = function () {
    var net = getNet();
    return !!(net && net.self && net.self.id);
  };

  function refreshMatch() {
    var where = el('match-where');
    if (where) {
      where.textContent = onlineNow()
        ? 'Online — these are the room\'s. Everybody gets the new map, and ' +
          'everybody is told who asked for it.'
        : 'Offline — this map is yours alone.';
    }
    var restart = el('match-restart');
    if (restart && restart.dataset.armed !== '1') {
      restart.textContent = 'RESTART THE MATCH';
    }
  }

  function addCount() {
    var input = el('match-count');
    var n = input ? parseInt(input.value, 10) : 3;
    return isFinite(n) ? Math.max(1, Math.min(10, n)) : 3;
  }

  function said(text) {
    var note = el('match-added');
    if (note) note.textContent = text;
  }

  function wireMatch() {
    var counter = el('match-count');
    var counterOut = el('match-count-value');
    if (counter && counterOut) {
      counterOut.textContent = counter.value;
      counter.addEventListener('input', function () {
        counterOut.textContent = String(addCount());
      });
    }

    Array.prototype.forEach.call(doc.querySelectorAll('[data-add]'), function (button) {
      button.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        var what = button.getAttribute('data-add');
        var n = addCount();
        var net = getNet();
        if (onlineNow()) {
          net.addToLevel(what, n);
          said('Asked the room for ' + n + ' more ' + what + (n === 1 ? '' : 's') + '.');
          return;
        }
        var game = getGame();
        if (!game) return;
        var made = game.addToLevel(what, n);
        said('Added ' + made + ' ' + what + (made === 1 ? '' : 's') + ' to this level.');
      });
    });

    /* Two presses to restart. It throws away the map, the level and every
     * figure in the session — for everybody, online — and a single misplaced
     * click doing that is not a thing to build. */
    var restart = el('match-restart');
    var armFor = null;
    if (restart) {
      restart.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (restart.dataset.armed !== '1') {
          restart.dataset.armed = '1';
          restart.textContent = 'SURE? THIS ENDS THE MATCH';
          clearTimeout(armFor);
          armFor = setTimeout(function () {
            restart.dataset.armed = '0';
            restart.textContent = 'RESTART THE MATCH';
          }, 4000);
          return;
        }
        clearTimeout(armFor);
        restart.dataset.armed = '0';
        restart.textContent = 'RESTARTING…';

        var wipe = el('match-wipe-career');
        if (wipe && wipe.checked && global.career && global.career.clear) {
          global.career.clear();
        }
        if (onlineNow()) {
          // the room rebuilds and tells everyone, including us, to come back
          // onto the new map
          getNet().restart();
          return;
        }
        /* Offline a new map means a new world, and a world is built once when
         * the game is. Coming back through the front door is the honest way
         * to get one: it rebuilds everything, and with no seed pinned the map
         * that comes back is a new one. */
        global.location.reload();
      });
    }
  }

  function wire() {
    // opening a panel must not also start the game
    [['btn-options', 'options'], ['btn-match', 'match'], ['btn-debug', 'debug']].forEach(function (pair) {
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
    ['close-options', 'close-match', 'close-debug'].forEach(function (id) {
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
    bindSelect('opt-mode', 'mode');
    bindToggle('dbg-hitboxes', 'hitboxes');
    bindToggle('dbg-colliders', 'colliders');
    wireMatch();
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
    set('opt-mode', all.mode);
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
