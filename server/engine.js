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

  const order = [
    'figure.js', 'audio.js', 'world.js', 'effects.js',
    'targets.js', 'weapon.js', 'npcs.js', 'game.js',
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
