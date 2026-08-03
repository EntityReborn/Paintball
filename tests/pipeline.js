/* What does the server itself add?
 *
 * Two raw sockets, no browser. One sends a position moving along a known line;
 * the other reads snapshots and notes when that position comes back out. The
 * gap is everything between "a client said where it was" and "another client
 * could have known" — send quantising, the tick, the snapshot rate, transit —
 * with none of the rendering that a browser puts on top.
 *
 *   node tests/pipeline.js
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.MP_PORT || 8126;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

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

function open(name) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS);
    const client = { socket, id: null, hello: null, snapshots: [] };
    socket.on('open', () => socket.send(JSON.stringify({ t: 'join', name })));
    socket.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.t === 'hello') {
        client.id = msg.id;
        client.hello = msg;
        resolve(client);
      } else if (msg.t === 'snapshot') {
        client.snapshots.push({ at: Date.now(), msg });
      }
    });
    socket.on('error', reject);
  });
}

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
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return a.x + (b.x - a.x) * f;
}

function bestOffset(truth, seen) {
  let best = { offset: 0, error: Infinity, samples: 0 };
  for (let offset = 0; offset <= 400; offset += 1) {
    let sum = 0;
    let n = 0;
    for (const s of seen) {
      const real = at(truth, s.t - offset);
      if (real === null) continue;
      sum += Math.abs(real - s.x);
      n++;
    }
    if (n < 20) continue;
    const error = sum / n;
    if (error < best.error) best = { offset, error, samples: n };
  }
  return best;
}

(async () => {
  log('\n== WHAT THE SERVER PIPELINE ADDS ==');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MAP_SEED: '4242' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  try {
    await waitForServer();
    const mover = await open('mover');
    const looker = await open('looker');
    await sleep(400);

    const eye = mover.hello.you.y;
    const startX = mover.hello.you.x;
    const startZ = mover.hello.you.z;
    const SPEED = 6;                            // units per second, well inside sprint
    const sent = [];
    const t0 = Date.now();
    let dir = 1;

    // walk back and forth along x, sending at the client's own rate
    const timer = setInterval(() => {
      const elapsed = (Date.now() - t0) / 1000;
      let x = startX + dir * SPEED * elapsed;
      if (Math.abs(x - startX) > 8) { dir = -dir; }
      x = startX + Math.sin(elapsed * (SPEED / 8)) * 8;
      sent.push({ t: Date.now(), x });
      mover.socket.send(JSON.stringify({
        t: 'state', x, y: eye, z: startZ, yaw: 0, pitch: 0,
        moving: true, grounded: true, vy: 0,
      }));
    }, 1000 / 60);

    await sleep(4000);
    clearInterval(timer);
    await sleep(300);

    const seen = [];
    for (const s of looker.snapshots) {
      const entry = s.msg.players.find(p => p[0] === mover.id);
      if (entry) seen.push({ t: s.at, x: entry[1] });
    }

    const gaps = looker.snapshots.slice(1)
      .map((s, i) => s.at - looker.snapshots[i].at);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spread = Math.max(...gaps) - Math.min(...gaps);

    const fit = bestOffset(sent, seen);
    log(`  ${sent.length} states sent, ${seen.length} snapshots read`);
    log(`  snapshots arrive every ${mean.toFixed(1)}ms, spread ${spread.toFixed(1)}ms`);
    log(`  ---`);
    log(`  SERVER PIPELINE ADDS  ${fit.offset}ms ` +
        `(fit within ${fit.error.toFixed(3)}u over ${fit.samples} samples)`);

    mover.socket.close();
    looker.socket.close();
  } finally {
    server.kill();
  }
})().catch(err => {
  console.error('pipeline driver crashed:', err);
  process.exit(2);
});
