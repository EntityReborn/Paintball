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

/* Settings come from local storage, with the URL still able to override the
 * name so a link can carry one. */
var options = window.PB.createOptions();
window.options = options;
if (params.get('name')) options.set('name', params.get('name'));

/* Totals that outlive the tab. The game keeps the session's own figures and
 * knows nothing about this; folding happens here, on a slow timer and at every
 * moment the page might be about to go away. */
var career = window.PB.createCareer();
window.career = career;

var ui = null;

function build(seed) {
  var settings = {
    audio: true,
    sensitivity: options.get('sensitivity'),
    invertY: options.get('invertY'),
  };
  if (seed !== undefined) settings.seed = seed;
  // ?hunters=0 takes the red enemy out, for scripted runs that need an arena
  // where nothing shoots back
  if (params.has('hunters')) {
    var wanted = Number(params.get('hunters'));
    if (isFinite(wanted)) settings.hunters = Math.max(0, Math.min(4, wanted | 0));
  }
  try {
    return window.createGame(settings);
  } catch (err) {
    die('WebGL failed to initialise: ' + err.message);
    return null;
  }
}

var el = {
  hud: document.getElementById('hud'),
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
  health: document.getElementById('health'),
  healthFill: document.getElementById('health-fill'),
  healthText: document.getElementById('health-text'),
  damage: document.getElementById('damage'),
  shield: document.getElementById('shield'),
  shieldTime: document.getElementById('shield-time'),
  dead: document.getElementById('dead'),
  deadBy: document.getElementById('dead-by'),
  deadCount: document.getElementById('dead-count'),
};

// own health: only worth showing once there is damage to worry about
function renderHealth(d) {
  if (!el.health) return;
  var max = d.max || 10;
  var f = max > 0 ? d.health / max : 1;
  el.health.classList.add('on');
  el.health.classList.toggle('hurt', f <= 0.6 && f > 0.3);
  el.health.classList.toggle('critical', f <= 0.3);
  el.healthFill.style.width = 'calc(' + (f * 100) + '% - 4px)';
  el.healthText.textContent = d.health + ' / ' + max;
}

var damageTimer = null;
function flashDamage() {
  if (!el.damage) return;
  el.damage.classList.add('on');
  clearTimeout(damageTimer);
  damageTimer = setTimeout(function () { el.damage.classList.remove('on'); }, 90);
}

/* How long we cannot be hurt for, counted down in the corner. Covers both the
 * moment after a respawn and the shield perk — from the player's side they are
 * the same thing, so they read the same way. */
function renderShield() {
  if (!el.shield || !game) return;
  var left = Math.max(game.state.shield || 0,
                      (game.state.perks && game.state.perks.shield) || 0);
  el.shield.classList.toggle('on', left > 0);
  if (left > 0) el.shieldTime.textContent = left.toFixed(1) + 's';
}

/* The screen you get when somebody puts you down: who did it, and how long
 * until you are back. Without this a death is just the world going still. */
var deadUntil = 0;
var killedBy = '';

function showDeath(by) {
  if (!el.dead || !game) return;
  killedBy = by || '';
  deadUntil = performance.now() + game.cfg.respawnDelay * 1000;
  el.deadBy.textContent = killedBy ? 'BY ' + killedBy.toUpperCase() : '';
  el.dead.hidden = false;
  if (el.hud) el.hud.classList.add('dead');
}

function hideDeath() {
  if (!el.dead) return;
  el.dead.hidden = true;
  if (el.hud) el.hud.classList.remove('dead');
  deadUntil = 0;
}

function renderDeath() {
  if (!el.dead || el.dead.hidden) return;
  var left = Math.max(0, (deadUntil - performance.now()) / 1000);
  el.deadCount.textContent = left.toFixed(1) + 's';
}

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

/* Fold the session into the career. Called on a slow timer and at every point
 * the page might be about to disappear — folding works on the difference since
 * last time, so calling it often costs nothing and calling it late loses
 * whatever happened after the last one. */
function saveCareer() {
  if (!game) return null;
  return career.fold(game.stats());
}

/* The summary shown while paused, in two columns: this session, and every
 * session before it. Distance is reported in feet because that is what people
 * ask for; everything internal stays in metres. */
