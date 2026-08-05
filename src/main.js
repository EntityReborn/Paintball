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
  /* ?shadows=0 for the same kind of run. A headless browser has no GPU and
   * rasterises in software, where the shadow pass is most of the frame; two of
   * them on one machine spend so long drawing that the socket goes unread
   * between frames, and a test of the networking ends up measuring that. */
  if (params.get('shadows') === '0') settings.shadows = false;
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
  hurtMarks: document.getElementById('hurt-marks'),
  shield: document.getElementById('shield'),
  shieldTime: document.getElementById('shield-time'),
  dead: document.getElementById('dead'),
  deadBy: document.getElementById('dead-by'),
  deadCount: document.getElementById('dead-count'),
  board: document.getElementById('board'),
  boardRows: document.getElementById('board-rows'),
  chat: document.getElementById('chat'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
};

/* ------------------------------------------------------------------ chat */
/* The log carries two kinds of line: what somebody said, and what the room
 * did — who arrived, who left, who killed whom. Both are stamped with the
 * reader's own local time, so everyone reads their own clock and nobody has
 * to work out what the server's clock means.
 *
 * Lines fade out on their own so the corner is not permanently occupied, and
 * come back in full the moment the input is opened. */
var CHAT_KEEP = 40;
var CHAT_FADE_MS = 12000;
var chatOpen = false;

function clockOf(at) {
  var d = at ? new Date(at) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* Built out of nodes with textContent rather than markup: nothing anybody
 * types can ever be anything but text, whatever the server let through. */
function chatLine(opts) {
  if (!el.chatLog) return null;
  var line = document.createElement('div');
  line.className = 'line' + (opts.kind ? ' ' + opts.kind : '');

  var at = document.createElement('span');
  at.className = 'at';
  at.textContent = '[' + clockOf(opts.at) + ']';
  line.appendChild(at);

  if (opts.from) {
    var who = document.createElement('span');
    who.className = 'from';
    who.textContent = opts.from + ':';
    line.appendChild(who);
    line.appendChild(document.createTextNode(' '));
  }

  var said = document.createElement('span');
  said.className = 'said';
  said.textContent = opts.text;
  line.appendChild(said);

  el.chatLog.appendChild(line);
  while (el.chatLog.children.length > CHAT_KEEP) {
    el.chatLog.removeChild(el.chatLog.firstChild);
  }
  setTimeout(function () { line.classList.add('faded'); }, CHAT_FADE_MS);
  return line;
}

function chatNote(text, kind) {
  return chatLine({ text: text, kind: kind || 'note' });
}

function openChat() {
  if (chatOpen || !el.chatForm) return;
  chatOpen = true;
  el.chat.classList.add('open');
  el.chatForm.hidden = false;
  el.chatInput.value = '';
  /* Hands off the game while typing. Unbinding is the whole of it rather than
   * pausing: a key that still reaches the game is a player who walks into a
   * wall and reloads while writing "reloading". Anything held at the moment
   * the input opens is let go of too, or they keep walking. */
  if (game) {
    game.unbindInput(window);
    Object.keys(game.keys).forEach(function (k) { game.keys[k] = false; });
    game.setFiring(false);
    game.setZooming(false);
  }
  el.chatInput.focus();
}

function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  el.chat.classList.remove('open');
  el.chatForm.hidden = true;
  el.chatInput.value = '';
  el.chatInput.blur();
  if (game) game.bindInput(window);
}

function sendChat() {
  var text = el.chatInput.value.trim();
  closeChat();
  if (!text) return false;
  if (net && net.self && net.self.id) return net.say(text);
  // offline the log is a record of what happened, not a conversation
  chatNote('OFFLINE — THERE IS NOBODY TO TALK TO');
  return false;
}

if (el.chatForm) {
  el.chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    sendChat();
  });
  // clicking about must not leave the game unable to hear the keyboard
  el.chatInput.addEventListener('blur', function () {
    if (chatOpen) closeChat();
  });
}

