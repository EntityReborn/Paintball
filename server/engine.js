/* Loads the browser engine into Node.
 *
 * The client scripts are plain IIFEs that attach to a global, and the vendored
 * three.js is a UMD build, so both load here unchanged. Server and client run
 * byte-identical world generation — same file, same seed, same arena.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function load() {
  if (globalThis.createGame) return globalThis.createGame;

  // three.js first: every module reads it off the global
  globalThis.THREE = require(path.join(ROOT, 'vendor', 'three.min.js'));

  /* options.js is in here for one reason: the name sanitiser. A name arrives
   * from a client and is shown to every other client, so the server has to
   * clean it — and cleaning it by a second, slightly different rule written
   * out again here is how the two drift apart. */
  const order = [
    'options.js', 'figure.js', 'audio.js', 'world.js', 'effects.js',
    'targets.js', 'weapon.js', 'npcs.js', 'perks.js', 'game.js',
  ];
  for (const file of order) {
    const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    vm.runInThisContext(src, { filename: `src/${file}` });
  }
  return globalThis.createGame;
}

/* A world with no renderer, no DOM and no audio. */
function createHeadlessGame(options) {
  const createGame = load();
  return createGame(Object.assign({
    headless: true,
    audio: false,
    shadows: false,
  }, options || {}));
}

module.exports = { load, createHeadlessGame, ROOT };
