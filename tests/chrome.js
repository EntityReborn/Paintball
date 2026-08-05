/* How the test drivers launch Chrome.
 *
 * One place, because the flags decide how long the whole suite takes and what
 * it is able to prove.
 *
 * The drivers used to force `--use-angle=swiftshader`, which rasterises every
 * pixel on the CPU. On a machine with a GPU that is an eleven-fold slowdown —
 * measured here at 13fps against 144, and a two-second page load against
 * seven-tenths — and because every wait in the suite is on the game clock, the
 * whole thing runs at a thirteenth of speed. Worse, it is not only slow: a
 * client drawing at 13fps cannot drain its own socket between frames, so the
 * networking tests spent their time measuring the renderer and failing on
 * whichever check happened to catch the machine at its worst.
 *
 * So: hardware GL by default, and software only when asked for. A machine with
 * no GPU at all — a container, a CI box — sets SOFTWARE_GL=1 and gets the old
 * behaviour, which is slow but works everywhere.
 */
'use strict';

const SOFTWARE = process.env.SOFTWARE_GL === '1';

const COMMON = [
  '--no-sandbox',
  // headless still throttles what it thinks is a background page, and a
  // throttled client stops drawing and stops reading its socket
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const SOFTWARE_GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/* `extra` is whatever the driver needs on top — a window size, and verify.js
 * wants web security off so the suite can reach into its own iframe. */
function chromeArgs(extra = []) {
  return COMMON.concat(SOFTWARE ? SOFTWARE_GL_ARGS : [], extra);
}

function glMode() {
  return SOFTWARE ? 'software (SOFTWARE_GL=1)' : 'hardware';
}

module.exports = { chromeArgs, glMode, SOFTWARE };