/* ------------------------------------------------------------ scoreboard */
/* Held on TAB. Online the rows are the server's, sorted its way so everybody
 * is looking at the same table; offline there is only ever one of us, and it
 * is built here from what the session already knows. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* Our own frame rate, counted over the last second and sent to the room once
 * a second. Everybody's is on the scoreboard, because on a game decided by
 * who saw whom first it is worth knowing who is drawing at fifteen frames and
 * who is at a hundred and forty. It is each machine's word for itself: the
 * server cannot measure somebody else's, and nothing depends on the number. */
var myFps = 0;
var framesSince = 0;
var fpsCountedAt = 0;

function countFrame() {
  framesSince++;
  var now = performance.now();
  if (!fpsCountedAt) { fpsCountedAt = now; return; }
  var span = now - fpsCountedAt;
  if (span < 1000) return;
  myFps = Math.round((framesSince * 1000) / span);
  framesSince = 0;
  fpsCountedAt = now;
  if (net && net.self && net.self.connected) net.sendFps(myFps);
  renderBoard();
}

function boardRows() {
  if (net && net.self && net.self.id) {
    return net.scores().map(function (row) {
      var mine = row[0] === net.self.id;
      return {
        id: row[0], name: row[1], score: row[2], kills: row[3], deaths: row[4],
        down: !!row[5], away: !!row[6], you: mine,
        // ours are the ones we measured a moment ago rather than the ones that
        // went out a second ago and came back
        fps: mine ? myFps : (row[7] || 0),
        /* Ours is the one measured a moment ago; theirs came back through the
         * server. Nothing measured yet reads as nothing rather than as zero,
         * which is a real and very fast answer on a local server. */
        ping: mine ? (net.latency() || 0) : (row[8] === undefined ? null : row[8]),
      };
    });
  }
  if (!game) return [];
  var s = game.stats();
  return [{
    id: 0, name: options.get('name') || 'you', score: game.state.score,
    kills: s.kills, deaths: s.deaths, down: game.state.dead, you: true,
    fps: myFps, ping: null,       // nothing to be a round trip to
  }];
}

function renderBoard() {
  if (!el.board || el.board.hidden) return;
  var rows = boardRows();
  var html = rows.map(function (r) {
    var mark = r.away ? 'AWAY' : (r.down ? 'DOWN' : '');
    return '<div class="row' + (r.you ? ' you' : '') +
      (r.down || r.away ? ' down' : '') + '">' +
      '<span class="who">' + escapeHtml(r.name) +
        (mark ? '<span class="waiting">' + mark + '</span>' : '') + '</span>' +
      '<span class="n">' + r.score + '</span>' +
      '<span class="n">' + r.kills + '</span>' +
      '<span class="n">' + r.deaths + '</span>' +
      '<span class="n' + (r.fps && r.fps < 30 ? ' poor' : '') + '">' +
        (r.fps ? r.fps : '–') + '</span>' +
      /* A round trip of zero is a local server answering inside a
       * millisecond, not a missing measurement — say which. */
      '<span class="n' + (r.ping > 120 ? ' poor' : '') + '">' +
        (r.ping === null ? '–' : (r.ping >= 1 ? Math.round(r.ping) + 'ms' : '<1ms')) +
        '</span>' +
      '</div>';
  }).join('');
  if (rows.length < 2) {
    html += '<div class="lonely">' +
      (net && net.self && net.self.id ? 'NOBODY ELSE IS HERE' : 'OFFLINE — PLAYING ALONE') +
      '</div>';
  }
  el.boardRows.innerHTML = html;
}

function showBoard(on) {
  if (!el.board || el.board.hidden === !on) return;
  el.board.hidden = !on;
  if (on) renderBoard();
}

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

