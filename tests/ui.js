/* The pause-screen menus, driven through a real browser.
 *
 * Clicking a menu button must open its panel without grabbing the pointer and
 * dropping the player into the game, settings must survive a reload, and the
 * debug toggles must put real geometry into the scene.
 *
 *   node tests/ui.js
 */
'use strict';

const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const SHOTS = path.join(__dirname, 'shots');

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const puppeteer = await import('puppeteer-core');
  const launch = puppeteer.launch || puppeteer.default.launch;

  log('\n== PAUSE MENUS: OPTIONS AND DEBUG ==');

  const browser = await launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
           '--window-size=1100,760'],
    defaultViewport: { width: 1100, height: 760 },
  });

  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    /* This suite serves the page from a plain static server on purpose — the
     * menus are not supposed to need a game server. The name prompt is shown
     * before joining one, so reaching it means loading ?mp, and the socket
     * that cannot connect is the expected outcome, not a fault. */
    const expected = /WebSocket|ws:\/\/|wss:\/\//;
    page.on('console', m => {
      if (m.type() === 'error' && !expected.test(m.text())) errors.push(m.text());
    });

    // Start from a clean slate, but only once: clearing storage on every
    // navigation would also wipe it during the reload this test depends on.
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await page.evaluate(() => {
      try { localStorage.removeItem('paintball.options'); } catch (e) {}
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.game && window.options');

    /* ------------------------------------------------- opening the panels */
    const menuVisible = await page.evaluate(() =>
      !document.getElementById('menu').classList.contains('hidden'));
    check('the pause menu is up on load', menuVisible);

    await page.click('#btn-options');
    await sleep(200);
    const afterOptions = await page.evaluate(() => ({
      panelOpen: document.getElementById('panel-options').classList.contains('on'),
      playing: window.game.isActive(),
      locked: document.pointerLockElement !== null,
    }));
    check('the options button opens the options panel', afterOptions.panelOpen);
    check('and does not drop you into the game', !afterOptions.playing && !afterOptions.locked,
          `active=${afterOptions.playing}, pointer locked=${afterOptions.locked}`);
    await page.screenshot({ path: path.join(SHOTS, 'menu-options.png') });

    // clicking inside the panel must not start play either
    await page.click('#opt-sensitivity');
    await sleep(150);
    check('clicking a control inside the panel does not start play',
          !(await page.evaluate('game.isActive()')));

    await page.click('#close-options');
    await sleep(150);
    check('close puts the panel away',
          !(await page.evaluate(() =>
            document.getElementById('panel-options').classList.contains('on'))));

    await page.click('#btn-debug');
    await sleep(200);
    check('the debug button opens the debug panel',
          await page.evaluate(() =>
            document.getElementById('panel-debug').classList.contains('on')));

    /* ---------------------------------------------------- debug overlays */
    await page.click('#dbg-colliders');
    await sleep(300);
    const colliders = await page.evaluate(() => ({
      on: game.debugView.state.colliders,
      drawn: game.debugView.colliderCount(),
      expected: game.colliders.length,
      visible: game.debugView.colliderGroup.visible,
      saved: options.get('colliders'),
    }));
    check('the collision wireframes cover every collider',
          colliders.on && colliders.visible && colliders.drawn === colliders.expected,
          `${colliders.drawn} of ${colliders.expected}`);
    check('and the setting was remembered', colliders.saved === true);

    await page.click('#dbg-hitboxes');
    await sleep(300);
    const hitboxes = await page.evaluate(() => ({
      on: game.debugView.state.hitboxes,
      drawn: game.debugView.hitboxCount(),
      expected: game.npcs.length + game.aliveCount(),
    }));
    check('the hitbox outlines cover the NPCs and targets',
          hitboxes.on && hitboxes.drawn === hitboxes.expected,
          `${hitboxes.drawn} of ${hitboxes.expected}`);

    await page.click('#close-debug');
    await sleep(150);
    await page.screenshot({ path: path.join(SHOTS, 'menu-debug-overlays.png') });

    /* ------------------------------------------------ options that stick */
    await page.click('#btn-options');
    await sleep(150);
    await page.evaluate(() => {
      const set = (id, v) => {
        const n = document.getElementById(id);
        n.value = v;
        n.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('opt-sensitivity', '2.5');
      set('opt-master', '0.3');
      set('opt-gun', '0.15');
      const name = document.getElementById('opt-name');
      name.value = 'ana';
      name.dispatchEvent(new Event('change', { bubbles: true }));
      const invert = document.getElementById('opt-invert');
      invert.checked = true;
      invert.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(250);

    const applied = await page.evaluate(() => ({
      sensitivity: game.getSensitivity(),
      master: game.sfx.getVolume('master'),
      gun: game.sfx.getVolume('gun'),
      name: options.get('name'),
      invert: game.cfg.invertY,
      stored: JSON.parse(localStorage.getItem('paintball.options') || '{}'),
    }));
    check('changing a slider reaches the game at once',
          Math.abs(applied.sensitivity - 2.5) < 0.001,
          `sensitivity ${applied.sensitivity}`);
    check('the volumes reach the audio',
          Math.abs(applied.master - 0.3) < 0.001 && Math.abs(applied.gun - 0.15) < 0.001,
          `master ${applied.master}, gunfire ${applied.gun}`);
    check('the look inversion reaches the game', applied.invert === true);
    check('everything was written to storage',
          applied.stored.sensitivity === 2.5 && applied.stored.name === 'ana',
          JSON.stringify(applied.stored));

    // and it all comes back
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.game && window.options');
    await sleep(400);
    const reloaded = await page.evaluate(() => ({
      sensitivity: game.getSensitivity(),
      master: game.sfx.getVolume('master'),
      name: options.get('name'),
      invert: game.cfg.invertY,
      colliders: game.debugView.state.colliders,
      field: document.getElementById('opt-name').value,
    }));
    check('settings survive a reload',
          Math.abs(reloaded.sensitivity - 2.5) < 0.001 && reloaded.name === 'ana' &&
          reloaded.invert === true && Math.abs(reloaded.master - 0.3) < 0.001,
          `sensitivity ${reloaded.sensitivity}, name ${reloaded.name}, master ${reloaded.master}`);
    check('the debug toggle survives too and is applied', reloaded.colliders === true);
    check('the panel shows the stored values', reloaded.field === 'ana',
          `name field reads "${reloaded.field}"`);

    /* --------------------------------------------------------- resetting */
    await page.click('#btn-options');
    await sleep(150);
    await page.click('#reset-options');
    await sleep(250);
    const afterReset = await page.evaluate(() => ({
      sensitivity: game.getSensitivity(),
      name: options.get('name'),
      field: document.getElementById('opt-name').value,
    }));
    check('reset puts the defaults back everywhere',
          Math.abs(afterReset.sensitivity - 1) < 0.001 && afterReset.name === 'player' &&
          afterReset.field === 'player',
          `sensitivity ${afterReset.sensitivity}, name ${afterReset.name}`);

    /* ------------------------------------------- opting out of the fight */
    await page.click('#btn-options');
    await sleep(150);
    const pvpDefault = await page.evaluate(() => ({
      checked: document.getElementById('opt-pvp').checked,
      stored: options.get('pvp'),
    }));
    check('the fight switch is on to start with',
          pvpDefault.checked === true && pvpDefault.stored === true,
          `checkbox ${pvpDefault.checked}, stored ${pvpDefault.stored}`);

    await page.click('#opt-pvp');
    await sleep(200);
    const pvpOff = await page.evaluate(() => ({
      stored: options.get('pvp'),
      written: JSON.parse(localStorage.getItem('paintball.options') || '{}').pvp,
    }));
    check('turning it off is remembered',
          pvpOff.stored === false && pvpOff.written === false,
          `stored ${pvpOff.stored}, written ${pvpOff.written}`);
    await page.click('#opt-pvp');
    await sleep(150);
    await page.click('#close-options');
    await sleep(150);

    /* ------------------------------------------ the lifetime figures */
    const career = await page.evaluate(() => {
      localStorage.removeItem('paintball.career');
      window.career.clear();
      // play a little, then fold it in the way pausing does
      game.state.stats.shotsFired = 12;
      game.state.stats.shotsHit = 6;
      game.state.stats.kills = 2;
      game.state.score = 750;
      game.state.stats.bestScore = 750;
      const totals = window.career.fold(game.stats());
      return {
        totals: totals,
        stored: JSON.parse(localStorage.getItem('paintball.career') || '{}'),
      };
    });
    check('the lifetime figures are written to storage',
          career.stored.shotsFired === 12 && career.stored.kills === 2,
          JSON.stringify(career.stored));

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.game && window.career');
    await sleep(300);
    const carried = await page.evaluate(() => window.career.all());
    check('and they are still there after a reload',
          carried.shotsFired === 12 && carried.shotsHit === 6 && carried.bestScore === 750,
          `${carried.shotsFired} shots, ${carried.shotsHit} hits, best ${carried.bestScore}`);

    // the pause summary shows both columns
    const summary = await page.evaluate(() => {
      game.state.stats.shotsFired = 4;
      game.state.stats.shotsHit = 3;
      document.dispatchEvent(new Event('pointerlockchange'));
      const node = document.getElementById('summary');
      return { html: node.innerHTML, on: node.classList.contains('on') };
    });
    check('the pause summary has a session column and a lifetime one',
          summary.on && /SESSION/.test(summary.html) && /LIFETIME/.test(summary.html),
          summary.on ? 'headings missing' : 'the summary never opened');
    check('and the lifetime column carries the earlier session',
          /class="val life">1[26]</.test(summary.html),
          'no lifetime shot count in the summary');
    await page.screenshot({ path: path.join(SHOTS, 'menu-summary.png') });

    /* ------------------------------------- asking a new player their name */
    await page.evaluate(() => { localStorage.removeItem('paintball.options'); });
    await page.goto(`${BASE}/index.html?mp`, { waitUntil: 'load' });
    await sleep(700);
    const prompt = await page.evaluate(() => ({
      up: !document.getElementById('ask-name').hidden,
      connected: !!(window.net && window.net.self && window.net.self.id),
      built: !!window.game,
    }));
    check('a player who has never named themselves is asked before joining',
          prompt.up && !prompt.connected,
          `prompt up=${prompt.up}, already joined=${prompt.connected}`);
    await page.screenshot({ path: path.join(SHOTS, 'menu-ask-name.png') });

    // it refuses a name with nothing usable in it, and keeps asking
    await page.evaluate(() => {
      document.getElementById('ask-name-input').value = '!!!';
      document.getElementById('ask-name-form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await sleep(200);
    const refused = await page.evaluate(() => ({
      up: !document.getElementById('ask-name').hidden,
      err: document.getElementById('ask-name-err').textContent,
    }));
    check('a name of nothing usable is refused', refused.up && refused.err.length > 0,
          `still up=${refused.up}, said "${refused.err}"`);

    await page.evaluate(() => {
      document.getElementById('ask-name-input').value = 'ana';
      document.getElementById('ask-name-form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await sleep(400);
    const named = await page.evaluate(() => ({
      up: !document.getElementById('ask-name').hidden,
      name: options.get('name'),
      chosen: options.has('name'),
    }));
    check('answering it puts the prompt away and keeps the name',
          !named.up && named.name === 'ana' && named.chosen,
          `prompt up=${named.up}, name ${named.name}`);

    // and it is not asked a second time
    await page.goto(`${BASE}/index.html?mp`, { waitUntil: 'load' });
    await sleep(500);
    check('and a player who has one is not asked again',
          await page.evaluate(() => document.getElementById('ask-name').hidden));

    check('no console errors while using the menus', errors.length === 0,
          errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }

  log(failures === 0 ? '\nALL MENU CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('menu driver crashed:', err);
  process.exit(2);
});
