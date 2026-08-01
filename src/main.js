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
  summary: document.getElementById('summary'),
  perks: document.getElementById('perks'),
};

var PERK_COLOURS = {
  fireRate: '#ffb03a', speed: '#6ee7ff', clip: '#a78bfa', doubleJump: '#8ef2a0',
};

// what is running right now, and how much of it is left
function renderPerks() {
  if (!game || !el.perks) return;
  var held = game.state.perks || {};
  var rows = [];
  game.perkSystem.kinds.forEach(function (def) {
    var left = held[def.kind];
    if (!(left > 0)) return;
    rows.push('<div class="perk" style="color:' + (PERK_COLOURS[def.kind] || '#fff') + '">' +
              def.label + '<span class="time">' + left.toFixed(0) + 's</span></div>');
  });
  el.perks.innerHTML = rows.join('');
}

/* The career summary shown while paused. Distance is reported in feet because
 * that is what people ask for; everything internal stays in metres. */
function renderSummary() {
  if (!game) return;
  var s = game.stats();
  var pct = function (n) { return (n * 100).toFixed(1) + '%'; };
  var clock = function (sec) {
    var m = Math.floor(sec / 60), r = Math.round(sec % 60);
    return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  };
  var rows = [
    ['SCORE', s.score, ''],
    ['BEST SCORE', s.bestScore, ''],
    ['LEVELS CLEARED', s.levelsCleared, ''],
    ['ACCURACY', pct(s.accuracy), s.accuracy >= 0.5 ? 'good' : (s.shotsFired > 5 ? 'poor' : '')],
    ['SHOTS FIRED', s.shotsFired, ''],
    ['HITS / MISSES', s.shotsHit + ' / ' + s.misses, ''],
    ['TARGETS BROKEN', s.targetsBroken, ''],
    ['NPCS DOWN', s.npcsDown, ''],
    ['BEST STREAK', s.bestStreak, s.bestStreak >= 5 ? 'good' : ''],
    ['LONGEST SHOT', s.longestShotFeet.toFixed(0) + ' ft', ''],
    ['DISTANCE WALKED', s.distanceFeet.toFixed(0) + ' ft', ''],
    ['JUMPS', s.jumps, ''],
    ['RELOADS', s.reloads, ''],
    ['TIME PLAYED', clock(s.timePlayed), ''],
    ['TIME SIGHTED', pct(s.sightedShare), ''],
    ['POINTS PER SHOT', s.pointsPerShot.toFixed(1), ''],
  ];
  el.summary.innerHTML = rows.map(function (r) {
    return '<div class="row"><span class="lbl">' + r[0] + '</span>' +
           '<span class="val ' + r[2] + '">' + r[1] + '</span></div>';
  }).join('');
  el.summary.classList.add('on');
}

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
game.on('hit', function (d) {
  refresh();
  if (d && d.mine === false) return;      // somebody else's hit, not our marker
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
game.on('perk', function (d) {
  if (d.mine === false) return;
  toast(d.label || 'PERK');
  renderPerks();
});
game.on('perkExpired', renderPerks);
game.on('frame', renderPerks);
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
    if (game.state.score > 0 || game.stats().shotsFired > 0) {
      el.menuScore.textContent = 'SCORE ' + game.state.score + '  ·  LEVEL ' + game.state.level;
      renderSummary();
    }
  } else {
    el.summary.classList.remove('on');
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
    if (msg.level) game.applyLevel(msg.level);   // join into the level in progress

    /* The arena is generated from the seed on both sides. If the two ever
     * disagree, every shot lands somewhere different for the server than it
     * looks here — invisible cover, bullets stopping in mid-air. Better to
     * say so than to let it look like a physics bug. */
    if (msg.arena) {
      net.self.arenaMatch = (game.arenaFingerprint() === msg.arena);
      if (!net.self.arenaMatch) {
        console.error('[paintball] arena mismatch: server ' + msg.arena +
                      ', client ' + game.arenaFingerprint() +
                      ' — shots will not line up with what you see');
        toast('ARENA MISMATCH');
      }
    }
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
