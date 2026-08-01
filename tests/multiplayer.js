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
    env: { ...process.env, PORT: String(PORT), MAP_SEED: '4242', SHOT_DEBUG: process.env.SHOT_DEBUG || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', d => {
    const line = d.toString().trim();
    serverLog.push(line);
    if (process.env.SHOT_DEBUG && /shot-debug/.test(line)) log('  ' + line);
  });
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
    const fingerprints = await Promise.all([
      ana.evaluate('net.self.arenaMatch'),
      bo.evaluate('net.self.arenaMatch'),
    ]);
    check('both clients generated the same arena as the server',
          fingerprints[0] === true && fingerprints[1] === true,
          `ana ${fingerprints[0]}, bo ${fingerprints[1]}`);

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

    /* ------------------------------- shooting is decided by the server */
    // find an NPC ana can see, shoot it, and check it stays down on BOTH
    // clients — the bug was that the shooter scored but the NPC kept walking
    const npcShot = await ana.evaluate(async () => {
      const before = game.state.score;
      let chosen = null;
      for (let attempt = 0; attempt < 24 && !chosen; attempt++) {
        for (const n of game.npcs) {
          if (!n.alive || !n.grounded) continue;
          const chest = n.root.position.clone().setY(1.0);
          const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
          if (!game.hasLineOfSight(eye, chest)) continue;
          game.aimAt(chest);
          chosen = game.npcs.indexOf(n);
          break;
        }
        if (!chosen && chosen !== 0) await new Promise(r => setTimeout(r, 120));
      }
      if (chosen === null) return null;
      // A running NPC can duck behind cover between aiming and firing, which
      // is a fair miss. Take a few shots at whatever is currently in the open.
      for (let tries = 0; tries < 5; tries++) {
        const n = game.npcs[chosen];
        if (!n.alive) break;
        const chest = n.root.position.clone().setY(1.0);
        const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
        if (game.hasLineOfSight(eye, chest)) {
          game.aimAt(chest);
          game.state.mag = 12;
          game.state.lastShot = -1e9;
          game.shoot();
        }
        await new Promise(r => setTimeout(r, 450));
      }
      return {
        index: chosen,
        scoreBefore: before,
        scoreAfter: game.state.score,
        aliveHere: game.npcs[chosen].alive,
        sent: net.stats.shots,
        lastHit: net.stats.lastHit || null,
        rejected: net.stats.rejected,
        reason: net.stats.lastRejection,
      };
    });

    check('ana could line up on an NPC', !!npcShot,
          npcShot ? `npc ${npcShot.index}` : 'never got a clear line');

    if (npcShot) {
      check('the shot scored, once per kill', npcShot.scoreAfter === npcShot.scoreBefore + 250,
            `score ${npcShot.scoreBefore} -> ${npcShot.scoreAfter}; ` +
            `${npcShot.sent} shots sent, server said "${npcShot.lastHit}"` +
            (npcShot.rejected ? `, ${npcShot.rejected} rejected: ${npcShot.reason}` : ''));
      check('the NPC is down on the shooting client', npcShot.aliveHere === false);

      const boSaw = await bo.evaluate(i => ({
        alive: game.npcs[i].alive,
        toppled: game.npcs[i].root.rotation.x,
      }), npcShot.index);
      check('the NPC is down on the other client too', boSaw.alive === false,
            `bo sees alive=${boSaw.alive}`);
      check('the body toppled over rather than walking on', boSaw.toppled > 0.5,
            `rotation.x ${boSaw.toppled.toFixed(2)}`);

      // and it must not come back when the next snapshots land
      await sleep(1500);
      const later = await Promise.all([
        ana.evaluate(i => game.npcs[i].alive, npcShot.index),
        bo.evaluate(i => game.npcs[i].alive, npcShot.index),
      ]);
      check('the NPC stays down as snapshots keep arriving',
            later[0] === false && later[1] === false,
            `ana ${later[0]}, bo ${later[1]}`);
    }

    // a target broken by one client breaks on the other as well
    const targetShot = await ana.evaluate(async () => {
      const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      const t = game.targets.find(t => t.alive && game.hasLineOfSight(eye, t.mesh.position));
      if (!t) return null;
      const index = game.targets.indexOf(t);
      game.aimAt(t.mesh.position);
      game.state.mag = 12;
      game.state.lastShot = -1e9;
      game.shoot();
      await new Promise(r => setTimeout(r, 900));
      return { index, alive: game.targets[index].alive };
    });
    if (targetShot) {
      const boTarget = await bo.evaluate(i => game.targets[i].alive, targetShot.index);
      check('a target broken by one player is broken for everyone',
            targetShot.alive === false && boTarget === false,
            `ana ${targetShot.alive}, bo ${boTarget}`);
    }

    // remote figures must not sprint their legs
    const legSpeed = await bo.evaluate(async () => {
      const n = game.npcs.find(n => n.alive);
      if (!n || !n.fig) return null;
      const start = n.netPhase || 0;
      const t0 = performance.now();
      await new Promise(r => setTimeout(r, 1200));
      const elapsed = (performance.now() - t0) / 1000;
      return { perSecond: ((n.netPhase || 0) - start) / elapsed, speed: n.speed };
    });
    // an NPC runs at ~3.4-5.2 u/s and the cycle is 2.4 rad per unit
    check('remote figures animate at running speed, not triple speed',
          legSpeed === null || legSpeed.perSecond < 16,
          legSpeed ? `${legSpeed.perSecond.toFixed(1)} rad/s of run cycle` : 'no NPC to sample');

    /* ------------------------- a late joiner gets the level in progress */
    // The seed alone is not enough once anything has been shot: a client that
    // builds its own level ends up applying the server's entity indices to a
    // different set of objects, which is how new targets went missing and an
    // extra NPC turned into an invisible thing that ate bullets.
    const late = await browsers[0].newPage();
    late.on('pageerror', e => errors.push('late: ' + e.message));
    await late.goto(`${BASE}/index.html?mp&name=late`, { waitUntil: 'load' });
    await late.waitForFunction('window.game && window.net && net.self.id', { timeout: 30000 });
    await late.evaluate(() => {
      game.setActive(true);
      document.getElementById('menu').classList.add('hidden');
    });
    await sleep(1200);

    const worldState = await Promise.all([ana, late].map(p => p.evaluate(() => ({
      level: game.state.level,
      targets: game.targets.length,
      alive: game.targets.map(t => (t.alive ? 1 : 0)).join(''),
      npcs: game.npcs.length,
      wander: game.targets.map(t => (t.wander ? 1 : 0)).join(''),
    }))));
    check('a late joiner lands in the level already in progress',
          worldState[0].level === worldState[1].level &&
          worldState[0].targets === worldState[1].targets &&
          worldState[0].npcs === worldState[1].npcs,
          `level ${worldState[1].level}, ${worldState[1].targets} targets, ${worldState[1].npcs} NPCs`);
    check('the late joiner agrees on which targets are already broken',
          worldState[0].alive === worldState[1].alive,
          `ana ${worldState[0].alive} vs late ${worldState[1].alive}`);
    check('and on which of them drift',
          worldState[0].wander === worldState[1].wander,
          `ana ${worldState[0].wander} vs late ${worldState[1].wander}`);

    const lateTargets = await late.evaluate(() => ({
      visible: game.targets.filter(t => t.mesh.visible && t.alive).length,
      inScene: game.targets.filter(t => t.alive && t.mesh.parent).length,
    }));
    check('the late joiner can actually see the live targets',
          lateTargets.visible > 0 && lateTargets.visible === lateTargets.inScene,
          `${lateTargets.visible} visible of ${lateTargets.inScene} in the scene`);

    /* Nothing invisible may stop a bullet. Fire at static cover — down a line
     * with no NPC or target near it, so nothing is moving and the client's
     * interpolation window cannot explain a difference — and check the server
     * stops the round in the same place. This is the regression test for the
     * arena collapsing to the origin server-side. */
    const geometry = await late.evaluate(async () => {
      const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      let pick = null;
      for (let a = 0; a < Math.PI * 2 && !pick; a += Math.PI / 24) {
        const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        const hit = game.traceShot(eye, dir);
        if (!hit.normal || hit.distance > 25) continue;    // want static cover
        const ray = new THREE.Ray(eye, dir);
        const movers = []
          .concat(game.targets.filter(t => t.alive).map(t => t.mesh.position))
          .concat(game.npcs.filter(n => n.alive).map(n => n.root.position.clone().setY(1)));
        const nearRay = movers.some(p =>
          ray.distanceToPoint(p) < 2 && eye.distanceTo(p) < hit.distance + 3);
        if (nearRay) continue;                             // something might drift into it
        pick = { dir, distance: hit.distance, object: hit.object ? hit.object.name : '?' };
      }
      if (!pick) return null;

      let serverSaid = null;
      net.on('hit', m => { if (m.by === net.self.id) serverSaid = m; });
      game.aimAt(eye.clone().addScaledVector(pick.dir, 50));
      game.state.mag = 12; game.state.lastShot = -1e9;
      game.shoot();
      await new Promise(r => setTimeout(r, 1000));
      if (!serverSaid) return { pick: pick.distance, object: pick.object, server: null };
      return {
        pick: +pick.distance.toFixed(1),
        object: pick.object,
        kind: serverSaid.kind,
        server: +Math.hypot(serverSaid.point.x - eye.x, serverSaid.point.z - eye.z).toFixed(1),
      };
    });

    check('found static cover to test against', !!geometry && geometry.server !== null,
          geometry ? `${geometry.object} at ${geometry.pick}u` : 'no clear line to cover');
    if (geometry && geometry.server !== null) {
      check('client and server stop a bullet at the same place',
            Math.abs(geometry.pick - geometry.server) < 1.5,
            `client ${geometry.pick}u on the ${geometry.object}, server ${geometry.server}u`);
    }

    await late.close();
    await sleep(400);

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
    // poll rather than guessing at a delay
    for (let i = 0; i < 30; i++) {
      if (await ana.evaluate('net.remoteCount()') === 0) break;
      await sleep(100);
    }
    const afterLeave = await ana.evaluate(() => ({
      count: net.remoteCount(),
      ids: [...net.remotes.keys()],
      self: net.self.id,
    }));
    check('a player who leaves is removed from the world', afterLeave.count === 0,
          `${afterLeave.count} left: ids ${JSON.stringify(afterLeave.ids)}, ana is ${afterLeave.self}`);

    check('no console errors on either client', errors.length === 0,
          errors.slice(0, 3).join(' | '));

    if (failures) log('  server log: ' + serverLog.slice(-6).join(' | '));
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
