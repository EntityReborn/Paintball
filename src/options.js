/* Player settings, kept in local storage.
 *
 * Everything here is validated on the way in: storage is editable by hand and
 * survives across versions, so a bad value must never be able to leave the
 * game unplayable — a sensitivity of zero or a NaN volume would do exactly
 * that. Anything unrecognised is dropped, anything out of range is clamped.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

var KEY = 'paintball.options';

PB.OPTION_SPEC = {
  name: { type: 'string', def: 'player', max: 16 },
  sensitivity: { type: 'number', def: 1.0, min: 0.1, max: 5 },
  masterVolume: { type: 'number', def: 0.8, min: 0, max: 1 },
  gunVolume: { type: 'number', def: 0.8, min: 0, max: 1 },
  invertY: { type: 'boolean', def: false },
  showNames: { type: 'boolean', def: true },
  pvp: { type: 'boolean', def: true },
  hitboxes: { type: 'boolean', def: false },
  colliders: { type: 'boolean', def: false },
};

PB.defaultOptions = function () {
  var out = {};
  for (var k in PB.OPTION_SPEC) {
    if (Object.prototype.hasOwnProperty.call(PB.OPTION_SPEC, k)) {
      out[k] = PB.OPTION_SPEC[k].def;
    }
  }
  return out;
};

// Force a single value into range, or return the default if it is unusable.
PB.cleanOption = function (key, value) {
  var spec = PB.OPTION_SPEC[key];
  if (!spec) return undefined;

  if (spec.type === 'number') {
    var n = typeof value === 'string' ? parseFloat(value) : value;
    if (typeof n !== 'number' || !isFinite(n)) return spec.def;
    return Math.min(spec.max, Math.max(spec.min, n));
  }
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return spec.def;
  }
  /* string: keep it to plain, printable characters.
   *
   * The range this used to strip covered control characters only, so markup
   * and punctuation went straight through into a name. Allow-list instead:
   * letters, digits, spaces, underscore and hyphen, and nothing else. */
  if (typeof value !== 'string') return spec.def;
  var s = value.replace(/[^A-Za-z0-9 _-]/g, '');
  s = s.replace(/[ ]+/g, ' ').trim().slice(0, spec.max);
  return s.length ? s : spec.def;
};

PB.cleanOptions = function (raw) {
  var out = PB.defaultOptions();
  if (!raw || typeof raw !== 'object') return out;
  for (var k in PB.OPTION_SPEC) {
    if (!Object.prototype.hasOwnProperty.call(PB.OPTION_SPEC, k)) continue;
    if (Object.prototype.hasOwnProperty.call(raw, k)) {
      out[k] = PB.cleanOption(k, raw[k]);
    }
  }
  return out;
};

PB.createOptions = function (storage) {
  var store = storage;
  if (store === undefined) {
    try { store = global.localStorage; } catch (err) { store = null; }
  }

  var values = PB.defaultOptions();
  var listeners = [];
  /* Which keys the player has actually chosen, as opposed to which ones have
   * a default. A name nobody has picked is not the same as a name of
   * "player" — the first has to be asked for, the second was asked for. */
  var chosen = {};

  function load() {
    if (!store) return values;
    var raw = null;
    try { raw = store.getItem(KEY); } catch (err) { return values; }
    if (!raw) return values;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    values = PB.cleanOptions(parsed);
    chosen = {};
    if (parsed && typeof parsed === 'object') {
      for (var k in PB.OPTION_SPEC) {
        if (Object.prototype.hasOwnProperty.call(parsed, k)) chosen[k] = true;
      }
    }
    return values;
  }

  function save() {
    if (!store) return false;
    try { store.setItem(KEY, JSON.stringify(values)); return true; }
    catch (err) { return false; }        // private mode, quota, whatever
  }

  function get(key) { return values[key]; }
  function all() {
    var copy = {};
    for (var k in values) {
      if (Object.prototype.hasOwnProperty.call(values, k)) copy[k] = values[k];
    }
    return copy;
  }

  function set(key, value) {
    if (!PB.OPTION_SPEC[key]) return false;
    var cleaned = PB.cleanOption(key, value);
    var first = !chosen[key];
    chosen[key] = true;
    if (values[key] === cleaned && !first) return false;
    values[key] = cleaned;
    save();
    for (var i = 0; i < listeners.length; i++) listeners[i](key, cleaned, all());
    return true;
  }

  function reset() {
    values = PB.defaultOptions();
    chosen = {};
    save();
    for (var i = 0; i < listeners.length; i++) listeners[i](null, null, all());
    return all();
  }

  load();

  return {
    key: KEY,
    load: load, save: save, reset: reset,
    get: get, set: set, all: all,
    // has this been chosen, or is it just sitting on its default?
    has: function (key) { return !!chosen[key]; },
    onChange: function (cb) { listeners.push(cb); return cb; },
  };
};

