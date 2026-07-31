/* End-to-end verification driver.
 *
 * Launches a real Chrome, runs the browser test suite, then plays the game
 * through genuine (trusted) keyboard and mouse input from the browser's own
 * input pipeline — not synthetic DOM events — and saves screenshots so the
 * rendering can be checked by eye.
 *
 *   node tests/verify.js [--headful]
 *
 * Requires the static server on http://localhost:8123 (see .claude/launch.json).
 */
const fs = require('fs');
const path = require('path');


const BASE = process.env.BASE_URL || 'http://localhost:8123';
const SHOTS = path.join(__dirname, 'shots');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HEADFUL = process.argv.includes('--headful');

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait for the game clock, not the wall clock. Headless Chrome falls back to
// software rendering and runs at a handful of frames a second, so wall-clock
// waits would test the renderer's speed instead of the game's behaviour.
async function advance(page, seconds, timeout = 60000) {
  const from = await page.evaluate('game.state.elapsed');
  await page.waitForFunction(
    `window.game.state.elapsed >= ${from} + ${seconds}`,
    { timeout, polling: 30 }
  );
}

let failures = 0;
function check(name, ok, detail) {
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function shot(page, name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file });
  return file;
}

(async () => {
  const puppeteer = await import('puppeteer-core');
  fs.mkdirSync(SHOTS, { recursive: true });

  const launch = puppeteer.launch || puppeteer.default.launch;

  const browser = await launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : 'new',
    args: [
      '--window-size=1280,800',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-web-security',      // lets the suite reach into the index.html iframe
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  /* ------------------------------------------------------- 1. test suite */
  log('\n== BROWSER TEST SUITE ==');
  await page.goto(`${BASE}/tests/tests.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__results && window.__results.done', { timeout: 180000 });
  const results = await page.evaluate('window.__results');
  log(`  ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped ` +
      `(${results.total} total)`);
  results.failures.forEach(f => log('  ✕ ' + f));
  failures += results.failed;
  await shot(page, '00-test-suite.png');

  /* ------------------------------------------------- 2. the game itself */
  log('\n== LIVE GAME (real input) ==');
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.game', { timeout: 20000 });

  const fatal = await page.$eval('#fatal', el => !el.hidden);
  check('index.html booted without the fatal banner', !fatal);

  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null;
  });
  check('canvas is present and sized', !!canvas && canvas.w > 0 && canvas.cw > 0,
        canvas ? `${canvas.w}x${canvas.h} css ${canvas.cw}x${canvas.ch}` : 'no canvas');

  const world = await page.evaluate(() => ({
    obstacles: game.obstacleMeshes.length,
    walls: game.wallMeshes.length,
    targets: game.aliveCount(),
    sceneChildren: game.scene.children.length,
  }));
  check('world contains obstacles', world.obstacles > 15, `${world.obstacles} obstacles`);
  check('world is walled', world.walls === 4, `${world.walls} walls`);
  check('targets spawned', world.targets === 10, `${world.targets} targets`);

  await shot(page, '01-menu.png');

  // real trusted click on the menu -> pointer lock -> game becomes active
  await page.mouse.click(640, 400);
  await sleep(500);
  let active = await page.evaluate('game.isActive()');
  if (!active) {
    // headless Chrome can refuse pointer lock; unpause directly so the rest of
    // the run still exercises the real input path
    await page.evaluate('game.setActive(true); document.getElementById("menu").classList.add("hidden")');
    active = await page.evaluate('game.isActive()');
    log('  note: pointer lock unavailable in this Chrome, unpaused directly');
  } else {
    check('clicking the menu locks the pointer and starts play', true);
  }
  await sleep(300);
  await shot(page, '02-in-game.png');

  // pixels actually drawn? render and read back inside one frame, because the
  // live page does not keep its drawing buffer around
  const pixels = await page.evaluate(() => {
    game.render();
    const gl = game.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const seen = new Set();
    let lit = 0;
    for (let i = 0; i < buf.length; i += 4 * 37) {
      seen.add((buf[i] >> 3) + ',' + (buf[i + 1] >> 3) + ',' + (buf[i + 2] >> 3));
      if (buf[i] + buf[i + 1] + buf[i + 2] > 90) lit++;
    }
    return { colors: seen.size, lit, sampled: Math.floor(buf.length / (4 * 37)) };
  });
  check('frame has real scene content', pixels.colors > 20 && pixels.lit > 100,
        `${pixels.colors} distinct colours, ${pixels.lit}/${pixels.sampled} lit samples`);

  /* ----------------------------------------------- 3. keyboard movement */
  // face the emptiest direction: a bare line-of-sight ray is thinner than the
  // player, so pick the heading with the most clearance on both shoulders
  const runway = await page.evaluate(() => {
    const THREE_ = window.THREE;
    game.teleport(0, game.cfg.eye, 0);
    const eye = new THREE_.Vector3(0, game.cfg.eye, 0);
    let best = null, bestClear = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      let clear = 20;
      for (const side of [-0.6, 0, 0.6]) {                 // both shoulders
        const off = new THREE_.Vector3(Math.cos(a) * side, 0, -Math.sin(a) * side);
        for (let d = 2; d <= 20; d += 1) {
          const to = new THREE_.Vector3(Math.sin(a) * d, game.cfg.eye, Math.cos(a) * d).add(off);
          if (!game.hasLineOfSight(eye.clone().add(off), to)) { clear = Math.min(clear, d); break; }
        }
      }
      if (clear > bestClear) { bestClear = clear; best = a; }
    }
    game.aimAt(new THREE_.Vector3(Math.sin(best) * 10, game.cfg.eye, Math.cos(best) * 10));
    return +bestClear.toFixed(1);
  });
  check('found open ground to walk on', runway > 6, `${runway}u of clearance`);

  const before = await page.evaluate(() => ({ ...game.state.pos }));
  await page.keyboard.down('KeyW');
  await advance(page, 0.7);
  await page.keyboard.up('KeyW');
  const afterW = await page.evaluate(() => ({ ...game.state.pos }));
  const movedW = Math.hypot(afterW.x - before.x, afterW.z - before.z);
  check('W key moves the player (real keydown)', movedW > 1.5, `moved ${movedW.toFixed(2)}u`);

  await page.keyboard.down('KeyD');
  await advance(page, 0.6);
  await page.keyboard.up('KeyD');
  const afterD = await page.evaluate(() => ({ ...game.state.pos }));
  const movedD = Math.hypot(afterD.x - afterW.x, afterD.z - afterW.z);
  check('D key strafes (real keydown)', movedD > 1.0, `moved ${movedD.toFixed(2)}u`);

  await page.evaluate('game.teleport(0, game.cfg.eye, 0)');
  await page.keyboard.down('Space');
  await advance(page, 0.2);
  const airborne = await page.evaluate(() => game.state.pos.y);
  await page.keyboard.up('Space');
  check('Space jumps (real keydown)', airborne > 1.9, `eye height ${airborne.toFixed(2)}`);
  await advance(page, 1.5);
  const landed = await page.evaluate(() => game.state.pos.y);
  check('player lands again', Math.abs(landed - 1.7) < 0.05, `eye height ${landed.toFixed(2)}`);
  await shot(page, '03-after-moving.png');

  /* -------------------------------------------------- 4. mouse shooting */
  // aim at a target that is in the clear, then click for real
  // a fixed target for this one: a drifting target moves between aiming here
  // and the click landing, which is a fair miss rather than a bug
  const aimed = await page.evaluate(() => {
    const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
    const t = game.targets.find(t =>
      t.alive && !t.wander && game.hasLineOfSight(eye, t.mesh.position));
    if (!t) return null;
    game.aimAt(t.mesh.position);
    window.__aimTarget = t;
    return { x: t.mesh.position.x, y: t.mesh.position.y, z: t.mesh.position.z };
  });
  check('found a target with clear line of sight', !!aimed,
        aimed ? `(${aimed.x.toFixed(1)}, ${aimed.y.toFixed(1)}, ${aimed.z.toFixed(1)})` : '');
  await sleep(150);
  await shot(page, '04-aiming-at-target.png');

  // The NPCs run around and are solid, so one can legitimately step into the
  // firing line. Retry with a freshly chosen target rather than calling that a
  // failure; every attempt is still a real mouse click.
  let preShot = null, midShot = null, postShot = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    preShot = await page.evaluate(() => {
      game.state.mag = 12;
      const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      const t = game.targets.find(t =>
        t.alive && !t.wander && game.hasLineOfSight(eye, t.mesh.position));
      window.__aimTarget = t || window.__aimTarget;
      if (t) game.aimAt(t.mesh.position);
      return { score: game.state.score, mag: game.state.mag, left: game.aliveCount() };
    });

    // hold the aim while the click is in flight: headless runs at a few frames
    // a second and every target bobs, so a one-shot aim goes stale
    await page.evaluate(() => {
      window.__track = setInterval(() => game.aimAt(window.__aimTarget.mesh.position), 8);
    });
    await page.mouse.down({ button: 'left' });
    await advance(page, 0.05);
    await page.mouse.up({ button: 'left' });
    await page.evaluate('clearInterval(window.__track)');

    midShot = await page.evaluate(() => ({
      mag: game.state.mag, bullets: game.bullets.length, shots: game.state.shotsFired,
    }));
    await advance(page, 1.0);
    postShot = await page.evaluate(() => ({
      score: game.state.score, left: game.aliveCount(), debris: game.debris.length,
    }));
    if (postShot.left === preShot.left - 1) break;
    log(`  (attempt ${attempt + 1}: the shot was blocked, trying another target)`);
    await page.evaluate('game.state.score = 0');
  }

  check('left click fires (real mouse event)', midShot.mag === preShot.mag - 1,
        `magazine ${preShot.mag} -> ${midShot.mag}`);
  check('the bullet broke the target', postShot.left === preShot.left - 1,
        `${preShot.left} -> ${postShot.left} targets`);
  check('breaking scored 100', postShot.score === preShot.score + 100,
        `score ${preShot.score} -> ${postShot.score}`);
  check('the break threw debris', postShot.debris > 5, `${postShot.debris} shards`);
  await shot(page, '05-target-broken.png');

  const hud = await page.evaluate(() => ({
    score: document.getElementById('s-score').textContent,
    left: document.getElementById('s-left').textContent,
    mag: document.getElementById('s-mag').textContent,
    realScore: String(game.state.score),
    realLeft: String(game.aliveCount()),
    realMag: String(game.state.mag),
  }));
  check('HUD matches the game state',
        hud.score === hud.realScore && hud.left === hud.realLeft && hud.mag === hud.realMag,
        `score ${hud.score}, left ${hud.left}, mag ${hud.mag}`);

  /* ------------------------------------------------- 5. holding to fire */
  const magBeforeHold = await page.evaluate('game.state.mag');
  await page.mouse.down({ button: 'left' });
  await advance(page, 0.65);                    // ~5 shots at one per 130ms
  await page.mouse.up({ button: 'left' });
  const auto = await page.evaluate(() => ({ mag: game.state.mag, reloading: game.state.reloading }));
  const burst = magBeforeHold - auto.mag;
  check('holding the button keeps firing', burst >= 4 && burst <= 6,
        `${burst} shots in 0.65s of game time`);

  /* ------------------------------------------------------- 6. reloading */
  await page.evaluate('game.state.mag = 2');
  await page.keyboard.press('KeyR');
  const reloading = await page.evaluate('game.state.reloading');
  check('R starts a reload (real keypress)', reloading === true);
  await advance(page, (1300) / 1000);           // reload runs on game time
  const reloaded = await page.evaluate('game.state.mag');
  check('reload refills the magazine', reloaded === 12, `magazine ${reloaded}`);

  /* --------------------------------------------------- 7. mouse looking */
  const yaw0 = await page.evaluate('game.yawObj.rotation.y');
  await page.mouse.move(640, 400);
  await page.mouse.move(900, 400);          // real movement events
  await sleep(120);
  const yaw1 = await page.evaluate('game.yawObj.rotation.y');
  check('moving the mouse turns the view', Math.abs(yaw1 - yaw0) > 0.01,
        `yaw ${yaw0.toFixed(3)} -> ${yaw1.toFixed(3)}`);
  await shot(page, '06-after-look.png');

  /* -------------------------------------- 8. drifting targets and scoring */
  const drift = await page.evaluate(async () => {
    const t = game.targets.find(t => t.wander && t.alive);
    if (!t) return null;
    const from = t.mesh.position.clone();
    const start = game.state.elapsed;
    while (game.state.elapsed - start < 2.5) await new Promise(r => setTimeout(r, 50));
    return { moved: +t.mesh.position.distanceTo(from).toFixed(2),
             drifters: game.targets.filter(t => t.wander).length };
  });
  check('some targets drift around the level', !!drift && drift.moved > 0.8,
        drift ? `${drift.drifters} drifters, one moved ${drift.moved}u` : 'no drifting targets');

  const miss = await page.evaluate(async () => {
    game.state.score = 500;
    game.teleport(0, game.cfg.eye, 0);
    game.aimAt(new THREE.Vector3(0, -2, 0));        // straight down at the floor
    game.state.lastShot = -1e9; game.state.mag = 12;
    const before = game.state.score;
    game.shoot();
    const start = game.state.elapsed;
    while (game.state.elapsed - start < 1) await new Promise(r => setTimeout(r, 30));
    return { before, after: game.state.score, indicators: game.indicators.length };
  });
  check('a missed shot costs points', miss.after === miss.before - 25,
        `score ${miss.before} -> ${miss.after}`);
  check('a floating label marks the miss', miss.indicators > 0,
        `${miss.indicators} live indicators`);

  const floor = await page.evaluate(async () => {
    game.state.score = 10;
    for (let i = 0; i < 3; i++) {
      game.teleport(0, game.cfg.eye, 0);
      game.aimAt(new THREE.Vector3(0, -2, 0));      // straight down at the floor
      game.state.lastShot = -1e9; game.state.mag = 12;
      game.shoot();
      const start = game.state.elapsed;
      while (game.state.elapsed - start < 0.6) await new Promise(r => setTimeout(r, 30));
    }
    return game.state.score;
  });
  check('the score never goes below zero', floor === 0, `score ${floor}`);
  await shot(page, '07-indicators.png');

  /* ------------------------------------------- 9. finish a level on NPCs */
  const levelBefore = await page.evaluate('game.state.level');
  const npcCount = await page.evaluate('game.npcs.length');
  const afterTargets = await page.evaluate(async () => {
    // clearing every target must NOT end the level
    for (let i = 0; i < 20 && game.aliveCount() > 0; i++) {
      const t = game.targets.find(t => t.alive);
      if (!t) break;
      const p = t.mesh.position;
      game.teleport(p.x + 3, p.y, p.z);
      game.aimAt(p);
      game.state.mag = 12; game.state.lastShot = -1e9;
      game.shoot();
      await new Promise(r => setTimeout(r, 110));
    }
    return { level: game.state.level, targets: game.aliveCount() };
  });
  check('clearing every target does not end the level',
        afterTargets.targets === 0 && afterTargets.level === levelBefore,
        `${afterTargets.targets} targets left, still level ${afterTargets.level}`);

  const levelAfter = await page.evaluate(async () => {
    let completed = 0;
    game.on('levelComplete', () => completed++);
    const level0 = game.state.level;
    for (let i = 0; i < 20 && game.npcsAlive() > 0 && game.state.level === level0; i++) {
      const n = game.npcs.find(n => n.alive);
      if (!n) break;
      game.knockDownNPC(n);
      await new Promise(r => setTimeout(r, 60));
    }
    return { completed, level: game.state.level, npcs: game.npcsAlive(),
             targets: game.aliveCount(), bodies: game.npcs.filter(n => !n.alive).length };
  });
  check('downing every NPC completes the level', levelAfter.completed === 1,
        `${levelAfter.completed} completions, level ${levelBefore} -> ${levelAfter.level}`);
  check('the next level is stocked with new NPCs and targets',
        levelAfter.npcs === npcCount + 1 && levelAfter.targets === 10,
        `${levelAfter.npcs} NPCs, ${levelAfter.targets} targets`);
  check('no NPC respawned into the finished level', levelAfter.bodies === 0,
        `${levelAfter.bodies} bodies carried over`);
  await shot(page, '08-next-level.png');

  /* ------------------------------------- 9b. right button sights the gun */
  const hipFov = await page.evaluate('game.camera.fov');
  await page.mouse.down({ button: 'right' });
  await advance(page, 0.3);
  const sighted = await page.evaluate(() => ({
    fov: +game.camera.fov.toFixed(1),
    gunX: +game.gun.position.x.toFixed(3),
    crosshair: document.getElementById('crosshair').classList.contains('sighted'),
    zooming: game.isZooming(),
  }));
  check('right click sights down the barrel (real mouse button)',
        sighted.zooming && sighted.fov < hipFov - 20,
        `fov ${hipFov} -> ${sighted.fov}`);
  check('the HUD crosshair reacts to the zoom', sighted.crosshair);
  check('the gun comes up to the middle of the view', Math.abs(sighted.gunX) < 0.1,
        `gun x ${sighted.gunX}`);
  await shot(page, '09-sighted.png');

  await page.mouse.up({ button: 'right' });
  await advance(page, 0.3);
  const released = await page.evaluate(() => ({
    fov: +game.camera.fov.toFixed(1),
    crosshair: document.getElementById('crosshair').classList.contains('sighted'),
  }));
  check('releasing the right button comes back out',
        Math.abs(released.fov - hipFov) < 0.5 && !released.crosshair,
        `fov back to ${released.fov}`);

  /* ------------------------------- 10. hunt for view snapping, for real */
  // Sweep the mouse all over the window, including hard into every edge, and
  // watch the recorded angles for a discontinuity.
  await page.evaluate(() => {
    game.state.lookSpikes = 0;
    game.state.maxLookDelta = 0;
    game.setLookDebug(true);
  });

  const w = 1280, h = 800;
  const sweeps = [
    [640, 400], [1279, 400], [640, 400], [0, 400],        // right edge, left edge
    [640, 400], [640, 799], [640, 400], [640, 0],          // bottom edge, top edge
    [1279, 799], [0, 0], [1279, 0], [0, 799],              // corners
  ];
  for (const [x, y] of sweeps) {
    await page.mouse.move(Math.min(x, w - 1), Math.min(y, h - 1), { steps: 12 });
  }
  // a few fast flicks
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(100, 400, { steps: 2 });
    await page.mouse.move(1100, 400, { steps: 2 });
  }

  const lookStats = await page.evaluate(() => {
    const s = game.lookStats();
    const log = game.lookLog();
    // per axis: a diagonal sweep moves both at once and is not a discontinuity
    let worst = 0, worstAt = null;
    for (let i = 1; i < log.length; i++) {
      const d = Math.max(Math.abs(log[i].yaw - log[i - 1].yaw),
                         Math.abs(log[i].pitch - log[i - 1].pitch));
      if (d > worst) { worst = d; worstAt = log[i]; }
    }
    game.setLookDebug(false);
    return { ...s, worstStep: +worst.toFixed(4), worstAt,
             pitch: +game.pitchObj.rotation.x.toFixed(4),
             finite: isFinite(game.yawObj.rotation.y) && isFinite(game.pitchObj.rotation.x) };
  });

  // one event may legitimately turn as far as the spike threshold allows
  const allowed = lookStats.spikeThresholdPx * lookStats.sensitivity;
  check('no angle discontinuity while sweeping the whole window',
        lookStats.worstStep <= allowed,
        `worst single step ${lookStats.worstStep} rad (allowed ${allowed.toFixed(3)}), ` +
        `${lookStats.samples} samples, ${lookStats.spikes} spikes dropped, ` +
        `largest event ${lookStats.maxEventPx}px`);
  check('the view angles stay finite and inside the pitch limit',
        lookStats.finite && Math.abs(lookStats.pitch) < Math.PI / 2,
        `pitch ${lookStats.pitch}`);

  /* ------------------------------------------------------ 9. escape/pause */
  const paused = await page.evaluate(() => {
    game.setActive(false);
    const p0 = { ...game.state.pos };
    game.setKey('KeyW', true);
    for (let i = 0; i < 60; i++) game.update(1 / 60);
    game.setKey('KeyW', false);
    const p1 = { ...game.state.pos };
    return Math.hypot(p1.x - p0.x, p1.z - p0.z);
  });
  check('paused game ignores movement', paused < 0.001, `drifted ${paused.toFixed(4)}u`);

  check('no console errors during play', consoleErrors.length === 0,
        consoleErrors.slice(0, 3).join(' | '));

  log(`\nScreenshots written to ${SHOTS}`);
  log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);

  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('driver crashed:', err);
  process.exit(2);
});
