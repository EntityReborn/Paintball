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
      // whatever the last frame asked for, now that there is something to ask
      if (_pending) {
        var want = _pending;
        _pending = null;
        listenFrom(want.pos, want.forward, want.up);
      }
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function busFor(name) {
    audioCtx();
    if (!actx) return null;
    return name === 'gun' ? gunGain : masterGain;
  }

  /* ------------------------------------------------------------ in space */
  /* Where the ears are, and which way they are pointing.
   *
   * Fed from the camera every frame. Two ways of setting it because the two
   * ways exist: the AudioParam form is the current one and the setter form is
   * what older builds have, and a browser with neither simply gets sound with
   * no direction rather than an exception.
   */
  var _lastListen = 0;
  /* Where the ears were last told to be, kept even when there is nothing to
   * tell. The audio context is not built until the first sound plays, so
   * without this the first sound of a match is the one placed against a
   * listener sitting at the origin facing -Z — which is right exactly once,
   * before anybody has turned. */
  var _pending = null;

  function listenFrom(pos, forward, up) {
    var a = actx;
    if (!a || !a.listener) {
      _pending = {
        pos: { x: pos.x, y: pos.y, z: pos.z },
        forward: { x: forward.x, y: forward.y, z: forward.z },
        up: { x: up.x, y: up.y, z: up.z },
      };
      return false;
    }
    var L = a.listener;
    if (L.positionX) {
      var t = a.currentTime;
      L.positionX.setValueAtTime(pos.x, t);
      L.positionY.setValueAtTime(pos.y, t);
      L.positionZ.setValueAtTime(pos.z, t);
      L.forwardX.setValueAtTime(forward.x, t);
      L.forwardY.setValueAtTime(forward.y, t);
      L.forwardZ.setValueAtTime(forward.z, t);
      L.upX.setValueAtTime(up.x, t);
      L.upY.setValueAtTime(up.y, t);
      L.upZ.setValueAtTime(up.z, t);
    } else if (L.setPosition) {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    } else {
      return false;
    }
    _lastListen = a.currentTime;
    return true;
  }

  /* A panner for one sound, wired between it and its bus.
   *
   * `quality` is the whole cost question. HRTF is what makes a shot behind you
   * sound behind you rather than merely to one side, and it is expensive
   * enough that a level with three hundred figures walking about cannot afford
   * it for footsteps. So: shots get HRTF because knowing where one came from
   * is the point of hearing it, and footsteps get equalpower, which is a pan
   * and a falloff and costs nearly nothing.
   *
   * Linear falloff out to the same distance the old flat version used, so
   * nothing suddenly carries further than it used to.
   */
  var voices = 0;
  var MAX_VOICES = 24;         // a crowd firing at once is not worth hearing all of

  /* Footsteps get their own, much tighter budget on top of that.
   *
   * Measured: three hundred figures with a hundred and twenty inside earshot
   * put down two hundred and thirty feet a second. That is not a crowd you can
   * hear, it is a hiss — and it pegged the voice cap, so a gunshot arriving
   * mid-crowd had nothing left to be placed with. A dozen a second is plenty
   * to hear a crowd moving and leaves the cap for the sounds that matter.
   *
   * A token bucket rather than a counter reset every second, because a counter
   * spends its whole allowance in the first two frames and then goes quiet.
   */
  var STEPS_PER_SECOND = 12;
  var stepTokens = STEPS_PER_SECOND;
  var stepFilledAt = 0;

  function stepToken() {
    var a = actx;
    var now = a ? a.currentTime : 0;
    if (stepFilledAt) {
      stepTokens = Math.min(STEPS_PER_SECOND,
                            stepTokens + (now - stepFilledAt) * STEPS_PER_SECOND);
    }
    stepFilledAt = now;
    if (stepTokens < 1) return false;
    stepTokens -= 1;
    return true;
  }

  function panner(x, y, z, quality) {
    var a = actx;
    if (!a || !a.createPanner) return null;
    var p = a.createPanner();
    p.panningModel = quality || 'equalpower';
    p.distanceModel = 'linear';
    p.refDistance = 1;
    p.maxDistance = cfg.hearing || 55;
    p.rolloffFactor = 1;
    if (p.positionX) {
      var t = a.currentTime;
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
    return p;
  }

  /* Where a sound is coming from, or nothing for one that has no place —
   * your own gun, your own footsteps, the wave fanfare. `at` is {x,y,z}.
   *
   * Past the cap a placed sound is dropped, not centred. Falling back to the
   * bus was worse than silence: a footstep from forty metres away arrived
   * inside your own head at full volume, so saturating the cap turned a distant
   * crowd into a close one. If it cannot be put where it belongs it does not
   * belong.
   */
  function outputFor(bus, at, quality) {
    var out = busFor(bus);
    if (!out || !at) return out;
    if (voices >= MAX_VOICES) return null;
    var p = panner(at.x, at.y, at.z, quality);
    if (!p) return null;
    p.connect(out);
    return p;
  }

  function held(node, seconds) {
    if (!node || !node.disconnect || node === masterGain || node === gunGain) return;
    voices++;
    setTimeout(function () {
      voices--;
      try { node.disconnect(); } catch (err) { /* already gone */ }
    }, Math.ceil((seconds + 0.2) * 1000));
  }

  function blip(freq, type, dur, gain, sweep, bus, at, quality) {
    var a = audioCtx(); if (!a) return;
    var out = outputFor(bus, at, quality); if (!out) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(out);
    o.start(); o.stop(a.currentTime + dur + 0.02);
    held(out, dur);
  }
  /* Noise, made once per length rather than once per sound.
   *
   * Filling the buffer is a loop over every sample, which is nothing for the
   * odd gunshot and adds up for footsteps: a level with a crowd in it puts
   * down a hundred feet a second. The decay is baked into the buffer, so the
   * only thing that varies per sound is the gain — which is a node, not a
   * loop. Keyed to the millisecond, which is finer than anything asks for. */
  var noiseCache = {};

  function noiseFor(a, dur) {
    var key = Math.round(dur * 1000);
    var have = noiseCache[key];
    if (have && have.sampleRate === a.sampleRate) return have;
    var buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    noiseCache[key] = buf;
    return buf;
  }

  function noiseBurst(dur, gain, bus, at, quality, cutoff) {
    var a = audioCtx(); if (!a) return;
    var out = outputFor(bus, at, quality); if (!out) return;
    var src = a.createBufferSource(); src.buffer = noiseFor(a, dur);
    var g = a.createGain(); g.gain.value = gain;
    var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 2200;
    src.connect(f).connect(g).connect(out);
    src.start();
    held(out, dur);
  }
  var sfx = {
    shoot: function () {
      blip(340, 'square', 0.09, 0.10, 0.15, 'gun');
      noiseBurst(0.07, 0.16, 'gun');
    },

    /* Somebody else firing, from where they are standing.
     *
     * `at` is the muzzle. It used to be a distance and nothing else, which
     * meant a hunter behind you and one in front of you sounded identical and
     * the only thing a shot told you was that somebody had fired. Now the
     * panner places it, so turning towards it is a thing you can do.
     *
     * The distance shaping stays on top of the falloff rather than being
     * replaced by it: a panner makes a far shot quieter, and what makes it
     * sound far is that the crack has gone dull as well.
     */
    shootAt: function (at, dist) {
      var d = Math.max(0, typeof dist === 'number' ? dist : 0);
      var fall = Math.max(0, 1 - d / (cfg.hearing || 55));
      var vol = fall * fall;
      if (vol < 0.02) return;
      blip(340 - Math.min(120, d * 2.2), 'square', 0.09, 0.10 * vol, 0.15,
           'gun', at, 'HRTF');
      noiseBurst(0.07 + Math.min(0.06, d / 400), 0.16 * vol, 'gun', at, 'HRTF');
    },

    /* A footfall.
     *
     * Quiet on purpose, and quieter still for being a filtered thud rather
     * than anything with a pitch — it has to sit under gunfire without ever
     * becoming the thing you notice. Your own is centred, because it is you;
     * everybody else's is placed, because where they are is the only reason
     * to want to hear it at all.
     *
     * `at` omitted means your own. `heavy` is a hunter, which is worth being
     * able to tell apart from a wanderer without looking.
     */
    step: function (at, heavy) {
      if (at && !stepToken()) return false;
      var loud = at ? 0.035 : 0.020;
      if (heavy) loud *= 1.7;
      noiseBurst(heavy ? 0.075 : 0.055, loud, 'master', at, 'equalpower',
                 heavy ? 320 : 480);
      return true;
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

  /* Point the ears where the camera is looking. Called once a frame; cheap,
   * and skipped entirely before anything has ever made a sound, because the
   * audio context does not exist until then. */
  /* True when the pose was taken, whether it was applied to a live graph or
   * remembered for the one that does not exist yet. Whether it actually
   * reached an AudioListener is spatial().ready, which is a different
   * question and only interesting to a test. */
  sfx.listen = function (pos, forward, up) {
    listenFrom(pos, forward, up);
    return !!(actx || _pending);
  };

  // for tests, and for anything wondering whether placing sounds is working
  sfx.spatial = function () {
    return {
      ready: !!(actx && actx.listener),
      pendingPose: !!_pending,
      voices: voices, maxVoices: MAX_VOICES,
      stepTokens: stepTokens, stepsPerSecond: STEPS_PER_SECOND,
      listenedAt: _lastListen,
      hearing: cfg.hearing || 55,
    };
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
