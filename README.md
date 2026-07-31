# Paintball

A browser first-person shooting range. Walk a walled arena with WASD, look with the
mouse, and shoot the low-poly NPCs running and jumping around the level. Floating
targets — some fixed, some drifting — are bonus score on the side.

## Play

Double-click `index.html`. Nothing to build, no internet needed — three.js is
vendored in `vendor/`.

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | move |
| mouse | look |
| left click | fire (hold for automatic) |
| right click | sight down the barrel (hold) |
| `Shift` | sprint |
| `Space` | jump |
| `R` | reload |
| `Esc` | pause |

**A level ends when every NPC is down.** They do not respawn, so the level is a
hunt; the fresh set that appears belongs to the next level, which has one more
NPC than the last.

| Event | Score |
| --- | --- |
| target broken | +100 |
| NPC down | +250 |
| level complete | +500 |
| shot that hits nothing | −25 |

The score never goes below zero. Every hit and every miss floats a `+100` / `−25`
label at the spot, and the score readout flashes green or red to match.

## Multiplayer

Online play is opt-in — `index.html?mp` joins the server the page came from, and
plain `index.html` still boots offline with its own random map and no server at
all.

```bash
npm start                       # server + client on :8080
```

then open `http://localhost:8080/?mp` in two windows.

**Hybrid authority.** Clients own where they are; the server owns everything
else and checks every position it is told about against the movement rules —
speed, arena bounds, height, pitch. A client that claims to have moved further
than a sprinting player could is rejected and snapped back. This is the part
that keeps a public leaderboard honest without a full authoritative rewrite.

The server hands out the map seed on join, so every client generates a
byte-identical arena from the same code. The NPCs and targets are simulated
server-side and sent in snapshots; clients render everyone else one
interpolation window (110ms) behind arrival so the motion is smooth rather than
arriving in 20Hz steps.

| | |
| --- | --- |
| simulation | 30Hz |
| snapshots | 20Hz |
| client → server | 30Hz position |
| transport | WebSocket, same origin as the page |

```
server/index.js   http + websocket on one port, static client, /healthz
server/room.js    the match: players, plausibility checks, snapshots
server/engine.js  loads the browser engine into node
src/net.js        client socket, snapshot buffer, remote bodies
src/figure.js     the low-poly body, shared by NPCs and remote players
```

`server/engine.js` loads the *same* `src/*.js` files and the *same* vendored
three.js the browser uses — the UMD build works under `require`, and the game
modules are plain IIFEs. `createGame({ headless: true })` skips the renderer,
the viewmodel and anything that touches the DOM, so the server runs the real
simulation rather than a reimplementation of it.

### Deploying to Railway

`railway.json` is set up for it: Nixpacks build, `node server/index.js`, health
check on `/healthz`. The server binds `0.0.0.0:$PORT`, and Railway proxies both
HTTP and the WebSocket upgrade to the same port, so the client and the socket
share an origin. Rooms live in memory, so keep it at one replica until there is
a reason to add room affinity.

## Layout

```
index.html      markup only: HUD, menu, script tags
src/main.js     page wiring — builds the game, drives the HUD and pointer lock
src/style.css   HUD and menu styling
src/game.js     createGame(): composes the modules, owns state, input and the loop
src/world.js    arena floor, perimeter walls, scattered cover
src/targets.js  target spawning, drifting, breaking
src/npcs.js     low-poly figures: build, wander, run and jump animation
src/weapon.js   the viewmodel and its reload animation
src/effects.js  pooled score labels, debris shards, break flashes
src/audio.js    synthesised sound effects
vendor/         three.js r160 (UMD build, loaded as a classic script)
tests/          browser test suite and the end-to-end driver
```

The modules are plain scripts that hang off a `PB` namespace. `createGame` builds
a shared context and passes it to each builder in turn, so the load order in
`index.html` matters.

`src/game.js` is a classic script, not an ES module, on purpose: Chrome refuses to
execute module scripts from `file://` URLs, so a module build would only run behind
a web server.

## Tests

Two layers, both driving the real engine in a real WebGL context.

**Browser suite** (`tests/tests.html`) — 132 tests over bootstrap, world
generation, targets, rendering, movement, collision, shooting, breaking, levels,
input, the reload animation, NPCs, view angles, zoom, drifting targets, scoring,
score indicators, performance, and HUD wiring. Rendering is
checked by reading pixels back off the canvas; input by dispatching real
`KeyboardEvent` / `MouseEvent` objects. Open it in a browser to watch it run, or
let the driver do it.

**End-to-end driver** (`tests/verify.js`) — launches Chrome, runs the suite, then
plays the game through Chrome's own input pipeline (trusted keyboard and mouse
events, real pointer lock) and writes screenshots to `tests/shots/`.

**Server tests** (`tests/server.test.js`) — 12 node tests over the headless
engine, seed determinism, the room's plausibility rules, snapshot cadence and
size, and the static file server's path handling.

**Multiplayer** (`tests/multiplayer.js`) — starts the server, opens two real
Chrome windows against it, walks one player with genuine key presses and checks
the other window sees that movement on the right body in the right place, that
both built the same arena, and that a teleport gets rejected and corrected.

```bash
npm run test:server   # node tests
npm run test:browser  # browser suite + live game
npm run test:mp       # two browsers, one server
npm test              # all three
```

One thing to know if you write more multiplayer tests: each client needs its
**own browser window**. A hidden tab stops running `requestAnimationFrame`, so a
second client in a second tab silently freezes and never processes a snapshot.

```bash
npm run serve
```

then in another shell:

```bash
npm test
```

The driver needs Chrome at the default Windows path; override with `CHROME_PATH`.
It waits on the game clock rather than the wall clock, because headless Chrome
falls back to software rendering and runs at a few frames a second.

## Debugging the view angles

If the camera ever appears to snap, turn the look log on from the console:

```js
game.setLookDebug(true);
// play for a bit, then:
game.lookStats();   // worst single-event angle step, spikes dropped, largest sample
game.lookLog();     // every sample: gap since the last one, dx/dy, resulting yaw/pitch
```

`kind` is `move` for an applied sample, `spike` for one discarded as too large,
`swallow` for the first sample after the pointer locks, and `nonfinite` for a
`NaN`. A large `dx` after a long `gap` is the signature of the cursor leaving and
re-entering the window rather than a real flick.

## Notes on things that bit

- **The world vanished behind the gun.** The viewmodel is drawn in a second pass
  over a cleared depth buffer so it cannot clip into walls. three.js force-clears
  the colour buffer whenever `scene.background` is set — even with `autoClear`
  off — so the second pass was wiping the world every frame. The background is
  detached for that pass.
- **The view snapped.** Three separate causes: the recoil kick added to the pitch
  without re-clamping, so firing while looking up could push the camera past
  vertical and flip it; the pointer lock's first sample carries the jump from
  wherever the cursor was, as does the cursor re-entering an unlocked window; and
  OS pointer acceleration turns a fast flick into a jump, so the lock is now
  requested with `unadjustedMovement`. Every write to the angles goes through one
  clamped path, and samples beyond `lookSpikePx` (500 by default) are discarded
  rather than clamped — clamping still turns the view, just less far.
- **Breaking a target stalled for ~300ms.** Debris shards were only drawn after
  the first break, so three.js compiled their shader mid-frame. All shaders are
  now warmed up at load, the shards are pooled, opaque, and kept out of the shadow
  pass, and the break flash reuses lights that live in the scene permanently
  (adding a light at runtime forces every material in the scene to recompile).
