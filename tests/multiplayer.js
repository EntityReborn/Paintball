/* Two real browsers, one server, one world.
 *
 * Starts the game server, opens two Chrome pages against it, walks one player
 * with genuine key presses and checks the other page sees that movement on the
 * right body in the right place.
 *
 *   node tests/multiplayer.js
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.MP_PORT || 8124;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitForServer(tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      http.get(`${BASE}/healthz`, res => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (n <= 0) return reject(new Error('server never came up'));
        setTimeout(() => attempt(n - 1), 200);
      });
    };
    attempt(tries);
  });
}

// wait for the page's game clock, not the wall clock: headless is slow
async function advance(page, seconds, timeout = 60000) {
  const from = await page.evaluate('window.game ? game.state.elapsed : 0');
  await page.waitForFunction(
    `window.game && game.state.elapsed >= ${from} + ${seconds}`,
    { timeout, polling: 30 }
  );
}

(async () => {
  const puppeteer = await import('puppeteer-core');
  const launch = puppeteer.launch || puppeteer.default.launch;

  log('\n== MULTIPLAYER: TWO BROWSERS, ONE WORLD ==');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MAP_SEED: '4242' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', d => serverLog.push(d.toString().trim()));
  server.stderr.on('data', d => serverLog.push('ERR ' + d.toString().trim()));

  /* One browser per client, not one browser with two tabs: a hidden tab stops
   * running requestAnimationFrame, so the client that is not in front would
   * freeze and never process a snapshot. Two windows means both are visible. */
  const newBrowser = () => launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
           '--window-size=900,560',
           '--disable-background-timer-throttling',
           '--disable-backgrounding-occluded-windows',
           '--disable-renderer-backgrounding'],
    defaultViewport: { width: 900, height: 560 },
  });
  const browsers = [await newBrowser(), await newBrowser()];

  try {
    await waitForServer();
    check('the server is up and answering its health check', true);

    const errors = [];
    let nextBrowser = 0;
    const openClient = async name => {
      const page = await browsers[nextBrowser++].newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
      await page.goto(`${BASE}/index.html?mp&name=${name}`, { waitUntil: 'load' });
      await page.waitForFunction('window.game && window.net && net.self.id', { timeout: 30000 });
      await page.evaluate(() => {
        game.setActive(true);
        document.getElementById('menu').classList.add('hidden');
      });
      return page;
    };

    const ana = await openClient('ana');
    const bo = await openClient('bo');

    const ids = await Promise.all([
      ana.evaluate('net.self.id'),
      bo.evaluate('net.self.id'),
    ]);
    check('both clients joined and were given ids', ids[0] !== ids[1] && ids[0] > 0,
          `ids ${ids.join(' and ')}`);

    const seeds = await Promise.all([
      ana.evaluate('net.self.seed'),
      bo.evaluate('net.self.seed'),
    ]);
    check('both clients were handed the same map seed', seeds[0] === seeds[1] && seeds[0] === 4242,
          `seed ${seeds[0]}`);

    const worlds = await Promise.all([ana, bo].map(p => p.evaluate(() => ({
      obstacles: game.obstacleMeshes.length,
      first: game.obstacleBoxes[0].min.toArray().map(n => +n.toFixed(3)),
      npcs: game.npcs.length,
    }))));
    check('both clients built an identical arena',
          JSON.stringify(worlds[0]) === JSON.stringify(worlds[1]),
          `${worlds[0].obstacles} obstacles, first cover at ${worlds[0].first.join(',')}`);

    // snapshots flowing?
    await sleep(1500);
    const flow = await ana.evaluate(() => ({
      received: net.stats.received, sent: net.stats.sent, buffered: net.snapshots.length,
    }));
    check('snapshots are arriving and state is going out',
          flow.received > 5 && flow.sent > 5,
          `${flow.sent} sent, ${flow.received} received, ${flow.buffered} buffered`);

    const running = await Promise.all([ana, bo].map(p => p.evaluate(() => ({
      elapsed: +game.state.elapsed.toFixed(1),
      hidden: document.hidden,
    }))));
    check('both clients are actually rendering',
          running.every(r => r.elapsed > 0.5 && !r.hidden),
          running.map(r => `${r.elapsed}s${r.hidden ? ' (hidden)' : ''}`).join(', '));

    const remotesSeen = await Promise.all([
      ana.evaluate('net.remoteCount()'),
      bo.evaluate('net.remoteCount()'),
    ]);
    check('each client drew a body for the other player',
          remotesSeen[0] === 1 && remotesSeen[1] === 1,
          `ana sees ${remotesSeen[0]}, bo sees ${remotesSeen[1]}`);

    /* -------------------------------------------- ana walks, bo watches */
    const anaBefore = await ana.evaluate(() => ({ ...game.state.pos }));
    const boSawBefore = await bo.evaluate(() => {
      const r = [...net.remotes.values()][0];
      return r && r.last ? { x: r.last.x, z: r.last.z } : null;
    });

    // point somewhere with room to run, then hold W for real
    await ana.evaluate(() => {
      game.teleport(0, game.cfg.eye, 0);
      const eye = new THREE.Vector3(0, game.cfg.eye, 0);
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
        const to = new THREE.Vector3(Math.sin(a) * 12, game.cfg.eye, Math.cos(a) * 12);
        if (game.hasLineOfSight(eye, to)) { game.aimAt(to); return; }
      }
    });
    await ana.keyboard.down('KeyW');
    await advance(ana, 1.2);
    await ana.keyboard.up('KeyW');
    await sleep(600);

    const anaAfter = await ana.evaluate(() => ({ ...game.state.pos }));
    const anaMoved = Math.hypot(anaAfter.x - anaBefore.x, anaAfter.z - anaBefore.z);
    check('ana actually walked', anaMoved > 2, `moved ${anaMoved.toFixed(2)}u`);

    const boSees = await bo.evaluate(() => {
      const r = [...net.remotes.values()][0];
      if (!r) return null;
      const p = r.fig.root.position;
      return { x: p.x, y: p.y, z: p.z, visible: r.fig.root.visible, phase: r.phase };
    });
    check("bo's copy of ana moved too", !!boSees && !!boSawBefore &&
          Math.hypot(boSees.x - boSawBefore.x, boSees.z - boSawBefore.z) > 1.5,
          boSees ? `now at ${boSees.x.toFixed(1)}, ${boSees.z.toFixed(1)}` : 'no remote body');

    const drift = Math.hypot(boSees.x - anaAfter.x, boSees.z - anaAfter.z);
    check("bo's copy of ana is in the right place", drift < 1.5,
          `${drift.toFixed(2)}u from where ana really is`);
    check('the remote body was animated by the movement', boSees.phase > 1,
          `run phase ${boSees.phase.toFixed(1)}`);

    /* ------------------------------------------- entities agree as well */
    const npcAgreement = await Promise.all([ana, bo].map(p => p.evaluate(() =>
      game.npcs.map(n => [+n.root.position.x.toFixed(1), +n.root.position.z.toFixed(1)]))));
    let worstNpc = 0;
    for (let i = 0; i < npcAgreement[0].length; i++) {
      worstNpc = Math.max(worstNpc, Math.hypot(
        npcAgreement[0][i][0] - npcAgreement[1][i][0],
        npcAgreement[0][i][1] - npcAgreement[1][i][1]));
    }
    check('both clients see the NPCs in the same places', worstNpc < 1.5,
          `worst disagreement ${worstNpc.toFixed(2)}u`);

    /* ------------------------------------------------ cheating is caught */
    const cheat = await ana.evaluate(async () => {
      const before = net.stats.corrections;
      // claim to be on the far side of the map, the way a teleport hack would
      net.__cheat = true;
      game.teleport(25, game.cfg.eye, 25);
      await new Promise(r => setTimeout(r, 700));
      return { corrections: net.stats.corrections - before, pos: { ...game.state.pos } };
    });
    check('the server rejected a teleport and snapped the client back',
          cheat.corrections > 0 && Math.hypot(cheat.pos.x - 25, cheat.pos.z - 25) > 5,
          `${cheat.corrections} corrections, client put back at ` +
          `${cheat.pos.x.toFixed(1)}, ${cheat.pos.z.toFixed(1)}`);

    /* Look at each other for the screenshots. No teleporting: the server
     * would reject it as a hack and snap the client back, leaving the camera
     * pointed at where the other player used to be. */
    const aimAtEachOther = async () => {
      for (const page of [ana, bo]) {
        await page.evaluate(() => {
          const r = [...net.remotes.values()][0];
          if (!r) return;
          const p = r.fig.root.position;
          game.aimAt(new THREE.Vector3(p.x, 1.1, p.z));
        });
      }
    };
    await aimAtEachOther();
    await sleep(400);
    await aimAtEachOther();          // settle on where they actually are now
    await sleep(200);
    await ana.screenshot({ path: path.join(SHOTS, 'mp-ana.png') });
    await bo.screenshot({ path: path.join(SHOTS, 'mp-bo.png') });

    /* ------------------------------------------------------ leaving */
    await bo.close();
    await sleep(900);
    const afterLeave = await ana.evaluate('net.remoteCount()');
    check('a player who leaves is removed from the world', afterLeave === 0,
          `${afterLeave} remote bodies left`);

    check('no console errors on either client', errors.length === 0,
          errors.slice(0, 3).join(' | '));
  } finally {
    for (const b of browsers) await b.close();
    server.kill();
  }

  log(`\nScreenshots written to ${SHOTS}`);
  log(failures === 0 ? '\nALL MULTIPLAYER CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('multiplayer driver crashed:', err);
  process.exit(2);
});
