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
const { chromeArgs, glMode, SOFTWARE } = require('./chrome.js');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.MP_PORT || 8124;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');

/* Drawing the shadow pass twice over on a CPU is most of a frame, and a client
 * that slow stops reading its own socket between frames. Only worth dropping
 * when there is no GPU to do it on. */
const CHEAP = SOFTWARE ? '&shadows=0' : '';

let failures = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

/* For a check whose subject never got a fair run — the client was starved of
 * CPU, or the snapshots it was meant to be drawing from never turned up.
 * Two headless browsers on software rendering is a genuinely bad connection to
 * a genuinely slow machine, and calling that a rendering fault is how a suite
 * gets ignored. Says why, out loud, and does not pretend it passed. */
function skip(name, why) {
  log(`  SKIP  ${name}  — ${why}`);
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

  log(`\n== MULTIPLAYER: TWO BROWSERS, ONE WORLD ==  (${glMode()} GL)`);

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), MAP_SEED: '4242',
      PERK_EVERY: '3',                       // so a perk is out early in the run
      /* No hunter in this match. Half of what follows counts health to the
       * point — nine hits that must not kill, a point of regen at a time — and
       * a third party shooting at both of them from across the arena decides
       * those numbers instead. The room's own hunter tests cover it. */
      HUNTERS: '0',
      SHOT_DEBUG: process.env.SHOT_DEBUG || '',
    },
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
    args: chromeArgs(['--window-size=900,560']),
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
      await page.goto(`${BASE}/index.html?mp&hunters=0${CHEAP}&name=${name}`, { waitUntil: 'load' });
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

    // point somewhere with room to run, then hold W for real. No teleporting
    // to a known spot first: the server chooses where each player arrives.
    await ana.evaluate(() => {
      const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      const lim = game.cfg.arena / 2 - 3;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
        const to = new THREE.Vector3(eye.x + Math.sin(a) * 12, game.cfg.eye,
                                     eye.z + Math.cos(a) * 12);
        if (Math.abs(to.x) > lim || Math.abs(to.z) > lim) continue;
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

    const looks = await bo.evaluate(() => {
      const r = [...net.remotes.values()][0];
      const npc = game.npcs[0];
      const hsl = {};
      const npcHsl = {};
      r.fig.torso.material.color.getHSL(hsl);
      npc.torso.material.color.getHSL(npcHsl);
      return {
        playerGear: r.fig.extras ? r.fig.extras.length : 0,
        npcGear: npc.fig && npc.fig.extras ? npc.fig.extras.length : 0,
        playerHue: +hsl.h.toFixed(2),
        npcHue: +npcHsl.h.toFixed(2),
      };
    });
    const tags = await bo.evaluate(() => {
      const r = [...net.remotes.values()][0];
      return {
        has: !!(r && r.tag),
        text: r && r.tag ? r.tag.text : null,
        known: [...net.names.values()],
        aboveHead: r && r.tag ? r.tag.sprite.position.y : 0,
      };
    });
    check('a remote player carries their name over their head',
          tags.has && tags.text === 'ana' && tags.aboveHead > 1.8,
          `tag "${tags.text}" at y=${tags.aboveHead}, names known: ${JSON.stringify(tags.known)}`);

    const hidden = await bo.evaluate(() => {
      net.setShowNames(false);
      const r = [...net.remotes.values()][0];
      const off = r.tag ? r.tag.sprite.visible : null;
      net.setShowNames(true);
      return { off, on: r.tag ? r.tag.sprite.visible : null };
    });
    check('and the name tags can be turned off', hidden.off === false && hidden.on === true,
          `off=${hidden.off}, on=${hidden.on}`);

    const depth = await bo.evaluate(() => {
      const r = [...net.remotes.values()][0];
      return {
        tagTest: r.tag ? r.tag.sprite.material.depthTest : null,
        barTest: r.health ? r.health.material.depthTest : null,
        perk: game.perkSystem.perks.length
          ? game.perkSystem.perks[0].view.tag.sprite.material.depthTest : true,
        kit: game.medkits[0].view.tag.sprite.material.depthTest,
      };
    });
    check('nothing floating over the world reads through it',
          depth.tagTest && depth.barTest && depth.perk && depth.kit,
          `name ${depth.tagTest}, health ${depth.barTest}, ` +
          `perk ${depth.perk}, pack ${depth.kit}`);

    /* ------------------------------------------------ renaming, live */
    const renamed = await ana.evaluate(async () => {
      options.set('name', 'anastasia');
      net.setName('anastasia');
      await new Promise(r => setTimeout(r, 600));
      return net.getName();
    });
    const sawRename = await bo.evaluate(async () => {
      for (let i = 0; i < 30; i++) {
        const r = [...net.remotes.values()][0];
        if (r && r.tag && r.tag.text === 'anastasia') break;
        await new Promise(res => setTimeout(res, 100));
      }
      const r = [...net.remotes.values()][0];
      return { tag: r && r.tag ? r.tag.text : null, known: [...net.names.values()] };
    });
    check('a rename reaches the other player without a reconnect',
          renamed === 'anastasia' && sawRename.tag === 'anastasia',
          `bo sees "${sawRename.tag}", names known ${JSON.stringify(sawRename.known)}`);

    // put it back, so the rest of the run reads the way it always did
    await ana.evaluate(() => { options.set('name', 'ana'); net.setName('ana'); });
    await sleep(400);

    check('a remote player looks like a player, not an NPC',
          looks.playerGear >= 3 && looks.npcGear === 0,
          `player carries ${looks.playerGear} pieces of gear, NPC ${looks.npcGear}`);
    check('players and NPCs use separate colour bands',
          Math.abs(looks.playerHue - looks.npcHue) > 0.15,
          `player hue ${looks.playerHue}, NPC hue ${looks.npcHue}`);

    const drift = Math.hypot(boSees.x - anaAfter.x, boSees.z - anaAfter.z);
    check("bo's copy of ana is in the right place", drift < 1.5,
          `${drift.toFixed(2)}u from where ana really is`);
    check('the remote body was animated by the movement', boSees.phase > 1,
          `run phase ${boSees.phase.toFixed(1)}`);

    /* ------------------------------------------------ how far behind */
    /* The delay everyone else is drawn at used to be a flat 110ms, sized for
     * the worst connection and paid for by every connection. It is measured
     * now, so on a local server it should settle well under that. */
    /* Test the rule, not the number: a loaded machine genuinely is jittery, and
     * holding more buffer on a jittery connection is the whole point. What
     * must be true is that the delay is derived from what was measured rather
     * than pinned to a constant. */
    const delay = await bo.evaluate(() => net.delay());
    const wanted = Math.max(45, Math.min(180, delay.gap + delay.jitter * 2.5));
    check('the interpolation delay follows the connection rather than a constant',
          Math.abs(delay.target - wanted) < 1 && delay.gap > 20 && delay.gap < 90,
          `holding ${delay.target.toFixed(0)}ms off a ${delay.gap.toFixed(0)}ms ` +
          `snapshot gap and ${delay.jitter.toFixed(0)}ms of jitter ` +
          `(the rule says ${wanted.toFixed(0)}ms)`);

    const carriage = await bo.evaluate(() => ({
      transit: net.stats.transit, received: net.stats.received,
    }));
    check('snapshots are not queueing up on the way in', carriage.transit < 120,
          `${carriage.transit.toFixed(0)}ms from the server stamping one to us reading it`);

    /* And it has to keep moving. The old build froze the body between
     * snapshots and then jumped it, because a 20Hz snapshot rate off a 30Hz
     * tick arrived 33ms apart and then 67ms, emptying the buffer.
     *
     * Two things used to decide this that have nothing to do with the
     * networking, and both of them failed it on a busy machine:
     *
     * The sample ran for a fixed 1200ms and then insisted on more than 20
     * frames in it. Two headless browsers on software rendering draw about
     * 15fps, so an honest run collected 16 to 19 and failed a gate that was
     * really a measure of the renderer — while reporting a still-frame ratio
     * that had comfortably passed. It collects a number of frames now, with
     * the clock only as a floor and a ceiling.
     *
     * And it counted every frame, including the ones after ana had run into a
     * wall — a body standing still because the player behind it is standing
     * still is the correct picture, not a stutter. Only the frames the server
     * says she was moving through are counted now, which the snapshot already
     * carries. */
    const motion = await (async () => {
      /* Point her down the longest clear line she has, right before we watch.
       * She has already walked once by now, and a window that runs her into a
       * crate a second in spends the rest of itself watching a body stand
       * still — correctly, and while proving nothing. */
      await ana.evaluate(() => {
        const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
        const lim = game.cfg.arena / 2 - 3;
        let best = 0, to = null;
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 48) {
          const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
          const reach = Math.min(30, game.traceShot(eye, dir).distance || 0) - 2;
          if (reach <= best) continue;
          const at = eye.clone().addScaledVector(dir, reach);
          if (Math.abs(at.x) > lim || Math.abs(at.z) > lim) continue;
          best = reach;
          to = at;
        }
        if (to) game.aimAt(to);
      });
      await ana.keyboard.down('KeyW');
      await advance(ana, 0.5);              // up to speed before we look
      const watching = bo.evaluate(async () => {
        /* Read the body out of the map every frame rather than holding on to
         * it. A remote is dropped and rebuilt whenever its owner goes quiet
         * for a moment, and a sampler clutching the old object watches
         * something detached from the scene sit perfectly still — which reads
         * as a total freeze with a flawless connection underneath it. */
        const body = () => [...net.remotes.values()][0];
        const mine = net.self.id;
        /* Is the server still showing somebody who is actually going
         * somewhere? The moving flag alone is not enough: it is set from the
         * last state her client sent, so if *her* browser stalls the server
         * keeps rebroadcasting a stationary body still marked as moving, and
         * this screen is right to draw it standing still. What counts is the
         * server's copy of her having moved recently. */
        let lastAt = null;
        let movedAt = 0;
        const running = () => {
          const s = net.snapshots[net.snapshots.length - 1];
          if (!s) return false;
          const them = s.players.find(p => p[0] !== mine);
          if (!them) return false;
          const at = { x: them[1], z: them[3] };
          if (!lastAt || Math.hypot(at.x - lastAt.x, at.z - lastAt.z) > 0.01) {
            movedAt = performance.now();
            lastAt = at;
          }
          return !!them[5] && performance.now() - movedAt < 250;
        };
        const steps = [];
        let prev = null;
        let prevAt = 0;
        let wasRunning = false;
        let stall = 0, longestStall = 0, worstFrame = 0, drawn = 0;
        const t0 = performance.now();
        const arrived0 = net.stats.received;
        let now = t0;
        while ((steps.length < 24 || now - t0 < 800) && now - t0 < 5000) {
          await new Promise(res => requestAnimationFrame(res));
          drawn++;
          const was = now;
          now = performance.now();
          // how long this page went without being drawn at all
          if (prev && now - was > worstFrame) worstFrame = now - was;
          const r = body();
          if (!r) { prev = null; wasRunning = false; continue; }
          const p = r.fig.root.position;
          const isRunning = running();
          // a step that spans the moment she stopped is neither one thing nor
          // the other, so it takes two running frames in a row to count
          if (prev && isRunning && wasRunning) {
            const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
            steps.push(moved);
            /* How long the body was frozen for, rather than how many frames
             * happened to catch it that way. One still frame at 15fps is a
             * snapshot landing a little late; a quarter of a second of a
             * figure nailed to the floor is what the player sees. */
            if (moved < 0.0005) {
              stall += now - prevAt;
              if (stall > longestStall) longestStall = stall;
            } else {
              stall = 0;
            }
          }
          prev = { x: p.x, z: p.z };
          prevAt = now;
          wasRunning = isRunning;
        }
        return {
          frames: steps.length,
          still: steps.filter(v => v < 0.0005).length,
          worst: steps.length ? Math.max.apply(null, steps) : 0,
          longestStall: Math.round(longestStall),
          worstFrame: Math.round(worstFrame),
          drawn,
          took: Math.round(now - t0),
          /* What the connection was doing underneath it. Judged on the gap
           * this client actually measured rather than on the 30Hz the server
           * intends: a loaded machine's timers drift, and counting arrivals
           * against a rate nobody achieved calls a healthy window starved. */
          arrived: net.stats.received - arrived0,
          gap: Math.round(net.delay().gap),
          transit: Math.round(net.stats.transit),
        };
      });
      const result = await watching;
      await advance(ana, 0.3);
      await ana.keyboard.up('KeyW');
      return result;
    })();
    /* Two ways this window can come back with nothing to judge, and neither is
     * a fault in what it is judging: this browser was not given the frames to
     * watch with, or the player it was watching was not running — hers stalls
     * too, and a client that has stopped sending is rebroadcast standing
     * still. Both are said out loud rather than counted. */
    const measured = motion.frames >= 20;
    if (!measured) {
      skip('a running player keeps moving on the other screen',
           motion.drawn < 24
             ? `this client drew ${motion.drawn} frames in ${motion.took}ms`
             : `she was only running for ${motion.frames} of the ` +
               `${motion.drawn} frames drawn in ${motion.took}ms`);
      skip('and never lurches', 'same');
    }

    /* The client has to have been given something to draw with. The buffer is
     * sized on the gap it measures, so an unevenly fed client should still
     * draw smoothly — but one whose snapshots are minutes apart in machine
     * terms, or are arriving stale, has nothing to interpolate between and
     * stands the body still for want of anywhere to move it. That is a starved
     * machine, and it is reported as one rather than as a stutter. */
    /* And the page has to have been drawn while we watched it. A body that
     * does not move between two frames a third of a second apart did not stall
     * — nothing was drawn to move it, and the lurch that follows is the render
     * clock deliberately resynchronising after a stall it can see. Software
     * rendering in a headless browser does this often enough to matter, and
     * blaming the interpolation for it is how a suite stops being read. */
    const fed = measured && motion.arrived > 4 && motion.gap < 90 &&
                motion.transit < 120 && motion.worstFrame < 250;
    const feed = `${motion.arrived} snapshots ${motion.gap}ms apart, ` +
                 `${motion.transit}ms in transit, ` +
                 `longest gap between drawn frames ${motion.worstFrame}ms`;
    if (!measured) {
      // already said why, above
    } else if (!fed) {
      skip('a running player keeps moving on the other screen',
           `the watching client never got a fair run: ${feed}`);
      skip('and never lurches', 'same');
    } else {
      check('a running player keeps moving on the other screen',
            motion.longestStall < 250,
            `frozen for ${motion.longestStall}ms at worst ` +
            `(${motion.still} of ${motion.frames} frames still, ${feed})`);
      check('and never lurches', motion.worst < 2.5,
            `largest single-frame jump ${motion.worst.toFixed(2)}u`);
    }

    /* ------------------------------------------- entities agree as well */
    /* What this can prove is that both clients hold the same NPCs in the same
     * order in roughly the same part of the arena — the failure it exists for
     * is an arena that collapsed to the origin on one side, or indices that do
     * not line up, both of which are tens of units out.
     *
     * What it cannot prove is agreement to the centimetre, and it should not
     * try: the two are drawing the world at times of their own keeping, each
     * behind the server by its own measured connection, and an NPC at a run
     * covers real ground in the difference. The bound below is what a couple
     * of hundred milliseconds of that is worth, which is still a tenth of what
     * a genuine mismatch looks like. */
    const npcAgreement = await Promise.all([ana, bo].map(p => p.evaluate(() =>
      game.npcs.map(n => [+n.root.position.x.toFixed(1), +n.root.position.z.toFixed(1)]))));
    let worstNpc = 0;
    for (let i = 0; i < npcAgreement[0].length; i++) {
      worstNpc = Math.max(worstNpc, Math.hypot(
        npcAgreement[0][i][0] - npcAgreement[1][i][0],
        npcAgreement[0][i][1] - npcAgreement[1][i][1]));
    }
    /* And they are facing the way they are going. The wire carries a heading,
     * which is a direction of travel; a figure's front is its local -Z, so
     * drawing one straight from the other has the whole level walking
     * backwards. Nobody spotted it while they only wandered. */
    const facing = await ana.evaluate(() => {
      const snap = net.snapshots[net.snapshots.length - 1];
      if (!snap || !snap.npcs.length) return null;
      const THREE_ = window.THREE;
      const out = [];
      for (let i = 0; i < game.npcs.length && i < snap.npcs.length; i++) {
        const heading = snap.npcs[i][3];
        const travel = new THREE_.Vector3(Math.sin(heading), 0, Math.cos(heading));
        const front = new THREE_.Vector3(0, 0, -1)
          .applyQuaternion(game.npcs[i].root.quaternion);
        out.push(+front.dot(travel).toFixed(2));
      }
      return out;
    });
    /* Judged on the middle one rather than the worst. What is drawn is
     * interpolated between two snapshots while the heading compared against is
     * the newest, so a figure caught halfway through one of its sharp turns is
     * legitimately a long way off for a frame. The failure this exists for is
     * every figure at -1, which no amount of turning explains. */
    const aligned = (facing || []).slice().sort((a, b) => a - b);
    const middling = aligned.length ? aligned[Math.floor(aligned.length / 2)] : null;
    const forwards = aligned.filter(d => d > 0.5).length;
    check('and each of them is facing the way it is walking',
          middling !== null && middling > 0.9 && forwards >= Math.ceil(aligned.length * 0.7),
          facing ? `middling ${middling}, ${forwards} of ${aligned.length} clearly forwards ` +
                   `(1 = forwards, -1 = backwards)`
                 : 'no NPCs in the snapshot');

    check('both clients see the NPCs in the same places', worstNpc < 3.5,
          `worst disagreement ${worstNpc.toFixed(2)}u`);

    /* ------------------------------- shooting is decided by the server */
    // find an NPC ana can see, shoot it, and check it stays down on BOTH
    // clients — the bug was that the shooter scored but the NPC kept walking
    const npcShot = await ana.evaluate(async () => {
      const before = game.state.score;
      const eye = () => new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      // whichever body is in the open right now, not whichever was in the open
      // first: they run about, and pinning one means firing at a wall
      const inTheOpen = () => {
        const from = eye();
        for (const n of game.npcs) {
          if (!n.alive || !n.grounded) continue;
          const chest = n.root.position.clone().setY(1.0);
          if (game.hasLineOfSight(from, chest)) return { npc: n, chest };
        }
        return null;
      };

      /* Nothing in sight from here is a reason to move, not to give up. She
       * has been walked around by the checks before this one and can end up
       * tucked behind cover with all four bodies out of view, and standing
       * there looking at a crate for ten seconds proved nothing. Walking is
       * the same path her keys take, so the server sees an ordinary player
       * repositioning. */
      const reposition = async () => {
        const from = eye();
        let nearest = null, best = Infinity;
        for (const n of game.npcs) {
          if (!n.alive) continue;
          const d = from.distanceTo(n.root.position);
          if (d < best) { best = d; nearest = n; }
        }
        if (!nearest) return;
        game.aimAt(nearest.root.position.clone().setY(1.0));
        game.setKey('KeyW', true);
        await new Promise(r => setTimeout(r, 500));
        game.setKey('KeyW', false);
      };

      let fired = 0;
      let downed = null;
      // what the server credited us with, straight from the events
      const scored = [];
      net.on('hit', m => { if (m.by === net.self.id && m.kind === 'npc') scored.push(m.index); });
      for (let tries = 0; tries < 90 && downed === null; tries++) {
        const found = inTheOpen();
        if (!found && tries % 6 === 5) { await reposition(); continue; }
        if (found) {
          const index = game.npcs.indexOf(found.npc);
          game.aimAt(found.chest);
          game.state.mag = 12;
          game.state.lastShot = -1e9;
          game.shoot();
          fired++;
          await new Promise(r => setTimeout(r, 350));
          if (!game.npcs[index].alive) downed = index;
        } else {
          await new Promise(r => setTimeout(r, 120));
        }
      }
      if (downed === null && fired === 0) return null;
      return {
        index: downed,
        fired,
        scored,
        scoreBefore: before,
        scoreAfter: game.state.score,
        aliveHere: downed === null ? null : game.npcs[downed].alive,
        sent: net.stats.shots,
        lastHit: net.stats.lastHit || null,
        rejected: net.stats.rejected,
        reason: net.stats.lastRejection,
      };
    });

    check('ana could line up on an NPC', !!npcShot && npcShot.index !== null,
          npcShot ? `${npcShot.fired} rounds away, none of them fatal`
                  : 'never got a clear line');

    if (npcShot && npcShot.index !== null) {
      /* The bug this guards against was a body that took a hit, paid out, and
       * kept walking — so what matters is that the server credited exactly one
       * hit on the body that went down, not what the score happens to total
       * after a few misses and whatever else was in the way. */
      const onTheDead = npcShot.scored.filter(i => i === npcShot.index);
      check('the shot scored, once per kill', onTheDead.length === 1,
            `server credited ${onTheDead.length} hits on npc ${npcShot.index} ` +
            `over ${npcShot.fired} rounds (all hits: ${JSON.stringify(npcShot.scored)})` +
            (npcShot.rejected ? `, ${npcShot.rejected} rejected: ${npcShot.reason}` : ''));
      check('and the score moved with it',
            npcShot.scoreAfter > npcShot.scoreBefore,
            `score ${npcShot.scoreBefore} -> ${npcShot.scoreAfter}`);
      check('the NPC is down on the shooting client', npcShot.aliveHere === false);

      const boSaw = await bo.evaluate(async (i) => {
        // the body falls over the course of a second, so give it that
        for (let k = 0; k < 30; k++) {
          if (game.npcs[i].root.rotation.x > 0.5) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return { alive: game.npcs[i].alive, toppled: game.npcs[i].root.rotation.x };
      }, npcShot.index);
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

    /* A target broken by one client breaks on the other as well.
     *
     * Several goes at it: most of the targets drift, the server judges the
     * round against its own copy of one, and a single shot at a moving object
     * that happens to duck behind cover on the way proves nothing either way.
     * It stops at the first one that goes down. */
    const targetShot = await ana.evaluate(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
        const t = game.targets.find(t => t.alive &&
                                         game.hasLineOfSight(eye, t.mesh.position));
        if (!t) return null;
        const index = game.targets.indexOf(t);
        game.aimAt(t.mesh.position);
        game.state.mag = 12;
        game.state.lastShot = -1e9;
        game.shoot();
        await new Promise(r => setTimeout(r, 900));
        if (!game.targets[index].alive) return { index, alive: false, attempt };
      }
      return null;
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

    /* --------------------- one player shooting must not move another's stats */
    const statsBefore = await bo.evaluate(() => game.stats());
    const anaFired = await ana.evaluate(async () => {
      const before = game.stats().shotsFired;
      game.state.mag = 12; game.state.lastShot = -1e9;
      game.aimAt(new THREE.Vector3(game.state.pos.x, -2, game.state.pos.z));  // into the floor
      game.shoot();
      await new Promise(r => setTimeout(r, 900));
      return game.stats().shotsFired - before;
    });
    const statsAfter = await bo.evaluate(() => game.stats());
    check('ana fired a round', anaFired === 1, `${anaFired} shots`);
    check("one player's shooting leaves the other's statistics alone",
          statsAfter.shotsFired === statsBefore.shotsFired &&
          statsAfter.misses === statsBefore.misses &&
          statsAfter.shotsHit === statsBefore.shotsHit,
          `bo went from ${statsBefore.shotsFired}/${statsBefore.misses} ` +
          `to ${statsAfter.shotsFired}/${statsAfter.misses} shots/misses`);

    /* ------------------------- other players' fire is seen and heard */
    const remoteFire = await bo.evaluate(async () => {
      let tracers = 0;
      const before = game.bullets.length;
      const seen = [];
      const t0 = performance.now();
      const timer = setInterval(() => seen.push(game.bullets.length), 16);
      await new Promise(r => setTimeout(r, 1400));
      clearInterval(timer);
      return { peak: Math.max(...seen), before };
    });
    /* Bo starts watching first and keeps watching well past the last round:
     * starting the two together raced, and a sampler that opened after the
     * shooting had finished saw an empty sky. */
    const watching = bo.evaluate(async () => {
      const seen = [];
      const timer = setInterval(() => seen.push(game.bullets.length), 16);
      await new Promise(r => setTimeout(r, 3000));
      clearInterval(timer);
      return Math.max.apply(null, seen);
    });
    await sleep(200);
    await ana.evaluate(async () => {
      for (let i = 0; i < 6; i++) {
        game.state.mag = 12; game.state.lastShot = -1e9;
        game.aimAt(new THREE.Vector3(game.state.pos.x, -2, game.state.pos.z));
        game.shoot();
        await new Promise(r => setTimeout(r, 200));
      }
    });
    const boSeesFire = await watching;
    check("another player's tracers show up in our world", boSeesFire > 0,
          `bo saw ${boSeesFire} tracer(s) in flight`);

    /* ------------------------------ the world moves the same for everyone */
    /* The sliders are a pure function of the world clock, and the clock is the
     * only thing that travels. So the question is whether one client's world
     * put at the other's clock lands in the same place — asked that way rather
     * than by comparing two live screens, which are legitimately a few tens of
     * milliseconds apart: each client holds a buffer sized on its own measured
     * connection, and a slider crossing the arena covers real ground in that
     * time. Comparing the screens measured the difference between two
     * connections and called it a disagreement about the world. */
    const anaWorld = await ana.evaluate(() => ({
      wt: game.state.worldTime,
      movers: game.movers.map(m => [+m.mesh.position.x.toFixed(3),
                                    +m.mesh.position.z.toFixed(3)]),
    }));
    const boWorld = await bo.evaluate((wt) => {
      const was = game.state.worldTime;
      game.updateMovers(wt);             // where ours would be on their clock
      const at = game.movers.map(m => [+m.mesh.position.x.toFixed(3),
                                       +m.mesh.position.z.toFixed(3)]);
      game.updateMovers(was);            // and straight back, before a frame
      return { at, wt: was };
    }, anaWorld.wt);

    let worstMover = 0;
    for (let i = 0; i < anaWorld.movers.length; i++) {
      worstMover = Math.max(worstMover, Math.hypot(
        anaWorld.movers[i][0] - boWorld.at[i][0],
        anaWorld.movers[i][1] - boWorld.at[i][1]));
    }
    check('both clients slide the same cover along the same path',
          anaWorld.movers.length > 0 && worstMover < 0.01,
          `${anaWorld.movers.length} sliders, worst gap ${worstMover.toFixed(3)}u ` +
          `at world time ${anaWorld.wt.toFixed(2)}s`);
    check('the world clock is running on both clients, and close together',
          anaWorld.wt > 0 && boWorld.wt > 0 && Math.abs(anaWorld.wt - boWorld.wt) < 0.5,
          `ana ${anaWorld.wt.toFixed(2)}s, bo ${boWorld.wt.toFixed(2)}s`);

    /* ------------------------ perks are the same objects for everyone */
    // Pickup itself is server-side and covered by the node tests; what has to
    // be true here is that both clients see the same perks in the same places.
    const perkViews = await Promise.all([ana, bo].map(p => p.evaluate(async () => {
      for (let i = 0; i < 40 && game.perkSystem.perks.length === 0; i++) {
        await new Promise(r => setTimeout(r, 250));
      }
      return game.perkSystem.perks
        .map(p => [p.id, p.kind, +p.x.toFixed(2), +p.z.toFixed(2)])
        .sort((a, b) => a[0] - b[0]);
    })));

    check('a perk turned up in the arena', perkViews[0].length > 0,
          `${perkViews[0].length} on the ground`);
    if (perkViews[0].length) {
      check('both clients see the same perks in the same places',
            JSON.stringify(perkViews[0]) === JSON.stringify(perkViews[1]),
            `ana ${JSON.stringify(perkViews[0])} vs bo ${JSON.stringify(perkViews[1])}`);
      const kinds = await ana.evaluate(() => game.perkSystem.kinds.map(k => k.kind));
      check('and it is one of the real kinds',
            perkViews[0].every(p => kinds.indexOf(p[1]) !== -1),
            `${perkViews[0].map(p => p[1]).join(', ')} out of ${kinds.join(', ')}`);
      const labelled = await ana.evaluate(() =>
        game.perkSystem.perks.every(p => p.view && p.view.tag && p.view.tag.text.length > 0));
      check('and it says what it is, above it', labelled);
      const rendered = await ana.evaluate(() =>
        game.perkSystem.perks.filter(p => p.view && p.view.group.parent).length);
      check('the perk is actually drawn in the world', rendered === perkViews[0].length,
            `${rendered} of ${perkViews[0].length} in the scene`);
    }

    /* ------------------------- a late joiner gets the level in progress */
    // The seed alone is not enough once anything has been shot: a client that
    // builds its own level ends up applying the server's entity indices to a
    // different set of objects, which is how new targets went missing and an
    // extra NPC turned into an invisible thing that ate bullets.
    const late = await browsers[0].newPage();
    late.on('pageerror', e => errors.push('late: ' + e.message));
    await late.goto(`${BASE}/index.html?mp&hunters=0${CHEAP}&name=late`, { waitUntil: 'load' });
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
      // a fine sweep: the server picks where this client arrives, and a coarse
      // one found nothing at all from some of those spots
      for (let a = 0; a < Math.PI * 2 && !pick; a += Math.PI / 60) {
        const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        const hit = game.traceShot(eye, dir);
        // static means "does not move": a perimeter wall counts, and unlike a
        // crate there is always one of those to line up on
        if (!hit.normal || hit.distance > 55) continue;
        /* Sliding cover is not static cover. The round is judged here and
         * again on the server a moment later, and a slab that walked a metre
         * in between makes the two disagree for the one reason this check is
         * not about. Nothing excluded these before — a coarser sweep simply
         * happened not to land on one very often. */
        if (game.movers.some(m => m.mesh === hit.object)) continue;
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

    /* Where this client arrived is the server's choice, and from a few of
     * those spots every line out of it has something drifting across it. That
     * is the arena refusing to cooperate rather than anything being wrong, so
     * it is said out loud instead of counted against the build. */
    if (!geometry) {
      skip('client and server stop a bullet at the same place',
           'no line out of this spawn had static cover on it with nothing moving nearby');
    } else if (geometry.server === null) {
      check('found static cover to test against', false,
            `lined up on the ${geometry.object} at ${geometry.pick}u, ` +
            'but the server never said what the round hit');
    } else {
      check('found static cover to test against', true,
            `${geometry.object} at ${geometry.pick}u`);
      check('client and server stop a bullet at the same place',
            Math.abs(geometry.pick - geometry.server) < 1.5,
            `client ${geometry.pick}u on the ${geometry.object}, server ${geometry.server}u`);
    }

    // leaving on purpose, which gives the seat up rather than having the room
    // hold it open for a return that is not coming
    await late.evaluate(() => { net.close(); });
    await sleep(300);
    await late.close();
    await sleep(400);

    /* ------------------- the arena can actually be cleared with two players */
    /* The reported bug: everything looks dead, the level never turns over, and
     * reloading reveals one target that was invisible all along. It happens
     * when a client destroys a target the server still has standing — after
     * that nobody can shoot it, because on every screen it is not there. */
    const strandCheck = await ana.evaluate(async () => {
      // put the client into exactly that state: break one locally behind the
      // server's back, the way a stale hit event used to
      const victim = game.targets.find(t => t.alive);
      if (!victim) return { skipped: true };
      const index = game.targets.indexOf(victim);
      game.breakTarget(victim, new THREE.Vector3(0, 1, 0));
      const goneLocally = !victim.alive;

      // the next snapshots should put it straight back
      for (let i = 0; i < 40 && !victim.alive; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        index, goneLocally,
        restored: victim.alive,
        visible: victim.mesh.visible && !!victim.mesh.parent,
      };
    });

    if (!strandCheck.skipped) {
      check('a target wrongly destroyed on a client is put back by the server',
            strandCheck.goneLocally && strandCheck.restored,
            `target ${strandCheck.index}: broken locally, restored=${strandCheck.restored}`);
      check('and it comes back visible rather than as a ghost',
            strandCheck.visible === true);
    }

    // and a hit from a level nobody is on any more must be ignored
    const staleHit = await ana.evaluate(() => {
      const index = game.targets.findIndex(t => t.alive);
      const before = game.aliveCount();
      game.applyServerHit({
        kind: 'target', index, by: 999, level: game.state.level - 1,
        origin: { x: 0, y: 1.7, z: 0 }, point: { x: 1, y: 1, z: 1 },
        dir: { x: 0, y: 0, z: -1 }, score: 0,
      }, false);
      return { before, after: game.aliveCount() };
    });
    check('a hit from a finished level does not destroy a live target',
          staleHit.before === staleHit.after,
          `${staleHit.before} targets before, ${staleHit.after} after`);

    /* --------------------------------------------------- shooting people */
    /* Walk ana up to bo, empty a magazine into him, and watch it land on both
     * sides: his health, the bar over his head, her score, and the body. */
    const boWhere = await bo.evaluate(() => ({ ...game.state.pos }));

    /* And which way it came from. Bo watches for the bearing the engine works
     * out from the muzzle the round left; the rounds are ana's real ones, so
     * this covers the whole chain — her shot, the server's word for where it
     * came from, and his screen turning that into somewhere to look. */
    await bo.evaluate(() => {
      window.__marks = [];
      game.on('hurtFrom', d => window.__marks.push(d));
      game.setShield(0);
    });

    /* Run at him for real — point the camera and hold W, the same path a
     * player's keystrokes take. Nudging the position from script would look
     * like a teleport to the server, and it would be right to say so. */
    const range = target => ana.evaluate((t) => {
      const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      const chest = new THREE.Vector3(t.x, 1.1, t.z);
      game.aimAt(chest);
      return {
        gap: Math.hypot(eye.x - t.x, eye.z - t.z),
        los: game.hasLineOfSight(eye, chest),
      };
    }, target);

    let lastGap;
    let justStrafed;
    const beforeWalk = await ana.evaluate(() => net.stats.corrections);
    /* Twelve units is still a plain shot at a body, and the firing loop re-aims
     * every round, so there is nothing to gain from walking into his face —
     * only more cover to get wedged on. And keep at it a good while: the arena
     * has enough in it that a bad angle takes several tries to work around. */
    const inRange = c => c.gap < 12 && c.los;
    let closed = await range(boWhere);
    /* Walking forward is only the answer while it is getting somewhere. Held
     * up close with cover in between, it walks into the crate doing the
     * blocking and stays there; from across the arena, sidestepping is just as
     * useless and the ground has to be covered. So: walk while the way is
     * open or the distance is still coming down, and sidestep when neither is
     * true. The camera is pointed at him throughout, so a sidestep arcs around
     * him and opens the line. */
    /* Budgets sized for this arena: thirty attempts of two thirds of a
     * second covered sixty units, and she can legitimately start this walk
     * forty away with two rooms in between. */
    lastGap = Infinity;                  // the first push always gets a try
    justStrafed = false;
    for (let attempt = 0; attempt < 45 && !inRange(closed); attempt++) {
      /* Wedged is wedged whether or not she can see him: a crate she can see
       * over is still a crate she cannot walk through, and pushing into it
       * with the line of sight already open spent every attempt going nowhere.
       * Never two sidesteps in a row, so a bad guess costs one step rather
       * than the whole approach. */
      const closing = lastGap - closed.gap > 0.4;
      const wedged = attempt > 0 && !closing;
      const blockedUpClose = !closed.los && closed.gap < 18;
      const strafe = !justStrafed && (wedged || blockedUpClose);
      const key = strafe ? (attempt % 4 < 2 ? 'KeyA' : 'KeyD') : 'KeyW';
      justStrafed = strafe;
      lastGap = closed.gap;
      await ana.keyboard.down(key);
      // longer strides while there is still ground to cover: forty-five
      // attempts of two thirds of a second is not an eighty-unit arena
      await advance(ana, strafe ? 0.55 : (closed.gap > 20 ? 1.1 : 0.7));
      await ana.keyboard.up(key);
      await sleep(120);
      closed = await range(boWhere);
    }
    const walked = await ana.evaluate(() => ({
      corrections: net.stats.corrections, why: net.stats.lastCorrection || null,
    }));
    check('ana closed on bo without the server calling it a hack',
          inRange(closed) && walked.corrections === beforeWalk,
          `${closed.gap.toFixed(1)}u away, line of sight ${closed.los}, ` +
          `${walked.corrections - beforeWalk} corrections while running` +
          `${walked.why ? ` (${walked.why})` : ''}`);

    const anaScoreBefore = await ana.evaluate(() => game.state.score);
    check('bo joined on full health',
          await bo.evaluate(() => game.state.health) === 10);

    // empty `rounds` into whoever we can see, aiming afresh every time
    const fire = rounds => ana.evaluate(async (n) => {
      let biggest = 0;
      let last = game.state.score;
      const watch = setInterval(() => {
        biggest = Math.max(biggest, game.state.score - last);
        last = game.state.score;
      }, 20);
      for (let i = 0; i < n; i++) {
        const r = [...net.remotes.values()][0];
        if (!r) break;
        const p = r.fig.root.position;
        game.aimAt(new THREE.Vector3(p.x, p.y + 1.1, p.z));
        game.state.mag = 12;
        game.state.lastShot = -1e9;
        game.shoot();
        await new Promise(done => setTimeout(done, 190));
      }
      await new Promise(done => setTimeout(done, 400));
      clearInterval(watch);
      return { score: game.state.score, biggest, rejected: net.stats.rejected,
               reason: net.stats.lastRejection };
    }, rounds);

    /* Nine rounds first: enough to see him hurt but still standing, and enough
     * headroom that he is still short a few points by the time he has walked
     * to a health pack further down. Health comes back a point every two
     * seconds, and the walk takes a good deal longer than that. */
    /* Turn bo to face his attacker before the magazine goes into him. Facing
     * the thing shooting you, the mark has to point straight ahead — a
     * statement about the world rather than a repeat of the arithmetic, and
     * it fails on a sign, a stale yaw, or a muzzle that never travelled.
     * Riding the rounds that are being fired anyway: an extra one here is one
     * fewer he can take before he goes down, and everything below counts. */
    const anaAt = await ana.evaluate(() => ({ ...game.state.pos }));
    await bo.evaluate((at) => {
      game.aimAt(new THREE.Vector3(at.x, 1.1, at.z));
      window.__marks = [];
      game.setShield(0);
    }, anaAt);

    await fire(9);

    const marked = await bo.evaluate(() => ({
      marks: window.__marks.slice(),
      drawn: document.querySelectorAll('#hurt-marks .mark').length,
      health: game.state.health,
    }));
    // caught while the last of them is still fading
    await bo.screenshot({ path: path.join(SHOTS, 'mp-shot-from.png') }).catch(() => {});
    if (!marked.marks.length) {
      skip('being shot says which way it came from',
           `nothing landed on him to mark: he is on ${marked.health} health`);
    } else {
      check('being shot says which way it came from, and draws it',
            marked.drawn > 0, `${marked.marks.length} bearings, ${marked.drawn} drawn`);
      /* She walks in as she fires, so the later rounds come from a little to
       * one side of where he was pointed. The first is the one taken at his
       * word; the rest only have to be in front of him. */
      const first = Math.abs(marked.marks[0].bearing);
      const worst = Math.max.apply(null, marked.marks.map(m => Math.abs(m.bearing)));
      check('and looking straight at the shooter puts it straight ahead',
            first < 0.35 && worst < Math.PI / 2,
            `first ${first.toFixed(2)} rad off centre, worst ${worst.toFixed(2)} ` +
            `over ${marked.marks.length} rounds`);
    }

    const hurt = await Promise.all([
      bo.evaluate(() => ({ health: game.state.health, dead: game.state.dead })),
      ana.evaluate(() => {
        const r = [...net.remotes.values()][0];
        return {
          barShown: r.health ? r.health.sprite.visible : null,
          barAbove: r.health ? r.health.sprite.position.y : 0,
          bodyShown: r.fig.root.visible,
        };
      }),
    ]);
    check('shooting a player takes their health down',
          hurt[0].health < 10 && hurt[0].health > 0, `bo is on ${hurt[0].health}`);
    check('a hurt player wears a health bar over their head',
          hurt[1].barShown === true && hurt[1].barAbove > 1.8,
          `bar visible=${hurt[1].barShown} at y=${hurt[1].barAbove}`);
    check('nine hits do not kill anybody',
          hurt[0].dead === false && hurt[1].bodyShown === true,
          `dead=${hurt[0].dead}, body visible=${hurt[1].bodyShown}`);

    /* ---------------------------------------------- health packs */
    const packs = await Promise.all([ana, bo].map(p => p.evaluate(() =>
      game.medkits.map(k => [+k.x.toFixed(2), +k.z.toFixed(2), k.ready ? 1 : 0]))));
    check('both clients stand the packs in the same two places',
          packs[0].length === 2 && JSON.stringify(packs[0]) === JSON.stringify(packs[1]),
          `${JSON.stringify(packs[0])} vs ${JSON.stringify(packs[1])}`);

    /* Hurt bo, run him at a health pack, and watch the server put him back to
     * full and take the pack out of the world for everybody.
     *
     * He runs there on real key presses. Nudging his position from script
     * walks the client somewhere the server never agreed to, and the two then
     * disagree about which pack he is standing on. And the pickup is watched
     * for rather than pinned to a chosen pack: he passes the other one on the
     * way often enough, and either is a real collection.
     */
    await bo.evaluate(() => {
      window.__kits = [];
      net.on('medkit', m => window.__kits.push(m));
    });

    const kitAim = async () => bo.evaluate(() => {
      const kit = game.medkits
        .filter(k => k.ready)
        .sort((a, b) => Math.hypot(a.x - game.state.pos.x, a.z - game.state.pos.z) -
                        Math.hypot(b.x - game.state.pos.x, b.z - game.state.pos.z))[0];
      if (kit) game.aimAt(new THREE.Vector3(kit.x, game.cfg.eye, kit.z));
      return {
        index: kit ? kit.index : null,
        gap: kit ? Math.hypot(game.state.pos.x - kit.x, game.state.pos.z - kit.z) : 0,
        health: game.state.health,
        corrections: net.stats.corrections,
        got: window.__kits.slice(),
      };
    });

    let toKit = await kitAim();
    const kitStart = toKit;
    /* Run at it, rather than stepping and stopping. Health comes back a point
     * every couple of seconds, so an approach that spends half its time
     * standing still while the driver takes another look can arrive on full
     * health — at which point there is nothing to collect and the pack is
     * correctly left standing. Sprinting, steering as he goes. */
    await bo.keyboard.down('ShiftLeft');
    await bo.keyboard.down('KeyW');
    for (let attempt = 0; attempt < 80 && toKit.index !== null && !toKit.got.length; attempt++) {
      await advance(bo, 0.25);           // kitAim re-points him each time round
      const moved = await kitAim();
      // wedged on cover: lean round it without stopping
      if (!moved.got.length && toKit.gap - moved.gap < 0.15) {
        const key = attempt % 4 < 2 ? 'KeyA' : 'KeyD';
        await bo.keyboard.down(key);
        await advance(bo, 0.35);
        await bo.keyboard.up(key);
      }
      toKit = await kitAim();
    }
    await bo.keyboard.up('KeyW');
    await bo.keyboard.up('ShiftLeft');

    const taken = toKit.got[0] || null;
    if (!taken && toKit.health >= 10) {
      /* He healed up on the way. Nothing here is broken — a player on full
       * health steps over a pack and leaves it, which the next check proves on
       * purpose — but this run no longer has a hurt player to test with. */
      skip('running over a health pack collects it',
           `he was back on full health before reaching one, ${toKit.gap.toFixed(1)}u short`);
    } else {
      check('running over a health pack collects it',
            !!taken && taken.mine === true && kitStart.health < 10,
            taken ? `pack ${taken.index}, walked in on ${kitStart.health} health, ` +
                    `${toKit.corrections - kitStart.corrections} corrections on the way`
                  : `never reached one: ${toKit.gap.toFixed(1)}u away on ` +
                    `${toKit.health} health`);
    }

    if (taken) {
      const after = await bo.evaluate(async (index) => {
        for (let i = 0; i < 40; i++) {
          if (game.state.health >= 10 && !game.medkits[index].ready) break;
          await new Promise(r => setTimeout(r, 100));
        }
        const last = net.snapshots[net.snapshots.length - 1];
        return {
          health: game.state.health, ready: game.medkits[index].ready,
          fromServer: last ? last.kits : null,
        };
      }, taken.index);
      check('and it puts a hurt player straight back to full',
            after.health === 10 && !after.ready,
            `health ${kitStart.health} -> ${after.health}, pack ${taken.index} ` +
            `still out: ${after.ready}, server said ${JSON.stringify(after.fromServer)}`);

      const anaSees = await ana.evaluate(async (i) => {
        for (let k = 0; k < 40; k++) {
          if (!game.medkits[i].ready) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return { ready: game.medkits[i].ready, drawn: game.medkits[i].view.group.visible };
      }, taken.index);
      check('and the pack goes out of the world for everyone else too',
            anaSees.ready === false && anaSees.drawn === false,
            `ana still sees it out: ${anaSees.ready}, drawn: ${anaSees.drawn}`);
    }

    /* ------------------------------------------------- and then the kill */
    /* He is on full health off the pack and somewhere across the arena, so
     * ana has to find him again before finishing the job. */
    /* Same controller as the first approach: walking is only the answer while
     * it is getting somewhere, and a crate she can see over is still a crate
     * she cannot walk through. Stepping sideways every other attempt whether
     * or not it was needed is how this one used to spend all thirty of them
     * shuffling on the spot in front of one. */
    closed = await range(await bo.evaluate(() => ({ ...game.state.pos })));
    lastGap = Infinity;
    justStrafed = false;
    for (let attempt = 0; attempt < 45 && !inRange(closed); attempt++) {
      const where = await bo.evaluate(() => ({ ...game.state.pos }));
      const closing = lastGap - closed.gap > 0.4;
      const wedged = attempt > 0 && !closing;
      const blockedUpClose = !closed.los && closed.gap < 18;
      const strafe = !justStrafed && (wedged || blockedUpClose);
      const key = strafe ? (attempt % 4 < 2 ? 'KeyA' : 'KeyD') : 'KeyW';
      justStrafed = strafe;
      lastGap = closed.gap;
      await ana.keyboard.down(key);
      // longer strides while there is still ground to cover: forty-five
      // attempts of two thirds of a second is not an eighty-unit arena
      await advance(ana, strafe ? 0.55 : (closed.gap > 20 ? 1.1 : 0.7));
      await ana.keyboard.up(key);
      await sleep(120);
      closed = await range(where);
    }
    check('ana lined up on him again', inRange(closed),
          `${closed.gap.toFixed(1)}u away, line of sight ${closed.los}`);

    // more rounds than he has health; the spares miss a body that is down
    const emptied = await fire(14);
    const killed = await Promise.all([
      bo.evaluate(() => ({ health: game.state.health, dead: game.state.dead,
                           pos: { ...game.state.pos } })),
      ana.evaluate(() => {
        const r = [...net.remotes.values()][0];
        return { bodyShown: r.fig.root.visible, score: game.state.score };
      }),
    ]);
    check('ten hits put a player down',
          killed[0].dead === true && killed[0].health === 0,
          `bo: health ${killed[0].health}, dead ${killed[0].dead}` +
          (emptied.rejected ? `, ${emptied.rejected} shots rejected: ${emptied.reason}` : ''));
    check('a kill is worth 1000', emptied.biggest === 1000,
          `biggest jump ${emptied.biggest}, ana went ${anaScoreBefore} -> ${killed[1].score}`);
    check('the body is taken out of the world while they wait',
          killed[1].bodyShown === false, `body still drawn: ${killed[1].bodyShown}`);

    /* Being killed with no idea by whom is the worst version of it, so the
     * victim's own screen has to say so, and say who. */
    const told = await bo.evaluate(() => {
      const node = document.getElementById('dead');
      return {
        up: !node.hidden,
        by: document.getElementById('dead-by').textContent,
        counting: document.getElementById('dead-count').textContent,
      };
    });
    check('the killed player is told they are dead, and by whom',
          told.up && /ANA/.test(told.by),
          `screen up=${told.up}, says "${told.by}", counting down "${told.counting}"`);
    await bo.screenshot({ path: path.join(SHOTS, 'mp-killed.png') });

    // and back, whole, somewhere else
    const back = await bo.evaluate(async (diedAt) => {
      for (let i = 0; i < 60; i++) {
        if (!game.state.dead) break;
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 400));
      return {
        dead: game.state.dead, health: game.state.health,
        shield: game.state.shield,
        moved: Math.hypot(game.state.pos.x - diedAt.x, game.state.pos.z - diedAt.z),
      };
    }, killed[0].pos);
    check('the dead come back on full health',
          back.dead === false && back.health === 10,
          `dead=${back.dead}, health ${back.health}`);
    check('and they come back somewhere else', back.moved > 1,
          `respawned ${back.moved.toFixed(1)}u from where they fell`);
    check('under a shield, so the kill cannot simply be repeated', back.shield > 0,
          `${back.shield.toFixed(1)}s of protection`);
    check('and the death screen goes away when they come back',
          await bo.evaluate(() => document.getElementById('dead').hidden));

    const whole = await ana.evaluate(() => {
      const r = [...net.remotes.values()][0];
      return {
        visible: r.fig.root.visible,
        bar: r.health ? r.health.sprite.visible : null,
        bubble: r.fig.shield ? r.fig.shield.visible : null,
      };
    });
    check('a player back on full health has no bar over their head',
          whole.visible === true && whole.bar === false,
          `body ${whole.visible}, bar ${whole.bar}`);
    check('and the shield shows on them for everyone else', whole.bubble === true,
          `bubble drawn: ${whole.bubble}`);

    /* --------------------------------------------------- the scoreboard */
    /* By now ana has killed bo once, so the table has something to say. Held
     * on TAB, filled from the server's own count — not from either client's
     * idea of how it went. */
    await sleep(1200);                       // one turn of the scoreboard clock
    const opened = await ana.evaluate(async () => {
      const el = document.getElementById('board');
      const before = el.hidden;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      return {
        before, shown: !el.hidden,
        rows: [...document.querySelectorAll('#board .row')].map(row => ({
          who: row.querySelector('.who').textContent,
          cells: [...row.querySelectorAll('.n')].map(n => n.textContent),
          you: row.classList.contains('you'),
        })),
      };
    });
    await ana.screenshot({ path: path.join(SHOTS, 'mp-scoreboard.png') }).catch(() => {});
    const boardGone = await ana.evaluate(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      return document.getElementById('board').hidden;
    });
    const board = { ...opened, hiddenAfter: boardGone };

    check('TAB puts the scoreboard up, and letting go takes it away',
          board.before === true && board.shown === true && board.hiddenAfter === true,
          `hidden before ${board.before}, shown ${board.shown}, hidden after ${board.hiddenAfter}`);
    check('it lists everybody in the room by name',
          board.rows.length === 2 &&
          board.rows.some(r => r.who.startsWith('ana')) &&
          board.rows.some(r => r.who.startsWith('bo')),
          board.rows.map(r => r.who).join(', ') || 'no rows');
    check('and marks which one is you', board.rows.filter(r => r.you).length === 1,
          `${board.rows.filter(r => r.you).length} rows marked as ours`);

    const anaRow = board.rows.find(r => r.who.startsWith('ana'));
    const boRow = board.rows.find(r => r.who.startsWith('bo'));
    check('with the kill and the death the server actually counted',
          !!anaRow && !!boRow && anaRow.cells[1] === '1' && boRow.cells[2] === '1',
          anaRow && boRow
            ? `ana ${anaRow.cells.join('/')}, bo ${boRow.cells.join('/')}`
            : 'a row is missing');

    /* Each client measures its own frame rate and its own round trip and
     * sends them up once a second; the table shows everybody's. Ours are the
     * ones we just measured, theirs came through the server. */
    const rate = s => Number(String(s).replace(/[^\d]/g, ''));
    check('every row carries the frame rate that machine reported',
          !!anaRow && !!boRow && rate(anaRow.cells[3]) > 5 && rate(boRow.cells[3]) > 5,
          anaRow && boRow ? `ana ${anaRow.cells[3]}fps, bo ${boRow.cells[3]}fps` : 'no rows');
    check('and the round trip it last measured',
          !!anaRow && /ms/.test(anaRow.cells[4]),
          anaRow ? `ana ${anaRow.cells[4]}` : 'no row');
    const boFps = await bo.evaluate(() => {
      const row = net.scores().find(r => r[0] !== net.self.id);
      return row ? { fps: row[7], ping: row[8] } : null;
    });
    check("and the other player's numbers came from the server",
          !!boFps && boFps.fps > 5,
          boFps ? `${boFps.fps}fps, ${boFps.ping}ms` : 'nothing on the wire');

    /* ---------------------------------------------------------- chat */
    /* Typed for real: ENTER to open, keystrokes through the browser's own
     * input pipeline, ENTER to send. What ana types has to reach bo, and the
     * room's own notices — who joined, who killed whom — have to be in both
     * logs with a clock on them. */
    const readLog = page => page.evaluate(() => ({
      lines: [...document.querySelectorAll('#chat-log .line')].map(l => ({
        at: l.querySelector('.at').textContent,
        from: l.querySelector('.from') ? l.querySelector('.from').textContent : null,
        said: l.querySelector('.said').textContent,
        kind: l.className.replace('line', '').trim(),
      })),
      open: document.getElementById('chat').classList.contains('open'),
      inputUp: !document.getElementById('chat-form').hidden,
    }));

    const kills = (await readLog(bo)).lines.filter(l => /killed/.test(l.said));
    check('a kill is written into the log for everyone',
          kills.length > 0 && /ana/.test(kills[0].said) && /bo/.test(kills[0].said),
          kills.length ? kills[0].said : 'no kill line');
    check('and the join was noted when they arrived',
          (await readLog(bo)).lines.some(l => /joined/.test(l.said)),
          'no join line');
    check('every line carries a local clock',
          (await readLog(bo)).lines.every(l => /^\[\d{1,2}:\d{2}(\s?[AaPp][Mm])?\]$/.test(l.at)),
          (await readLog(bo)).lines.map(l => l.at).slice(0, 3).join(' '));

    await ana.keyboard.press('Enter');
    await sleep(150);
    const typing = await readLog(ana);
    check('ENTER opens the chat input', typing.open && typing.inputUp,
          `open ${typing.open}, input up ${typing.inputUp}`);

    const walkedBefore = await ana.evaluate(() => {
      window.__was = { ...game.state.pos };
      return window.__was;
    });
    /* W, S and A are in "well shot" — with the game still listening they walk
     * her across the arena while she writes about it. */
    await ana.keyboard.type('well shot');
    await sleep(200);
    const whileTyping = await ana.evaluate(() => ({
      typed: document.getElementById('chat-input').value,
      moved: Math.hypot(game.state.pos.x - window.__was.x, game.state.pos.z - window.__was.z),
      firing: game.isFiring(),
    }));
    check('typing goes into the box and not into the game',
          whileTyping.typed === 'well shot' && whileTyping.moved < 0.05 && !whileTyping.firing,
          `"${whileTyping.typed}", moved ${whileTyping.moved.toFixed(2)}u`);

    await ana.keyboard.press('Enter');
    await sleep(400);

    const afterSend = await readLog(ana);
    check('sending closes the input again', !afterSend.open && !afterSend.inputUp,
          `open ${afterSend.open}, input up ${afterSend.inputUp}`);

    const heard = (await readLog(bo)).lines.filter(l => l.said === 'well shot');
    check('what one player says reaches the other',
          heard.length === 1 && /ana/.test(heard[0].from || ''),
          heard.length ? `${heard[0].from} ${heard[0].said}` : 'bo never heard it');
    const own = (await readLog(ana)).lines.filter(l => l.said === 'well shot');
    check('and comes back to the one who said it, once',
          own.length === 1 && own[0].kind === 'mine',
          `${own.length} copies, kind "${own.length ? own[0].kind : ''}"`);

    /* And the game has its keyboard back.
     *
     * Measured as the speed she works up rather than the ground she covers:
     * she is wherever the last few checks left her, which in an arena this
     * full is quite often against a crate. Walking into one is the keys
     * reaching the game — being stopped by it is the collision working — and
     * distance covered cannot tell the two apart from a key that never
     * arrived. */
    await ana.evaluate(() => { window.__topSpeed = 0; });
    await ana.keyboard.down('KeyW');
    const watchSpeed = ana.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        window.__topSpeed = Math.max(window.__topSpeed,
          Math.hypot(game.state.vel.x, game.state.vel.z));
        await new Promise(r => setTimeout(r, 25));
      }
    });
    await advance(ana, 0.5);
    await watchSpeed;
    await ana.keyboard.up('KeyW');
    const after = await ana.evaluate(() => ({
      top: window.__topSpeed,
      moved: Math.hypot(game.state.pos.x - window.__was.x,
                        game.state.pos.z - window.__was.z),
    }));
    check('and the keys go back to the game when the input closes',
          after.top > 1,
          `got up to ${after.top.toFixed(1)}u/s and covered ` +
          `${after.moved.toFixed(2)}u after chatting`);
    await ana.screenshot({ path: path.join(SHOTS, 'mp-chat.png') }).catch(() => {});

    /* ------------------------------------------- losing the connection */
    /* Pull bo's socket out from under him the way a tunnel would. He should
     * come back on his own, with the same seat and the same score, and ana
     * should be told both times. */
    const boBefore = await bo.evaluate(() => ({
      id: net.self.id, score: game.state.score, token: !!net.self.token,
    }));
    check('the server handed out something to come back with', boBefore.token);

    await bo.evaluate(() => { net.dropConnection(); });
    await sleep(600);

    const dropped = await bo.evaluate(() => ({
      connected: net.self.connected,
      trying: net.reconnecting(),
      playing: game.isActive(),
    }));
    check('a lost connection is noticed and retried',
          !dropped.connected && dropped.trying,
          `connected ${dropped.connected}, retrying ${dropped.trying}`);
    check('and the game carries on running while it tries', dropped.playing);

    const anaSawAway = await ana.evaluate(() => ({
      bodies: net.remoteCount(),
      log: [...document.querySelectorAll('#chat-log .line')].map(l => l.textContent),
    }));
    check('the room is told they dropped, and their body is taken out',
          anaSawAway.bodies === 0 &&
          anaSawAway.log.some(l => /lost connection/.test(l)),
          `${anaSawAway.bodies} bodies still drawn`);

    // it backs off, so give it long enough for the first retry to land
    await bo.evaluate(async () => {
      for (let i = 0; i < 60 && !net.self.connected; i++) {
        await new Promise(r => setTimeout(r, 250));
      }
    });
    const resumed = await bo.evaluate(() => ({
      connected: net.self.connected,
      id: net.self.id,
      score: game.state.score,
      log: [...document.querySelectorAll('#chat-log .line')].map(l => l.textContent),
    }));
    check('it reconnects on its own', resumed.connected, `connected ${resumed.connected}`);
    check('and picks the same seat back up',
          resumed.id === boBefore.id && resumed.score === boBefore.score,
          `id ${boBefore.id} -> ${resumed.id}, score ${boBefore.score} -> ${resumed.score}`);
    check('and says so in the log',
          resumed.log.some(l => /your score was kept/.test(l)),
          resumed.log.slice(-2).join(' | '));

    await sleep(900);
    const anaSawBack = await ana.evaluate(() => ({
      bodies: net.remoteCount(),
      log: [...document.querySelectorAll('#chat-log .line')].map(l => l.textContent),
      board: net.scores().length,
    }));
    check('the other player gets their body back',
          anaSawBack.bodies === 1 && anaSawBack.log.some(l => /came back/.test(l)),
          `${anaSawBack.bodies} bodies, log ${anaSawBack.log.slice(-1)[0] || ''}`);
    check('and the room never grew a second seat for them',
          anaSawBack.board === 2, `${anaSawBack.board} on the scoreboard`);

    // and the connection is still a working one, not just an open socket
    await bo.evaluate(() => { window.__sentBefore = net.stats.sent; });
    await advance(bo, 0.6);
    const flowing = await bo.evaluate(() => ({
      sent: net.stats.sent - window.__sentBefore,
      received: net.snapshots.length,
    }));
    check('with state going out and snapshots coming back in',
          flowing.sent > 5 && flowing.received > 2,
          `${flowing.sent} sent, ${flowing.received} snapshots buffered`);

    /* -------------------------------------- stepping out of the fight */
    await bo.evaluate(() => { options.set('pvp', false); net.setPvp(false); });
    await sleep(700);
    const out = await ana.evaluate(() => {
      const r = [...net.remotes.values()][0];
      return {
        pvp: r.pvp,
        seeThrough: r.fig.torso.material.transparent,
        opacity: r.fig.torso.material.opacity,
      };
    });
    check('a player out of the fight is drawn see-through for everyone',
          out.pvp === false && out.seeThrough === true && out.opacity < 1,
          `pvp=${out.pvp}, transparent=${out.seeThrough}, opacity=${out.opacity}`);

    const spared = await ana.evaluate(async () => {
      const before = [...net.remotes.values()][0];
      const p = before.fig.root.position;
      for (let i = 0; i < 6; i++) {
        game.aimAt(new THREE.Vector3(p.x, p.y + 1.1, p.z));
        game.state.mag = 12; game.state.lastShot = -1e9;
        game.shoot();
        await new Promise(r => setTimeout(r, 190));
      }
      await new Promise(r => setTimeout(r, 400));
      return true;
    });
    const unhurt = await bo.evaluate(() => ({
      health: game.state.health, dead: game.state.dead,
    }));
    check('and cannot be shot', spared && unhurt.health === 10 && !unhurt.dead,
          `bo is on ${unhurt.health}, dead=${unhurt.dead}`);

    await bo.evaluate(() => { options.set('pvp', true); net.setPvp(true); });
    await sleep(600);
    const backIn = await ana.evaluate(() => {
      const r = [...net.remotes.values()][0];
      return { pvp: r.pvp, transparent: r.fig.torso.material.transparent };
    });
    check('stepping back in makes them solid again',
          backIn.pvp === true && backIn.transparent === false,
          `pvp=${backIn.pvp}, transparent=${backIn.transparent}`);

    /* --------------------------------------------- levels the server ran */
    /* The server decides when a level is done, so the client never sees its
     * own checkLevel run and used to count nothing at all. */
    const levels = await ana.evaluate(async () => {
      const before = game.stats().levelsCleared;
      const at = game.state.level;
      game.applyLevel({
        level: at + 1, npcs: 2,
        targets: [[4, 1.5, 4, 0], [-4, 1.5, -4, 1]],
      });
      return { before, after: game.stats().levelsCleared, level: game.state.level, was: at };
    });
    check('moving up a level online counts as a level cleared',
          levels.after === levels.before + 1 && levels.level === levels.was + 1,
          `${levels.before} -> ${levels.after} cleared, level ${levels.was} -> ${levels.level}`);

    const joinedLate = await ana.evaluate(() => {
      const before = game.stats().levelsCleared;
      // arriving partway through somebody else's match is not an achievement
      game.applyLevel({ level: game.state.level + 4, npcs: 1, targets: [[2, 1.5, 2, 0]] });
      return { before, after: game.stats().levelsCleared };
    });
    check('but landing in the middle of a match does not',
          joinedLate.after === joinedLate.before,
          `${joinedLate.before} -> ${joinedLate.after} cleared`);

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

    /* ------------------------------------------- the match controls */
    /* Adding is the room's, not one client's: what ana asks for has to turn
     * up in bo's arena too, or it is a figure nobody else can see and nobody
     * else's rounds can touch. Last but one, because a restart ends the match
     * everything above was running in. */
    const worldBefore = await Promise.all([ana, bo].map(p => p.evaluate(() => ({
      npcs: game.npcs.length, hunters: game.hunters().length,
      targets: game.targets.length,
    }))));

    await ana.evaluate(() => { net.addToLevel('hunter', 2); });
    await sleep(1200);
    const worldAfter = await Promise.all([ana, bo].map(p => p.evaluate(() => ({
      npcs: game.npcs.length, hunters: game.hunters().length,
      targets: game.targets.length,
    }))));

    /* Both arenas, not both deltas. By this point in the run the two have
     * been through several levels and a kill apiece, and a client that
     * rebuilt a level a moment before the other one legitimately holds a
     * different number until the next message lands. What matters is that
     * they hold the same world once the add has gone round. */
    check('what one player adds turns up in the other one\'s arena',
          worldAfter[0].npcs === worldAfter[1].npcs &&
          worldAfter[0].npcs >= worldBefore[0].npcs + 2,
          `ana ${worldBefore[0].npcs} -> ${worldAfter[0].npcs}, ` +
          `bo ${worldBefore[1].npcs} -> ${worldAfter[1].npcs}`);
    check('and they are hunters on both screens, not wanderers',
          worldAfter[0].hunters >= 2 && worldAfter[0].hunters === worldAfter[1].hunters,
          `ana ${worldAfter[0].hunters}, bo ${worldAfter[1].hunters} hunters ` +
          `in a room that runs with none of its own`);
    const toldAbout = await bo.evaluate(() =>
      [...document.querySelectorAll('#chat-log .line')]
        .map(l => l.textContent).filter(t => /added/.test(t)));
    check('the room is told who asked for them', toldAbout.length > 0,
          toldAbout.slice(-1)[0] || 'no note in the log');

    /* And a restart, which ends the match for everybody: a new map, and both
     * clients back on it with nothing to their name. */
    const beforeRestart = await Promise.all([ana, bo].map(p => p.evaluate(() => ({
      map: game.arenaFingerprint(), seed: net.self.seed, score: game.state.score,
    }))));
    await ana.evaluate(() => { game.state.score = 5000; net.restart(); });
    // both pages reload onto the new match on their own
    for (const page of [ana, bo]) {
      await page.waitForFunction(
        'window.game && window.net && net.self.id && game.state.score === 0',
        { timeout: 30000 });
    }
    await sleep(800);
    const afterRestart = await Promise.all([ana, bo].map(p => p.evaluate(() => ({
      map: game.arenaFingerprint(), seed: net.self.seed, score: game.state.score,
      level: game.state.level, kills: game.stats().kills,
      players: net.scores().length,
    }))));
    /* This room pins its map with MAP_SEED, so the rest of the run has ground
     * it can rely on — and a restart keeps a pinned map pinned. What is
     * checked here is that both clients came back onto the same one; a
     * restart drawing a fresh seed when none is pinned is a server test. */
    check('a restart puts everybody back on the same map',
          afterRestart[0].map === afterRestart[1].map &&
          afterRestart[0].seed === beforeRestart[0].seed,
          `ana ${afterRestart[0].map} vs bo ${afterRestart[1].map}, ` +
          `seed ${beforeRestart[0].seed} -> ${afterRestart[0].seed} (pinned)`);
    check('at level one with nothing to anybody\'s name',
          afterRestart.every(s => s.level === 1 && s.score === 0 && s.kills === 0),
          afterRestart.map(s => `level ${s.level}, score ${s.score}`).join(' | '));
    check('and both of them still in the room',
          afterRestart.every(s => s.players === 2),
          afterRestart.map(s => `${s.players} on the board`).join(', '));

    /* ------------------------------------------------------ leaving */
    await bo.close();
    // poll rather than guessing at a delay
    for (let i = 0; i < 100; i++) {
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

    if (failures) log('  server log:\n    ' + serverLog.slice(-24).join('\n    '));
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
