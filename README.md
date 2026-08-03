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

**A level ends when the arena is clear** — every NPC down *and* every target
broken. NPCs do not respawn, so the level is a hunt; the fresh set that appears
belongs to the next level, which has one more NPC than the last.

| Event | Score |
| --- | --- |
| target broken | +100 |
| NPC down | +250 |
| **player killed** | **+1000** |
| level complete | +500 |
| shot that hits nothing | −25 |

The score never goes below zero. Every hit and every miss floats a `+100` / `−25`
label at the spot, and the score readout flashes green or red to match.

Cover you are standing on carries you with it. The arena has a **balcony**
along one wall — walk up the stairs, shoot from the
rail, or drop through the gap in the middle. A few pieces of cover **slide back
and forth**, and a standing jump clears the low cover.

**Perks** appear from time to time, each wearing its name so you know what you
are running for:

| Perk | Effect | Lasts |
| --- | --- | --- |
| RAPID FIRE | twice the rate of fire | 15s |
| SPRINTER | around half again as fast | 15s |
| BIG CLIP | double the magazine | 15s |
| DOUBLE JUMP | one extra jump in the air | 15s |
| SHIELD | nothing can hurt you | 6s |

Walk over one to collect it; what you are holding is listed above the ammo
readout with the time left. The shield is deliberately the short one — there is
no partial version of not being hurt, and fifteen seconds of it is most of a
firefight.

**Two health packs** stand in the arena, in the same two spots for everyone.
Walk over one while hurt and it puts you straight back to full; it is gone for
twenty-five seconds after that, and then it is back.

Pausing shows the figures in two columns — this session, and every session
before it: accuracy, shots fired, hits and misses, targets broken, NPCs down,
kills and deaths, best streak, longest shot and distance walked (both in feet),
jumps, reloads, time played, share of time sighted, and points per shot. The
lifetime column lives in this browser's local storage and is folded in while you
play, when you pause, and on the way out, so closing the tab does not lose the
last few minutes.

## Multiplayer

Online play is opt-in — `index.html?mp` joins the server the page came from, and
plain `index.html` still boots offline with its own random map and no server at
all.

Other players are easy to pick out: they carry a visor, a pack and a weapon,
wear their name over their head, and are coloured from the cool half of the
wheel. NPCs get the warm half and none of the gear.

**Other players can be shot, and shoot back.** It takes ten hits to put someone
down and the kill is worth 1000. A hurt player wears a health bar over their
head — green, then amber, then red — which appears only once they have taken a
hit, so a full-health player is not advertising anything. Your own health sits
in the bottom-left corner and the screen flashes red when you are hit. Health
comes back on its own at a point every two seconds, and being hit restarts that
wait, so a firefight cannot be won by standing still. The dead get a screen
saying who did it and how long until they are back; they spend two and a half
seconds on the floor — no shooting, no moving, no body in the world for anyone
else to shoot — and come back whole, somewhere clear and well away from whoever
is still standing. Players arrive the same way, so nobody spawns inside anybody
else.

**Three seconds of protection** come with every arrival and every respawn, drawn
as a bubble around the figure. Without it the player who killed you is still
standing where they were, looking at the spot you are about to appear in, and a
respawn is a free second kill.

**Nobody has to fight.** There is a switch in the options: turn it off and you
can neither hurt other players nor be hurt by them, and rounds carry on through
you rather than stopping on you. Everyone else sees you see-through, so it is
obvious at a glance that shooting you is a waste of a round. It takes effect
across the room at once, as does changing your name.

Names and health bars are drawn behind whatever is in front of them. Floating
them over the world regardless would be a wallhack: you could read where
somebody was through solid cover.

```bash
npm start                       # server + client on :8080
```

then open `http://localhost:8080/?mp` in two windows.

A player who has never chosen a name is asked for one before they join — it goes
over their head for everyone else in the room, so it is worth asking for rather
than putting "player" there and hoping. Offline nobody sees it, so nobody is
stopped.

**Each session gets its own map.** When the first player joins an empty room
the world is rebuilt: a new arena, level one, no bodies and nothing left on the
ground from whoever was there before. Anyone joining after that lands in the
match already in progress. Set `MAP_SEED` to pin the arena instead — the match
still resets, but the layout stays put.

**Hybrid authority.** Clients own where they are; the server owns everything
else and checks every position it is told about against the movement rules —
speed, arena bounds, height, pitch. A client that claims to have moved further
than a sprinting player could is rejected and snapped back. This is the part
that keeps a public leaderboard honest without a full authoritative rewrite.

