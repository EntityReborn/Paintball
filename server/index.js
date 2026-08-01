/* Game server: serves the client and runs the match on one port.
 *
 * Railway gives the process a $PORT and proxies both HTTP and WebSocket
 * upgrades to it, so the client and the socket share an origin — no CORS and
 * no separate signalling host.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room.js');
const { ROOT } = require('./engine.js');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// only these directories are reachable, and only inside the project
const SERVE = ['index.html', 'src', 'vendor', 'tests'];

function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\\/g, '/');
  const rel = path.normalize(clean === '/' ? 'index.html' : clean.replace(/^\/+/, ''));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const top = rel.split(path.sep)[0];
  if (!SERVE.includes(top)) return null;
  return path.join(ROOT, rel);
}

// level size can be overridden for tuning and for tests that need a level
// small enough to clear quickly
const gameOverrides = {};
if (process.env.NPCS_PER_LEVEL) gameOverrides.npcsPerLevel = Number(process.env.NPCS_PER_LEVEL);
if (process.env.TARGETS_PER_LEVEL) gameOverrides.targetsPerLevel = Number(process.env.TARGETS_PER_LEVEL);
if (process.env.PERK_EVERY) gameOverrides.perkEvery = Number(process.env.PERK_EVERY);

const room = new Room({
  seed: process.env.MAP_SEED ? Number(process.env.MAP_SEED) : undefined,
  game: gameOverrides,
  onBroadcast: msg => broadcast(msg),
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      players: room.players.size,
      tick: room.tick,
      seed: room.seed,
      uptime: Math.round(process.uptime()),
    }));
  }

  const file = safePath(req.url || '/');
  if (!file) {
    res.writeHead(404);
    return res.end('not found');
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map();          // player id -> socket

function send(socket, msg) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  const raw = JSON.stringify(msg);
  for (const [id, socket] of sockets) {
    if (id === exceptId) continue;
    if (socket.readyState === socket.OPEN) socket.send(raw);
  }
}

wss.on('connection', socket => {
  let player = null;

  socket.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return;                       // ignore anything that is not JSON
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      if (player) return;
      player = room.join(msg.name);
      sockets.set(player.id, socket);
      send(socket, room.hello(player));
      broadcast({ t: 'joined', player: room.publicPlayer(player) }, player.id);
      log(`player ${player.id} (${player.name}) joined — ${room.players.size} in the room`);
      return;
    }

    if (!player) return;            // everything else needs a join first

    if (msg.t === 'state') {
      const res = room.applyState(player.id, msg);
      if (!res.ok && res.correction) send(socket, res.correction);
      return;
    }

    if (msg.t === 'shot') {
      const res = room.applyShot(player.id, msg);
      if (res.ok) broadcast(res.event);          // everyone needs the effects
      else send(socket, { t: 'shotRejected', reason: res.reason });
      return;
    }

    if (msg.t === 'stats') {
      // the client's own accounting, kept for the leaderboard work to come
      player.clientStats = msg.stats;
      return;
    }

    if (msg.t === 'ping') {
      send(socket, { t: 'pong', c: msg.c, now: Date.now() });
    }
  });

  socket.on('close', () => {
    if (!player) return;
    sockets.delete(player.id);
    room.leave(player.id);
    broadcast({ t: 'left', id: player.id });
    log(`player ${player.id} left — ${room.players.size} in the room`);
  });

  socket.on('error', () => { /* close handles the cleanup */ });
});

function log() {
  console.log('[paintball]', ...arguments);
}

room.start();
server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} — map seed ${room.seed}`);
});

function shutdown() {
  log('shutting down');
  room.stop();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, room };
