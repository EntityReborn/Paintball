/* Page wiring: builds the game, connects it to the HUD, and drives the
 * pointer lock. The engine itself knows nothing about the DOM outside its
 * own canvas — everything here listens to game events. */
(function () {
'use strict';

var fatal = document.getElementById('fatal');

function die(msg) {
  document.getElementById('fatal-msg').textContent = msg;
  fatal.hidden = false;
  document.getElementById('menu').style.display = 'none';
}

if (!window.THREE)      return die('vendor/three.min.js did not load. Keep the vendor folder next to index.html.');
if (!window.createGame) return die('src/game.js did not load. Keep the src folder next to index.html.');

/* Online play is opt-in: index.html?mp joins the server this page came from.
 * Offline still boots instantly with its own random map, so the double-click
 * path keeps working with no server at all. */
var params = new URLSearchParams(location.search);
var wantsNet = params.has('mp');
var netUrl = params.get('server') ||
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

var game = null;
var net = null;
window.PB = window.PB || {};

function build(seed) {
  try {
    return window.createGame(seed === undefined ? { audio: true } : { audio: true, seed: seed });
  } catch (err) {
    die('WebGL failed to initialise: ' + err.message);
    return null;
  }
}

var el = {
  score: document.getElementById('s-score'),
  level: document.getElementById('s-level'),
  npcs: document.getElementById('s-npcs'),
  left: document.getElementById('s-left'),
  mag: document.getElementById('s-mag'),
  ammo: document.getElementById('ammo'),
  reloading: document.getElementById('reloading'),
  hit: document.getElementById('hitmarker'),
  toast: document.getElementById('toast'),
  menu: document.getElementById('menu'),
  menuScore: document.getElementById('m-score'),
  crosshair: document.getElementById('crosshair'),
};

function refresh() {
  if (!game) return;
  el.score.textContent = game.state.score;
  el.level.textContent = game.state.level;
  el.npcs.textContent = game.npcsAlive();
  el.left.textContent = game.aliveCount();
  el.mag.textContent = game.state.mag;
  el.ammo.classList.toggle('empty', game.state.mag === 0);
}

// flash the score readout green on a gain, red on a penalty
var scoreFlash = null;
function flashScore(delta) {
  if (!delta) return;
  el.score.classList.remove('up', 'down');
  void el.score.offsetWidth;                       // restart the animation
  el.score.classList.add(delta > 0 ? 'up' : 'down');
  clearTimeout(scoreFlash);
  scoreFlash = setTimeout(function () {
    el.score.classList.remove('up', 'down');
  }, 420);
}

var toastTimer = null;
function toast(text) {
  el.toast.textContent = text;
  el.toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.toast.style.opacity = 0; }, 1400);
}

function wire() {
game.on('score', function (d) { refresh(); flashScore(d.delta); });
game.on('ammo', refresh);
game.on('hit', function () {
  refresh();
  el.hit.style.transition = 'none';
  el.hit.style.opacity = 1;
  requestAnimationFrame(function () {
    el.hit.style.transition = 'opacity .28s';
    el.hit.style.opacity = 0;
  });
});
game.on('miss', refresh);
game.on('npcDown', refresh);
game.on('level', function (d) {
  refresh();
  if (d.level > 1) toast('LEVEL ' + d.level);
});
game.on('levelComplete', function (d) {
  toast('LEVEL ' + d.level + ' COMPLETE  +' + game.cfg.scoreLevelBonus);
});
game.on('zoom', function (d) {
  el.crosshair.classList.toggle('sighted', d.sighted);
});
game.on('reloadStart', function () { el.reloading.textContent = 'RELOADING'; });
game.on('reloadEnd', function () { el.reloading.textContent = ''; refresh(); });

/* ------------------------------------------------------------ pointer lock */
var canvas = game.domElement;

el.menu.addEventListener('click', function () {
  // unadjustedMovement asks for raw deltas: no OS pointer acceleration, which
  // is what turns a quick flick into a jump. Chrome returns a promise here and
  // rejects if it cannot honour it, so fall back to a plain lock.
  var res;
  try {
    res = canvas.requestPointerLock({ unadjustedMovement: true });
  } catch (err) {
    canvas.requestPointerLock();
    return;
  }
  if (res && typeof res.catch === 'function') {
    res.catch(function () { canvas.requestPointerLock(); });
  }
});

document.addEventListener('pointerlockchange', function () {
  var locked = document.pointerLockElement === canvas;
  game.setActive(locked);
  el.menu.classList.toggle('hidden', locked);
  if (!locked) {
    el.crosshair.classList.remove('sighted');
    if (game.state.score > 0) {
      el.menuScore.textContent = 'SCORE ' + game.state.score + '  ·  LEVEL ' + game.state.level;
    }
  }
});

game.bindInput(window);
refresh();
game.start();
}

/* ------------------------------------------------------------- boot */
if (!wantsNet) {
  game = build();
  if (game) { window.game = game; wire(); }
} else {
  // wait for the server's map seed so every client builds the same arena
  net = window.PB.createNet({ url: netUrl, name: params.get('name') || 'player' });
  window.net = net;
  el.menuScore.textContent = 'CONNECTING…';

  net.on('hello', function (msg) {
    game = build(msg.seed);
    if (!game) return;
    window.game = game;
    game.setNetworked(true);
    wire();
    net.attach(game);
    game.on('frame', function (dt) { net.update(dt); });
    el.menuScore.textContent = 'ONLINE  ·  MAP ' + msg.seed;
    setInterval(function () { net.ping(); }, 2000);
  });

  net.on('error', function () {
    die('could not reach the game server at ' + netUrl);
  });
  net.on('disconnected', function () {
    el.menuScore.textContent = 'DISCONNECTED';
  });

  net.connect();
}

})();