function renderSummary() {
  if (!game) return;
  saveCareer();
  var s = game.stats();
  var life = career.all();
  var pct = function (n) { return (n * 100).toFixed(1) + '%'; };
  var feet = function (units) { return (units * game.FEET_PER_UNIT).toFixed(0) + ' ft'; };
  var clock = function (sec) {
    var m = Math.floor(sec / 60), r = Math.round(sec % 60);
    if (m >= 60) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  };
  var rows = [
    ['SCORE', s.score, life.bestScore + ' best', ''],
    ['LEVELS CLEARED', s.levelsCleared, life.levelsCleared, ''],
    ['ACCURACY', pct(s.accuracy), pct(life.accuracy),
     s.accuracy >= 0.5 ? 'good' : (s.shotsFired > 5 ? 'poor' : '')],
    ['SHOTS FIRED', s.shotsFired, life.shotsFired, ''],
    ['HITS / MISSES', s.shotsHit + ' / ' + s.misses, life.shotsHit + ' / ' + life.misses, ''],
    ['TARGETS BROKEN', s.targetsBroken, life.targetsBroken, ''],
    ['NPCS DOWN', s.npcsDown, life.npcsDown, ''],
    ['KILLS / DEATHS', s.kills + ' / ' + s.deaths, life.kills + ' / ' + life.deaths, ''],
    ['BEST STREAK', s.bestStreak, life.bestStreak, s.bestStreak >= 5 ? 'good' : ''],
    ['LONGEST SHOT', s.longestShotFeet.toFixed(0) + ' ft', feet(life.longestShot), ''],
    ['DISTANCE WALKED', s.distanceFeet.toFixed(0) + ' ft', feet(life.distance), ''],
    ['JUMPS', s.jumps, life.jumps, ''],
    ['RELOADS', s.reloads, life.reloads, ''],
    ['TIME PLAYED', clock(s.timePlayed), clock(life.timePlayed), ''],
    ['TIME SIGHTED', pct(s.sightedShare), '', ''],
    ['POINTS PER SHOT', s.pointsPerShot.toFixed(1), '', ''],
  ];
  var head = '<div class="row head"><span class="lbl">&nbsp;</span>' +
             '<span class="val">SESSION</span>' +
             '<span class="val life">LIFETIME</span></div>';
  el.summary.innerHTML = head + rows.map(function (r) {
    return '<div class="row"><span class="lbl">' + r[0] + '</span>' +
           '<span class="val ' + r[3] + '">' + r[1] + '</span>' +
           '<span class="val life">' + r[2] + '</span></div>';
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
game.on('health', renderHealth);
game.on('hurt', flashDamage);
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
game.on('frame', function () { renderPerks(); renderShield(); renderDeath(); });
game.on('medkit', function (d) { if (d.mine) toast('HEALTH RESTORED'); });
game.on('shield', function () { toast('SHIELDED'); });
/* Learning it from our own health alone means no killer's name, which happens
 * if the hit message is lost; better a plain notice than none. */
game.on('health', function (d) {
  if (d.dead) { if (el.dead.hidden) showDeath(killedBy); }
  else hideDeath();
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
    if (game.state.score > 0 || game.stats().shotsFired > 0) {
      el.menuScore.textContent = 'SCORE ' + game.state.score + '  ·  LEVEL ' + game.state.level;
      renderSummary();
    } else {
      saveCareer();
    }
  } else {
    el.summary.classList.remove('on');
  }
});

// and on the way out, however that happens
setInterval(saveCareer, 15000);
window.addEventListener('pagehide', saveCareer);
document.addEventListener('visibilitychange', function () {
  if (document.hidden) saveCareer();
});

game.bindInput(window);
refresh();
game.start();
}

window.addEventListener('keydown', function (e) {
  if (e.code === 'Escape' && ui && ui.isOpen()) {
    ui.close();
    e.stopPropagation();
  }
}, true);

ui = window.PB.createUI({
  options: options,
  getGame: function () { return game; },
  getNet: function () { return net; },
});

/* ------------------------------------------------- who are you, then */
/* A name goes over your head for everyone else in the room, so somebody who
 * has never chosen one is asked before they join rather than being called
 * "player" by default. Offline nobody sees it, so nobody is stopped. */
var ask = {
  root: document.getElementById('ask-name'),
  form: document.getElementById('ask-name-form'),
  input: document.getElementById('ask-name-input'),
  err: document.getElementById('ask-name-err'),
};

function askForName(then) {
  if (!ask.root) return then();
  ask.root.hidden = false;
  ask.input.value = '';
  setTimeout(function () { ask.input.focus(); }, 0);
  ask.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var typed = ask.input.value;
    // run it through the same cleaner the option uses, and refuse whatever is
    // left of a name made entirely of characters we do not keep
    var kept = window.PB.cleanOption('name', typed);
    if (!typed.trim() || kept === 'player') {
      ask.err.textContent = typed.trim()
        ? 'letters, numbers, spaces, _ and - only'
        : 'pick something';
      return;
    }
    options.set('name', kept);
    ask.root.hidden = true;
    then();
  });
}

/* ------------------------------------------------------------- boot */
function boot() {
if (!wantsNet) {
  game = build();
  if (game) { window.game = game; wire(); ui.applyAll(); }
} else {
  // wait for the server's map seed so every client builds the same arena
  net = window.PB.createNet({
    url: netUrl, name: options.get('name'), pvp: options.get('pvp'),
  });
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
    ui.applyAll();
    el.menuScore.textContent = 'ONLINE  ·  MAP ' + msg.seed;
    setInterval(function () { net.ping(); }, 2000);
  });

  net.on('error', function () {
    die('could not reach the game server at ' + netUrl);
  });
  net.on('respawn', function (msg) {
    if (net.self && msg.id === net.self.id) { hideDeath(); toast('RESPAWNED'); }
  });

  /* The server tells the whole room about every hit; this is the one that
   * matters to us. Being killed with no idea by whom is the worst version of
   * it, so the name comes off the same message. */
  net.on('hit', function (msg) {
    if (msg.kind !== 'player' || !net.self) return;
    if (msg.victim === net.self.id && msg.killed) showDeath(msg.killerName);
    if (msg.by === net.self.id && msg.killed) {
      toast('KILLED ' + (msg.victimName || '') + '  +' + game.cfg.scoreKill);
    }
  });

  net.on('disconnected', function () {
    el.menuScore.textContent = 'DISCONNECTED';
  });

  net.connect();
}
}

if (wantsNet && !options.has('name')) askForName(boot);
else boot();

})();