The speed check is a running allowance rather than a per-message one. State
messages do not arrive evenly — a hiccup anywhere along the way delivers three
or four of them in the same millisecond — and judging each against the gap
since the last one found honest players moving "0.85u in 0.001s" and snapped
them back mid-stride. The allowance fills at sprint speed and holds about a
third of a second of running, so a burst spends what the quiet moment before it
earned, and nobody outruns the game over any stretch of time.

**Statistics and perks belong to one player.** Everyone is told about every
shot, because the world has to change for all of them, but only the player who
fired has it counted. Perks are collected server-side and their effects — rate
of fire, movement budget — are applied per player, so one player's rapid fire
does not let anyone else shoot faster.

**Moving cover rides a shared clock.** The sliders are a pure function of world
time, so the only thing that has to travel is the clock itself. Clients take it
from the snapshot stream and never advance it themselves; letting them run their
own clock between snapshots put the same crate two metres apart on two screens.

**Shots are adjudicated by the server.** The client fires, spends the round and
draws the tracer, but what it hit is decided server-side by re-running the same
raycast — against the targets, the NPCs *and* the other players, nearest wins —
with the rate of fire and the shot's origin checked against where the player
actually is. Nobody can shoot themselves, and the dead can neither shoot nor be
shot. Because clients render everyone else an interpolation window
behind, the server rewinds up to 350ms — more if a slow client asks, capped at
700ms — and sweeps between position samples so a running figure cannot slip
through the gaps. The rewind can never reach through cover.

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

## Menus

The pause screen has two panels. Both open without grabbing the pointer, so
reaching for a slider does not drop you into the game.

**Options** — player name, mouse sensitivity, inverted look, master and gunfire
volume, and whether to show names over other players. Everything is kept in
local storage under `paintball.options` and applied the moment it changes.
Values are validated on the way in: storage is editable by hand, and a
sensitivity of zero or a NaN volume would leave the game unplayable.

**Debug** — two overlays that draw the real data structures rather than copies
of them, so if an overlay disagrees with what happens in play, the overlay is
right:

| Overlay | Shows |
| --- | --- |
| hitboxes | what bullets are tested against: NPCs, other players, targets |
| collision wireframes | every collider, coloured by what it belongs to — walls, cover, sliding cover, the balcony |

## Layout

```
index.html      markup only: HUD, menu, script tags
src/main.js     page wiring — builds the game, drives the HUD and pointer lock
src/style.css   HUD and menu styling
src/game.js     createGame(): composes the modules, owns state, input and the loop
src/world.js    arena floor, perimeter walls, scattered cover
src/targets.js  target spawning, drifting, breaking
src/npcs.js     low-poly figures: build, wander, run and jump animation
src/perks.js    pickups and the rules they bend while they last
src/options.js  settings, validated and kept in local storage
src/debug.js    the hitbox and collider overlays
src/ui.js       the pause-screen panels
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

**Browser suite** (`tests/tests.html`) — 243 tests over bootstrap, world
generation, targets, rendering, movement, collision, shooting, breaking, levels,
input, the reload animation, NPCs, view angles, zoom, drifting targets, scoring,
score indicators, player statistics, telling players from NPCs, the balcony,
moving cover, perks, jumping onto cover, settings, the debug overlays, name
tags, health packs, shields, lifetime statistics, performance, and HUD wiring. Rendering is
checked by reading pixels back off the canvas; input by dispatching real
`KeyboardEvent` / `MouseEvent` objects. Open it in a browser to watch it run, or
let the driver do it.

**End-to-end driver** (`tests/verify.js`) — launches Chrome, runs the suite, then
plays the game through Chrome's own input pipeline (trusted keyboard and mouse
events, real pointer lock) and writes screenshots to `tests/shots/`.

**Server tests** (`tests/server.test.js`) — 70 node tests over the headless
engine, seed determinism, the room's plausibility rules, spawn placement,
server-side shot validation and lag compensation, the player-versus-player rules
(ten hits to kill, healing, respawning, spawn protection, the shield, health
packs, opting out of the fight, no shooting yourself or the dead), renaming,
snapshot cadence and size, and the static file server's path handling.

**Menus** (`tests/ui.js`) — drives the pause-screen panels in a real browser:
the buttons open their panels without starting the game, the debug toggles put
real geometry in the scene, settings survive a reload, the lifetime figures
outlive the page, and a player with no name is asked for one before joining.

**Multiplayer** (`tests/multiplayer.js`) — starts the server, opens two real
Chrome windows against it, walks one player with genuine key presses and checks
the other window sees that movement on the right body in the right place, that
both built the same arena, and that a teleport gets rejected and corrected. It
also runs one player at the other and kills them: the health drops on the
victim's own screen, the bar appears over their head on the shooter's, a point
comes back on its own, the tenth hit pays 1000 and takes the body out of the
world, the victim is told who did it, and they return on full health somewhere
else. Then a rename crossing the room, a health pack collected by one player and
gone for both, and somebody stepping out of the fight and back into it.

```bash
npm run test:server   # node tests
npm run test:browser  # browser suite + live game
npm run test:ui       # the pause-screen menus
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
- **Cover was bigger than it looked.** Obstacles were turned by a small random
  angle, but their collider is an axis-aligned box fitted around the mesh, so
  any angle other than a quarter turn makes it larger than the thing you can
  see — 40% larger on average, and 149% for a long thin wall, which is most of
  a body's width of cover you get stopped by without touching. Quarter turns
  only now, which just swap width and depth.
