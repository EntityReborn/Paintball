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

  function load() {
    if (!store) return values;
    var raw = null;
    try { raw = store.getItem(KEY); } catch (err) { return values; }
    if (!raw) return values;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    values = PB.cleanOptions(parsed);
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
    if (values[key] === cleaned) return false;
    values[key] = cleaned;
    save();
    for (var i = 0; i < listeners.length; i++) listeners[i](key, cleaned, all());
    return true;
  }

  function reset() {
    values = PB.defaultOptions();
    save();
    for (var i = 0; i < listeners.length; i++) listeners[i](null, null, all());
    return all();
  }

  load();

  return {
    key: KEY,
    load: load, save: save, reset: reset,
    get: get, set: set, all: all,
    onChange: function (cb) { listeners.push(cb); return cb; },
  };
};

})(typeof window !== 'undefined' ? window : globalThis);
