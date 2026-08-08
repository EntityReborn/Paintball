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
const { chromeArgs, glMode } = require('./chrome.js');

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
    args: chromeArgs(['--window-size=1100,760']),
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

    /* --------------------------------------- how much of the fight to be in */
    await page.click('#btn-options');
    await sleep(150);
    const modeDefault = await page.evaluate(() => ({
      shown: document.getElementById('opt-mode').value,
      stored: options.get('mode'),
      choices: [...document.getElementById('opt-mode').options].map(o => o.value).join(','),
    }));
    check('the fight starts as pvp, with three to choose from',
          modeDefault.shown === 'pvp' && modeDefault.stored === 'pvp' &&
          modeDefault.choices === 'pvp,pve,peaceful',
          `showing ${modeDefault.shown}, stored ${modeDefault.stored}, ` +
          `choices ${modeDefault.choices}`);

    // the select does not respond to a click the way a checkbox does
    const pickMode = async (mode) => {
      await page.select('#opt-mode', mode);
      await sleep(200);
      return page.evaluate(() => ({
        stored: options.get('mode'),
        pvp: options.get('pvp'),
        written: JSON.parse(localStorage.getItem('paintball.options') || '{}').mode,
        game: window.game && window.game.state.mode,
        note: (document.getElementById('mode-note') || {}).textContent,
      }));
    };

    const pve = await pickMode('pve');
    check('choosing PVE is remembered and reaches the game',
          pve.stored === 'pve' && pve.written === 'pve' && pve.game === 'pve',
          `stored ${pve.stored}, written ${pve.written}, game ${pve.game}`);
    check('and the old boolean follows the mode rather than leading it',
          pve.pvp === false, `pvp reads ${pve.pvp}`);

    const peaceful = await pickMode('peaceful');
    check('choosing PEACEFUL reaches the game too',
          peaceful.stored === 'peaceful' && peaceful.game === 'peaceful',
          `stored ${peaceful.stored}, game ${peaceful.game}`);
    check('and the panel says what the mode does',
          /nothing/i.test(peaceful.note || ''), `note "${peaceful.note}"`);

    /* The bug the whole mode exists for: a hunter came after somebody who had
     * asked to be left alone, because opting out was only ever about players. */
    const hunted = await page.evaluate(() => {
      const was = window.game.hunterTargets();
      window.game.setActive(true);
      return { peaceful: (window.game.hunterTargets() || []).length };
    });
    check('a hunter has nobody to come after when the player is peaceful',
          hunted.peaceful === 0, `${hunted.peaceful} target(s)`);

    await pickMode('pvp');
    const back = await page.evaluate(() => ({
      hunted: (window.game.hunterTargets() || []).length,
    }));
    check('and comes back when the player rejoins the fight',
          back.hunted === 1, `${back.hunted} target(s)`);

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

    /* ------------------------------------------- the scoreboard, offline */
    /* There is no room to list, so it lists the only player there is and says
     * why the rest of the table is empty. It has to work here at all: a key
     * that does nothing reads as a broken key, not as an online-only feature. */
    const alone = await page.evaluate(async () => {
      game.state.score = 4321;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      const el = document.getElementById('board');
      const shown = !el.hidden;
      const rows = [...el.querySelectorAll('.row')].map(r => r.textContent);
      const note = el.querySelector('.lonely');
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      return { shown, rows, note: note ? note.textContent : null, gone: el.hidden };
    });
    check('TAB shows the scoreboard offline too', alone.shown && alone.gone,
          `shown ${alone.shown}, hidden again ${alone.gone}`);
    check('with one row for the only player in it, and their score',
          alone.rows.length === 1 && /4321/.test(alone.rows[0]),
          alone.rows.join(' | ') || 'no rows');
    check('and says why there is nobody else on it',
          !!alone.note && /OFFLINE/.test(alone.note), alone.note || 'no note');
    await page.screenshot({ path: path.join(SHOTS, 'menu-scoreboard.png') });

    /* --------------------------------------------- the match controls */
    const matchPanel = await page.evaluate(async () => {
      document.getElementById('btn-match').click();
      await new Promise(r => setTimeout(r, 150));
      return {
        open: document.getElementById('panel-match').classList.contains('on'),
        playing: window.game.isActive(),
        where: document.getElementById('match-where').textContent,
        adders: [...document.querySelectorAll('[data-add]')].map(b => b.dataset.add),
      };
    });
    check('the match button opens the match panel', matchPanel.open);
    check('and does not drop you into the game', !matchPanel.playing);
    check('it says whose match this is', /Offline/.test(matchPanel.where),
          matchPanel.where);
    check('with something to add of each kind',
          ['target', 'npc', 'hunter', 'perk'].every(k => matchPanel.adders.includes(k)),
          matchPanel.adders.join(', '));

    const added = await page.evaluate(async () => {
      const before = {
        targets: game.aliveCount(), npcs: game.npcs.length,
        hunters: game.hunters().length, perks: game.perks.length,
      };
      document.getElementById('match-count').value = '2';
      document.getElementById('match-count')
        .dispatchEvent(new Event('input', { bubbles: true }));
      for (const what of ['target', 'npc', 'hunter', 'perk']) {
        document.querySelector(`[data-add="${what}"]`).click();
        await new Promise(r => setTimeout(r, 60));
      }
      return {
        before,
        after: {
          targets: game.aliveCount(), npcs: game.npcs.length,
          hunters: game.hunters().length, perks: game.perks.length,
        },
        count: document.getElementById('match-count-value').textContent,
        note: document.getElementById('match-added').textContent,
      };
    });
    check('the counter says how many each press brings', added.count === '2', added.count);
    check('adding targets, NPCs, hunters and perks all arrive',
          added.after.targets === added.before.targets + 2 &&
          added.after.npcs === added.before.npcs + 4 &&      // npcs and hunters both
          added.after.hunters === added.before.hunters + 2 &&
          added.after.perks === added.before.perks + 2,
          `${JSON.stringify(added.before)} -> ${JSON.stringify(added.after)}`);
    check('and it says what it did', /Added 2/.test(added.note), added.note);
    await page.screenshot({ path: path.join(SHOTS, 'menu-match.png') });

    /* Restarting takes two presses on purpose: it throws the map, the level
     * and every figure in the session away. */
    const arming = await page.evaluate(async () => {
      const b = document.getElementById('match-restart');
      const before = b.textContent;
      b.click();
      await new Promise(r => setTimeout(r, 60));
      return { before, armed: b.textContent, flag: b.dataset.armed };
    });
    check('one press on restart only arms it',
          /RESTART/.test(arming.before) && /SURE/.test(arming.armed) && arming.flag === '1',
          `"${arming.before}" -> "${arming.armed}"`);

    // it disarms itself rather than sitting there loaded
    const disarmed = await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 4300));
      const b = document.getElementById('match-restart');
      return { text: b.textContent, flag: b.dataset.armed };
    });
    check('and forgets about it if you walk away',
          /RESTART/.test(disarmed.text) && disarmed.flag !== '1',
          `"${disarmed.text}"`);

    /* And the second press restarts. Offline that is a reload, so the page is
     * gone after this: everything below re-navigates anyway. */
    const restarted = await page.evaluate(async () => {
      game.state.score = 4321;
      const seedBefore = game.arenaFingerprint();
      const b = document.getElementById('match-restart');
      b.click();                                   // arm
      await new Promise(r => setTimeout(r, 60));
      b.click();                                   // and go
      return { seedBefore, text: b.textContent };
    });
    await page.waitForFunction('window.game && game.state.score === 0', { timeout: 15000 });
    const afterRestart = await page.evaluate(() => ({
      score: game.state.score,
      level: game.state.level,
      fingerprint: game.arenaFingerprint(),
      shots: game.stats().shotsFired,
    }));
    check('the second press restarts the match', restarted.text === 'RESTARTING…',
          restarted.text);
    check('on a new map, at level one, with the figures wiped',
          afterRestart.fingerprint !== restarted.seedBefore &&
          afterRestart.level === 1 && afterRestart.score === 0 && afterRestart.shots === 0,
          `level ${afterRestart.level}, score ${afterRestart.score}, ` +
          `map ${restarted.seedBefore} -> ${afterRestart.fingerprint}`);

    /* ------------------------------------------------- the chat, offline */
    /* The log is a record of what happened as well as a conversation, so it
     * works with nobody to talk to — and says as much rather than pretending
     * a message went somewhere. */
    await page.keyboard.press('Enter');
    await sleep(150);
    const chatUp = await page.evaluate(() => ({
      inputUp: !document.getElementById('chat-form').hidden,
      focused: document.activeElement === document.getElementById('chat-input'),
    }));
    check('ENTER opens the chat input offline as well',
          chatUp.inputUp && chatUp.focused,
          `input up ${chatUp.inputUp}, focused ${chatUp.focused}`);

    await page.keyboard.type('anybody there');
    await page.keyboard.press('Enter');
    await sleep(200);
    const said = await page.evaluate(() => ({
      inputUp: !document.getElementById('chat-form').hidden,
      lines: [...document.querySelectorAll('#chat-log .line')].map(l => ({
        at: l.querySelector('.at').textContent,
        said: l.querySelector('.said').textContent,
      })),
    }));
    check('sending closes it again', !said.inputUp);
    check('and says there is nobody to hear it',
          said.lines.length === 1 && /NOBODY TO TALK TO/.test(said.lines[0].said),
          said.lines.map(l => l.said).join(' | ') || 'no lines');
    check('with a local clock on it',
          !!said.lines.length && /^\[\d{1,2}:\d{2}(\s?[AaPp][Mm])?\]$/.test(said.lines[0].at),
          said.lines.length ? said.lines[0].at : 'no lines');

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
