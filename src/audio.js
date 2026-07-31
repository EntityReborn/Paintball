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
  function audioCtx() {
    if (!cfg.audio) return null;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function blip(freq, type, dur, gain, sweep) {
    var a = audioCtx(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(a.destination);
    o.start(); o.stop(a.currentTime + dur + 0.02);
  }
  function noiseBurst(dur, gain) {
    var a = audioCtx(); if (!a) return;
    var buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    var src = a.createBufferSource(); src.buffer = buf;
    var g = a.createGain(); g.gain.value = gain;
    var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2200;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
  }
  var sfx = {
    shoot: function () { blip(340, 'square', 0.09, 0.10, 0.15); noiseBurst(0.07, 0.16); },
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

  return sfx;
};

})(typeof window !== 'undefined' ? window : globalThis);
