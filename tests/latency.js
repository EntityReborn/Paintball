/* How far behind is what you see of somebody else?
 *
 * Starts the server, opens two clients, and runs one of them in a straight
 * line. Both pages record their own trace — the runner where they really are,
 * the watcher where they are drawing them — stamped with Date.now(), which is
 * the same wall clock for both since they are on one machine. Afterwards the
 * two traces are slid against each other to find the offset that lines them
 * up. That offset is the delay a player actually sees.
 *
 * Sampling the two pages "at the same time" from here does not work: each
 * sample is a round trip to a different browser, and the difference between
 * those two round trips lands directly in the answer.
 *
 * A headless browser on a software renderer is slower than any real machine,
 * so treat the number as a ceiling, and as a way of comparing one build
 * against another. `tests/pipeline.js` measures the server on its own, with no
 * browser in the way.
 *
 *   node tests/latency.js
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const CHROME = process.env.CHROME_PATH ||
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = process.env.MP_PORT || 8125;
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE_MS = 5000;

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitForServer(tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      http.get(`${BASE}/healthz`, res => { res.resume(); resolve(); })
        .on('error', () => {
          if (n <= 0) return reject(new Error('server never came up'));
          setTimeout(() => attempt(n - 1), 200);
        });
    };
    attempt(tries);
  });
}

// where the runner was at time t, linearly between samples
function at(trace, t) {
  if (t <= trace[0].t || t >= trace[trace.length - 1].t) return null;
  let lo = 0;
  let hi = trace.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trace[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = trace[lo];
  const b = trace[hi];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

function errorAt(truth, seen, offset) {
  let sum = 0;
  let n = 0;
  for (const s of seen) {
    const real = at(truth, s.t - offset);
    if (!real) continue;
    sum += Math.hypot(real.x - s.x, real.z - s.z);
    n++;
  }
  return n >= 20 ? sum / n : Infinity;
}

/* Slide the watcher's trace back in time until it sits on top of the runner's.
 * The offset with the least error is how far behind they were drawing. */
function bestOffset(truth, seen) {
  let best = { offset: 0, error: Infinity };
  for (let offset = 0; offset <= 600; offset += 2) {
    const error = errorAt(truth, seen, offset);
    if (error < best.error) best = { offset, error };
  }
  return best;
}

(async () => {
  const puppeteer = await import('puppeteer-core');
  const launch = puppeteer.launch || puppeteer.default.launch;

  log('\n== HOW FAR BEHIND YOU SEE ANOTHER PLAYER ==');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MAP_SEED: '4242' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

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
    const open = async (browser, name) => {
      const page = await browser.newPage();
      await page.goto(`${BASE}/index.html?mp&name=${name}`, { waitUntil: 'load' });
      await page.waitForFunction('window.game && window.net && net.self.id', { timeout: 30000 });
      await page.evaluate(() => {
        game.setActive(true);
        document.getElementById('menu').classList.add('hidden');
      });
      return page;
    };

    const runner = await open(browsers[0], 'runner');
    const watcher = await open(browsers[1], 'watcher');
    await sleep(2000);

    /* Point the runner down the longest clear line they have, so they can hold
     * a straight run without hitting anything: a collision partway makes the
     * speed, and therefore the fit, meaningless. */
    await runner.evaluate(() => {
      const eye = new THREE.Vector3(game.state.pos.x, game.cfg.eye, game.state.pos.z);
      let best = null;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 32) {
        const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        const hit = game.traceShot(eye, dir);
        if (!best || hit.distance > best.distance) best = { distance: hit.distance, dir };
      }
      game.aimAt(eye.clone().addScaledVector(best.dir, 50));
    });

    /* Both pages record their own trace. The watcher also notes the
     * frame-to-frame step of the body it is drawing, in the same pass —
     * measuring smoothness after the runner has stopped only ever proves that
     * a stationary figure stands still. */
    const traceRunner = () => runner.evaluate(async (ms) => {
      const out = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        out.push({ t: Date.now(), x: game.state.pos.x, z: game.state.pos.z });
        await new Promise(r => requestAnimationFrame(r));
      }
      return out;
    }, SAMPLE_MS);

    const traceWatcher = () => watcher.evaluate(async (ms) => {
      const out = [];
      const steps = [];
      let prev = null;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const r = [...net.remotes.values()][0];
        if (r && r.last) {
          out.push({ t: Date.now(), x: r.last.x, z: r.last.z });
          const p = r.fig.root.position;
          if (prev) steps.push(Math.hypot(p.x - prev.x, p.z - prev.z));
          prev = { x: p.x, z: p.z };
        }
        await new Promise(res => requestAnimationFrame(res));
      }
      return { out, steps };
    }, SAMPLE_MS);

    await runner.keyboard.down('ShiftLeft');
    await runner.keyboard.down('KeyW');
    await sleep(900);                            // up to speed before sampling

    const [truth, watched] = await Promise.all([traceRunner(), traceWatcher()]);
    const seen = watched.out;
    await runner.keyboard.up('KeyW');
    await runner.keyboard.up('ShiftLeft');

    const inner = await watcher.evaluate(() => {
      const d = net.delay();
      return {
        target: +d.target.toFixed(1), gap: +d.gap.toFixed(1), jitter: +d.jitter.toFixed(1),
        transit: +net.stats.transit.toFixed(0),
        received: net.stats.received,
      };
    });

    // did the runner actually go anywhere? without that the fit means nothing
    let travelled = 0;
    for (let i = 1; i < truth.length; i++) {
      travelled += Math.hypot(truth[i].x - truth[i - 1].x, truth[i].z - truth[i - 1].z);
    }
    const span = (truth[truth.length - 1].t - truth[0].t) / 1000;

    const fit = bestOffset(truth, seen);
    // how sharp the minimum is: a flat curve means the answer is noise
    const away = Math.min(errorAt(truth, seen, fit.offset + 120),
                          errorAt(truth, seen, Math.max(0, fit.offset - 120)));

    log(`  runner covered ${travelled.toFixed(1)}u in ${span.toFixed(1)}s ` +
        `(${(travelled / span).toFixed(1)} u/s), ` +
        `${truth.length} own points against ${seen.length} drawn`);
    log(`  snapshots every ${inner.gap}ms, jitter ${inner.jitter}ms`);
    log(`  server to client, in hand   ${inner.transit}ms`);
    log(`  interpolation delay in use  ${inner.target}ms`);
    log('  ---');
    if (travelled < 10) {
      log('  NO USABLE MEASUREMENT: the runner barely moved');
    } else if (!(away > fit.error * 1.25)) {
      /* The residual never reaches zero — interpolation smooths the path, so
       * the drawn line is not a pure time shift of the real one — but the
       * minimum still has to be a minimum, or the offset is noise. */
      log('  NO USABLE MEASUREMENT: the fit is flat ' +
          `(${fit.error.toFixed(3)}u here, ${away.toFixed(3)}u 120ms away)`);
    } else {
      log(`  SEEN BEHIND REALITY BY      ${fit.offset}ms ` +
          `(residual ${fit.error.toFixed(3)}u, ` +
          `${(away / fit.error).toFixed(2)}x worse 120ms out)`);
    }

    const steps = watched.steps;
    const still = steps.filter(v => v < 0.0005).length;
    log(`  frames the body did not move: ${still} of ${steps.length}`);
    log(`  largest single-frame jump:    ${Math.max(...steps).toFixed(3)}u`);
  } finally {
    for (const b of browsers) await b.close();
    server.kill();
  }
})().catch(err => {
  console.error('latency driver crashed:', err);
  process.exit(2);
});
