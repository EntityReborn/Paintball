/* Synthesised sound effects. No assets, just oscillators.
 *
 * Part of the Paintball engine. Classic script, no modules: the game has to
 * run straight off the filesystem, where Chrome refuses to load ES modules.
 * Every builder takes the shared context created by createGame and returns
 * the handful of things the rest of the engine needs.
 */
(function (global) {
'use strict';

var PB = global.PB = global.PB || {};

PB.createAudio = function (ctx) {
  var cfg = ctx.cfg;

  /* -------------------------------------------------------------- audio */
  var actx = null;
  var masterGain = null;
  var gunGain = null;
  var levels = { master: 0.8, gun: 0.8 };

  /* Everything runs through a master gain, with gunfire on its own bus. Setting
   * the volume on each sound as it is made would leave anything already
   * playing at the old level and gives no way to mute. */
  function audioCtx() {
    if (!cfg.audio) return null;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    if (!actx) {
      actx = new AC();
      masterGain = actx.createGain();
      masterGain.gain.value = levels.master;
      masterGain.connect(actx.destination);
      gunGain = actx.createGain();
      gunGain.gain.value = levels.gun;
      gunGain.connect(masterGain);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function busFor(name) {
    audioCtx();
    if (!actx) return null;
    return name === 'gun' ? gunGain : masterGain;
  }
  function blip(freq, type, dur, gain, sweep, bus) {
    var a = audioCtx(); if (!a) return;
    var out = busFor(bus); if (!out) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(out);
    o.start(); o.stop(a.currentTime + dur + 0.02);
  }
  function noiseBurst(dur, gain, bus) {
    var a = audioCtx(); if (!a) return;
    var out = busFor(bus); if (!out) return;
    var buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    var src = a.createBufferSource(); src.buffer = buf;
    var g = a.createGain(); g.gain.value = gain;
    var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2200;
    src.connect(f).connect(g).connect(out);
    src.start();
  }
  var sfx = {
    shoot: function () {
      blip(340, 'square', 0.09, 0.10, 0.15, 'gun');
      noiseBurst(0.07, 0.16, 'gun');
    },

    /* Somebody else firing, heard from `dist` metres away. Distant shots lose
     * volume and the crack goes dull, which is enough to tell roughly where
     * they came from without a full spatial audio graph. */
    shootAt: function (dist) {
      var d = Math.max(0, dist || 0);
      var fall = Math.max(0, 1 - d / 55);
      var vol = fall * fall;
      if (vol < 0.02) return;
      blip(340 - Math.min(120, d * 2.2), 'square', 0.09, 0.10 * vol, 0.15, 'gun');
      noiseBurst(0.07 + Math.min(0.06, d / 400), 0.16 * vol, 'gun');
    },
    hit: function () { blip(880, 'triangle', 0.22, 0.13, 0.25); noiseBurst(0.18, 0.12); },
    empty: function () { blip(130, 'square', 0.05, 0.07, 0.8); },
    miss: function () { blip(150, 'sine', 0.11, 0.05, 0.6); },
    reload: function () {
      blip(180, 'sawtooth', 0.08, 0.07, 0.5);
      setTimeout(function () { blip(260, 'sawtooth', 0.08, 0.07, 0.5); }, 380);
    },
    wave: function () {
      [523, 659, 784].forEach(function (f, i) {
        setTimeout(function () { blip(f, 'triangle', 0.2, 0.10, 0.9); }, i * 110);
      });
    },
  };

  sfx.setVolume = function (which, value) {
    var v = Math.min(1, Math.max(0, typeof value === 'number' ? value : 0));
    if (which === 'gun') {
      levels.gun = v;
      if (gunGain) gunGain.gain.value = v;
    } else {
      levels.master = v;
      if (masterGain) masterGain.gain.value = v;
    }
    return v;
  };
  sfx.getVolume = function (which) {
    return which === 'gun' ? levels.gun : levels.master;
  };

  return sfx;
};

})(typeof window !== 'undefined' ? window : globalThis);