/* Which way the round came from.
 *
 * The red flash says you are being shot; this says where to look, which is
 * the part that lets you do something about it. A wedge around the crosshair
 * at the bearing the engine worked out, fading over a second and a half.
 *
 * The bearing is fixed at the moment of the hit rather than followed round as
 * you turn: it marks where the shot came from, not where the shooter is now,
 * and a marker that swings while you turn to face it is one you can never
 * quite line up on. */
var HURT_MARK_LIFE = 1.5;
var HURT_MARKS_MAX = 5;
var hurtMarks = [];

function markHurtFrom(d) {
  if (!el.hurtMarks || typeof d.bearing !== 'number') return null;
  var mark = document.createElement('div');
  mark.className = 'mark';
  mark.style.transform = 'rotate(' + d.bearing + 'rad)';
  mark.innerHTML = '<div class="wedge"></div>';
  el.hurtMarks.appendChild(mark);
  hurtMarks.push({ node: mark, life: HURT_MARK_LIFE });
  while (hurtMarks.length > HURT_MARKS_MAX) {
    var old = hurtMarks.shift();
    if (old.node.parentNode) old.node.parentNode.removeChild(old.node);
  }
  return mark;
}

// on the frame clock, so it fades at the same rate the game runs at
function fadeHurtMarks(dt) {
  if (!hurtMarks.length) return;
  dt = Math.min(0.1, dt || 1 / 60);
  for (var i = hurtMarks.length - 1; i >= 0; i--) {
    var m = hurtMarks[i];
    m.life -= dt;
    if (m.life <= 0) {
      if (m.node.parentNode) m.node.parentNode.removeChild(m.node);
      hurtMarks.splice(i, 1);
      continue;
    }
    m.node.style.opacity = Math.min(1, m.life / (HURT_MARK_LIFE * 0.6));
  }
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
game.on('score', function (d) { refresh(); flashScore(d.delta); renderBoard(); });
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
game.on('frame', function (dt) {
  countFrame();
  renderPerks();
  renderShield();
  renderDeath();
  fadeHurtMarks(dt);
});
game.on('hurtFrom', markHurtFrom);
game.on('medkit', function (d) { if (d.mine) toast('HEALTH RESTORED'); });
game.on('shield', function () { toast('SHIELDED'); });
/* Learning it from our own health alone means no killer's name, which happens
 * if the hit message is lost; better a plain notice than none. */
game.on('health', function (d) {
  if (d.dead) { if (el.dead.hidden) showDeath(killedBy); }
  else hideDeath();
  /* Offline there is no room to report it, and only one thing in the level
   * that can do it. Online the hit message carries both names and says so
   * properly, so this would be the same death written twice. */
  if (d.dead && !net) chatNote('THE HUNTER killed you', 'kill');
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
window.addEventListener('pagehide', function () {
  saveCareer();
  // closing the tab is leaving, not dropping: give the seat up rather than
  // have the room hold it open for somebody who is not coming back
  if (net) net.close();
});
document.addEventListener('visibilitychange', function () {
  if (document.hidden) saveCareer();
});

game.bindInput(window);
refresh();
game.start();
}

window.addEventListener('keydown', function (e) {
  // typing takes the keyboard: the form sends on ENTER, ESCAPE gives up on it
  if (chatOpen) {
    if (e.code === 'Escape') closeChat();
    if (e.code === 'Tab') e.preventDefault();
    return;
  }

  if (e.code === 'Escape' && ui && ui.isOpen()) {
    ui.close();
    e.stopPropagation();
  }
  /* Held, not toggled — the same as everywhere else this key does this job.
   * The default has to go either way: with the pointer unlocked TAB walks the
   * focus ring through the menu buttons behind the board. */
  if (e.code === 'Tab') {
    e.preventDefault();
    if (!e.repeat) showBoard(true);
  }
  if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) {
    e.preventDefault();
    openChat();
  }
}, true);

window.addEventListener('keyup', function (e) {
  if (e.code === 'Tab') { e.preventDefault(); showBoard(false); }
}, true);

// and if the window goes away with it held, it must not stick open
window.addEventListener('blur', function () { showBoard(false); });

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
    /* A hello arrives on every connection, including the ones that put us
     * back after a drop. The world is built from the first: building a second
     * one leaves a whole game — canvas, WebGL context, level and all — running
     * behind the one on screen. */
    if (game) return;
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
    // nobody broadcasts your own arrival to you, and an empty log on the way
    // in looks like a log that does not work
    chatNote('you joined as ' + ((msg.you && msg.you.name) || options.get('name')));
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
    // every death in the room goes in the log, whoever it belonged to
    if (msg.killed) {
      chatNote((msg.killerName || 'somebody') + ' killed ' +
               (msg.victimName || 'somebody'), 'kill');
    }
  });

  // the room's table, as often as it is sent
  net.on('scores', renderBoard);

  /* ------------------------------------------------- the room, out loud */
  net.on('chat', function (msg) {
    chatLine({
      at: msg.at, from: msg.name, text: msg.text,
      kind: msg.from === net.self.id ? 'mine' : '',
    });
  });
  net.on('chatRejected', function (msg) {
    chatNote(msg.reason === 'too much at once'
      ? 'SLOW DOWN — TOO MUCH AT ONCE'
      : 'THAT COULD NOT BE SAID');
  });
  net.on('joined', function (p) { chatNote(p.name + ' joined'); });
  net.on('left', function (msg) {
    chatNote((msg.name || net.names.get(msg.id) || 'somebody') + ' left');
  });
  /* Somebody used the controls. A restart is a new map, and this arena came
   * out of the old seed, so there is nothing to salvage: say who did it and
   * come back on the new one. */
  net.on('restart', function (msg) {
    chatNote((msg.name || 'somebody') + ' restarted the match — new map');
    el.menuScore.textContent = 'RESTARTING…';
    setTimeout(function () { location.reload(); }, 900);
  });
  net.on('added', function (msg) {
    chatNote((msg.name || 'somebody') + ' added ' + msg.made + ' ' + msg.what +
             (msg.made === 1 ? '' : 's'));
  });
  net.on('away', function (msg) {
    chatNote((msg.name || 'somebody') + ' lost connection');
  });
  net.on('back', function (p) { chatNote(p.name + ' came back'); });

  /* Our own connection going and coming. The game keeps running underneath —
   * you can still walk about, you are simply the only thing moving — so the
   * menu line is where this is said, and the log keeps the history of it. */
  net.on('disconnected', function () {
    el.menuScore.textContent = 'CONNECTION LOST';
    chatNote('CONNECTION LOST');
  });
  net.on('reconnecting', function (d) {
    el.menuScore.textContent = 'RECONNECTING… (' + d.attempt + '/' + d.of + ')';
  });
  net.on('resumed', function () {
    el.menuScore.textContent = 'ONLINE  ·  MAP ' + net.self.seed;
    chatNote('back in — your score was kept');
  });
  net.on('rejoined', function () {
    el.menuScore.textContent = 'ONLINE  ·  MAP ' + net.self.seed;
    chatNote('back in, as a new player — the seat had gone');
  });
  net.on('gaveUp', function (d) {
    el.menuScore.textContent = 'DISCONNECTED';
    chatNote('GAVE UP RECONNECTING AFTER ' + d.attempts + ' TRIES — RELOAD TO PLAY ON');
  });
  /* The room built a new world while we were away, which happens when the
   * last player leaves and the match ends. This arena came out of the old
   * seed and cannot be regenerated in place. */
  net.on('worldChanged', function () {
    chatNote('THE MATCH ENDED WHILE YOU WERE AWAY — RELOADING');
    setTimeout(function () { location.reload(); }, 1200);
  });


  net.connect();
}
}

if (wantsNet && !options.has('name')) askForName(boot);
else boot();

})();
