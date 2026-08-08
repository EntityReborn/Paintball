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
// tests that measure damage to the decimal point need the level's own enemy
// out of the way; 0 leaves the arena to the wanderers
if (process.env.HUNTERS) gameOverrides.hunters = Number(process.env.HUNTERS);

const room = new Room({
  seed: process.env.MAP_SEED ? Number(process.env.MAP_SEED) : undefined,
  game: gameOverrides,
  onBroadcast: msg => {
    // worth a line in the log: these are the moments a match turns on
    if (msg.t === 'medkit') {
      const who = room.players.get(msg.by);
      log(`${who ? who.name : msg.by} took health pack ${msg.index}`);
    }
    // the sweep gave up on somebody who never came back
    if (msg.t === 'left') {
      log(`player ${msg.id} (${msg.name}) did not come back — ${room.players.size} in the room`);
    }
    broadcast(msg);
  },
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

      /* A socket carrying a token is somebody who was already here and lost
       * the connection. If the seat is still theirs they pick it back up with
       * everything in it; if the grace ran out, or the token is somebody's
       * guess, they simply join as a newcomer. */
      const resumed = msg.token ? room.resume(msg.token, msg.name) : null;
      if (resumed) {
        player = resumed;
        room.setPrefs(player.id, msg);
        /* Whatever socket was on this id is gone, but say so rather than
         * assume: two sockets on one seat would both be sent everything and
         * only one of them would ever be read. */
        const stale = sockets.get(player.id);
        if (stale && stale !== socket) stale.close();
        sockets.set(player.id, socket);
        send(socket, room.hello(player));
        broadcast({ t: 'back', player: room.publicPlayer(player) }, player.id);
        log(`player ${player.id} (${player.name}) came back — ${room.players.size} in the room`);
        return;
      }

      const matchesBefore = room.matches;
      player = room.join(msg.name);
      // whichever of mode and pvp the client sent; setPrefs knows both
      room.setPrefs(player.id, msg);
      if (room.matches !== matchesBefore) {
        log(`new match — map seed ${room.seed}`);
      }
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
      if (res.ok) {
        broadcast(res.event);                    // everyone needs the effects
        if (res.event.kind === 'player' && res.event.killed) {
          log(`${res.event.killerName} killed ${res.event.victimName}`);
        }
      } else {
        send(socket, { t: 'shotRejected', reason: res.reason });
      }
      return;
    }

    /* A name or a change of heart about fighting. Both are visible to everyone
     * else — a tag over a head, a translucent body — so both go out at once
     * rather than waiting for whoever it is to reconnect. */
    if (msg.t === 'prefs') {
      const was = { name: player.name, mode: player.mode };
      const out = room.setPrefs(player.id, msg);
      if (!out) return;
      if (out.name !== was.name || out.mode !== was.mode) {
        broadcast(out);
        if (out.name !== was.name) log(`player ${player.id} is now ${out.name}`);
      }
      return;
    }

    /* Somebody typed something. The room decides whether it may be said —
     * what is in it, and how often — and everyone including the sender gets
     * it back from there, so nobody's screen shows a line the others never
     * saw. Turned away quietly, to the sender alone: a rate limit that
     * announces itself to the room is worth spamming for. */
    if (msg.t === 'chat') {
      const res = room.chat(player.id, msg.text);
      if (res.ok) {
        broadcast(res.event);
        log(`${res.event.name}: ${res.event.text}`);
      } else {
        send(socket, { t: 'chatRejected', reason: res.reason });
      }
      return;
    }

    /* Going, and saying so. A socket that simply drops gets its seat kept,
     * because the server cannot tell a tunnel from a closed tab — but a client
     * that is leaving on purpose can say which it is, and then nobody sits on
     * the scoreboard as "away" for a minute after walking off. */
    if (msg.t === 'leave') {
      const going = player;
      sockets.delete(going.id);
      room.leave(going.id);
      broadcast({ t: 'left', id: going.id, name: going.name });
      log(`player ${going.id} (${going.name}) left — ${room.players.size} in the room`);
      player = null;
      socket.close();
      return;
    }

    /* The controls on the pause screen. Anyone in the room may use them —
     * there is no host — so both say who did it, in the chat, where the room
     * can see it. */
    if (msg.t === 'restart') {
      const out = room.restart(player.id);
      log(`${out.name} restarted the match — new map seed ${out.seed}`);
      broadcast(out);
      return;
    }

    if (msg.t === 'add') {
      const out = room.addToLevel(msg.what, msg.count, player.id);
      if (!out) return;
      log(`${out.note.name} added ${out.made} ${out.what}(s)`);
      broadcast(out.note);
      broadcast(out.level);
      return;
    }

    /* A corner pad. Everyone is told, not just the one who stepped on it:
     * somebody vanishing from one corner and appearing in the other is a
     * forty-metre jump, and a client that has not been told treats it as one
     * of the things it is supposed to smooth over. */
    if (msg.t === 'warp') {
      const out = room.warp(player.id, msg.from);
      if (out) broadcast(out);
      return;
    }

    // what their machine is drawing at, for the scoreboard
    if (msg.t === 'fps') {
      room.reportFps(player.id, msg.fps);
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
    // a socket that has already been replaced by a reconnect is not this
    // player's any more, and closing it must not take their seat with it
    if (sockets.get(player.id) === socket) sockets.delete(player.id);
    else return;

    /* The seat is kept for a while rather than cleared: a dropped connection
     * is usually a lid or a tunnel, not somebody leaving. They come out of the
     * world at once — see Room.disconnect — and the room is told they are
     * away. If they do not come back, the sweep in the tick loop says they
     * left, with the name still attached. */
    const gone = room.disconnect(player.id);
    if (!gone) return;
    // the name goes with it: whoever is left has to write a line about them,
    // and by then they may no longer be anywhere to look up
    broadcast({ t: 'away', id: player.id, name: player.name });
    log(`player ${player.id} (${player.name}) dropped — holding their seat`);
  });

  socket.on('error', () => { /* close handles the cleanup */ });
});

function log() {
  console.log('[paintball]', ...arguments);
}

room.start();
server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}` +
      (process.env.MAP_SEED ? ` — map pinned to seed ${room.seed}`
                            : ' — a new map is built for each session'));
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