/* ------------------------------------------------------------- career */
/* Totals that outlive the tab. The game keeps a session's figures in memory
 * and knows nothing about this; whoever owns the page folds the session into
 * the career from time to time and on the way out.
 *
 * Sums accumulate, bests take the higher of the two. Folding works on the
 * difference since the last fold, so calling it twice does not double-count.
 */
PB.CAREER_SUMS = [
  'shotsFired', 'shotsHit', 'misses', 'targetsBroken', 'npcsDown',
  'kills', 'deaths', 'distance', 'jumps', 'reloads', 'levelsCleared',
  'timePlayed', 'timeSighted',
];
PB.CAREER_BESTS = ['bestScore', 'bestStreak', 'longestShot'];

PB.createCareer = function (storage) {
  var KEY2 = 'paintball.career';
  var store = storage;
  if (store === undefined) {
    try { store = global.localStorage; } catch (err) { store = null; }
  }

  function blank() {
    var out = { sessions: 0 };
    PB.CAREER_SUMS.concat(PB.CAREER_BESTS).forEach(function (k) { out[k] = 0; });
    return out;
  }

  function clean(raw) {
    var out = blank();
    if (!raw || typeof raw !== 'object') return out;
    for (var k in out) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
      var n = typeof raw[k] === 'number' ? raw[k] : parseFloat(raw[k]);
      // storage is editable by hand: anything unusable falls back to nothing
      out[k] = isFinite(n) && n >= 0 ? n : 0;
    }
    return out;
  }

  var totals = blank();
  var mark = null;                 // session figures as of the last fold

  function load() {
    if (!store) return totals;
    var raw = null;
    try { raw = store.getItem(KEY2); } catch (err) { return totals; }
    if (!raw) return totals;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    totals = clean(parsed);
    return totals;
  }

  function save() {
    if (!store) return false;
    try { store.setItem(KEY2, JSON.stringify(totals)); return true; }
    catch (err) { return false; }
  }

  /* Take everything that has happened since the last call and add it on. */
  function fold(session) {
    if (!session) return totals;
    if (!mark) {
      mark = {};
      totals.sessions++;
    }
    PB.CAREER_SUMS.forEach(function (k) {
      var now = typeof session[k] === 'number' ? session[k] : 0;
      var since = now - (mark[k] || 0);
      if (since > 0) totals[k] += since;
      mark[k] = now;
    });
    PB.CAREER_BESTS.forEach(function (k) {
      var now = typeof session[k] === 'number' ? session[k] : 0;
      if (now > totals[k]) totals[k] = now;
    });
    save();
    return totals;
  }

  function clear() {
    totals = blank();
    mark = null;
    save();
    return totals;
  }

  load();

  return {
    key: KEY2,
    load: load, save: save, fold: fold, clear: clear,
    all: function () {
      var copy = {};
      for (var k in totals) {
        if (Object.prototype.hasOwnProperty.call(totals, k)) copy[k] = totals[k];
      }
      copy.accuracy = totals.shotsFired ? totals.shotsHit / totals.shotsFired : 0;
      return copy;
    },
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