- **Sliding cover could pass through other sliding cover.** Placement checked
  against the static obstacles but never against the other sliders, so two
  could share ground — and a player riding one got handed to the other as it
  crossed underneath.
- **A shot could pass straight through a target dead ahead.** The targets are
  icosahedra, and they sat square to the world, so whole edges lay in the planes
  x=0 and z=0 through the centre. A round fired exactly down one of those axes —
  a player walking a wall does it constantly — met the seam between two
  triangles, and the intersection test dropped both and reported a clean miss.
  One in twelve dead-centre rays missed. The targets are tilted a few degrees
  now, which is invisible and makes it none in five hundred.
- **Honest running was being called a teleport.** State messages do not arrive
  evenly: a hiccup anywhere along the way delivers three or four of them in the
  same millisecond, and the speed check judged each against the gap since the
  last one — finding a player who had moved 0.85u "in 0.001s" and snapping them
  back mid-stride. It is a running allowance now: it fills at sprint speed and
  holds about a third of a second of it, matching the rewind window, so a burst
  spends what the quiet moment before it earned.
- **A shot on a fresh level could miss everything.** `startLevel` spawned the
  targets and NPCs but never put them into world space — the first frame did
  that, which is fine in a browser and wrong on a server, where a round can be
  adjudicated before any frame is drawn.
- **Accuracy climbed past 100%.** A hit on another player was counted twice,
  once where the outcome was applied and once inside the shared `recordHit`.
- **A level could not be finished because one target was invisible.** The
  client only ever synced targets one way — it broke what the server said was
  gone, but had no way to put back one it had destroyed by mistake. A hit
  adjudicated on the previous level, arriving just after the next one was
  built, broke a brand new target through an index that meant something else a
  moment earlier; the server kept it standing, no client could see or shoot it,
  and reloading was the only way out. Hits now carry the level they were judged
  on, and target state follows the server in both directions, so any
  divergence heals itself within a snapshot or two.
- **One player's shooting moved everybody's statistics.** Every client applies
  every hit the server broadcasts, because the target has to break for all of
  them — but it was also running the accounting each time, so accuracy and
  streaks counted shots other people fired. Only the shooter is credited now.
- **Everyone ran about with their backpack in front.** A figure faces its local
  -Z, which is also where a player yaw of zero looks, so the extra half turn on
  remote players pointed them backwards. NPCs had the opposite problem: they
  travel along local +Z, so they needed the half turn nobody had given them.
- **An arena cleared in multiplayer just sat there.** The server broke the
  target but never asked whether that finished the level — only the client's
  local hit path did that, and it is skipped in networked play. NPC kills
  checked, target breaks did not, and targets are usually what goes last.
- **The server built a different arena from the same seed.** The floor texture
  drew 900 speckles from the world RNG — 1800 numbers the headless server never
  drew, because it has no canvas. Every obstacle after that landed somewhere
  else on the server than on the client: invisible cover that stopped bullets
  while players walked through it. Decoration now uses its own randomness, and
  the server sends an arena fingerprint on join that the client checks.
- **Server-side raycasts hit geometry stacked at the origin.** three.js only
  refreshes world matrices while rendering, and the server never renders, so
  the floor stood on its edge and every crate sat unrotated at 0,0,0.
  `scene.updateMatrixWorld(true)` once at build time fixes it.
- **Clients never heard about level changes.** The seed is enough to build the
  first level and nothing after it, so a client kept playing level 1 while the
  server moved on — new targets applied to already-broken ones and never
  appeared, and the extra NPC each level adds existed only server-side. The
  server now sends the level contents on join and on every change.
- **Breaking a target stalled for ~300ms.** Debris shards were only drawn after
  the first break, so three.js compiled their shader mid-frame. All shaders are
  now warmed up at load, the shards are pooled, opaque, and kept out of the shadow
  pass, and the break flash reuses lights that live in the scene permanently
  (adding a light at runtime forces every material in the scene to recompile).
