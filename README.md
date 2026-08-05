# Paintball

A browser first-person shooting range. Walk a walled arena with WASD, look with the
mouse, and shoot the low-poly NPCs running and jumping around the level. Floating
targets — some fixed, some drifting — are bonus score on the side. One of the
figures is red, and it is looking for you.

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
| `Tab` | scoreboard (hold) |
| `Enter` | chat |
| `Esc` | pause |

**A level ends when the arena is clear** — every NPC down *and* every target
broken. NPCs do not respawn, so the level is a hunt; the fresh set that appears
belongs to the next level, which has one more NPC than the last.

**One of them shoots back.** Every level comes with a hunter — red, armed, and
taking three rounds to put down — and another every four levels after that. See
[The hunter](#the-hunter).

| Event | Score |
| --- | --- |
| target broken | +100 |
| NPC down | +250 |
| **hunter down** (three rounds to put one down) | **+750** |
| **player killed** | **+1000** |
| level complete | +500 |
| shot that hits nothing | −25 |
| being shot, or killed by the hunter | nothing — it costs you health, not points |

The score never goes below zero. Every hit and every miss floats a `+100` / `−25`
label at the spot, and the score readout flashes green or red to match.

## The arena

Eighty units across, walled, with a **balcony** along one wall — walk up the
stairs, shoot from the rail, or drop through the gap in the middle. Cover you
are standing on carries you with it, a few pieces **slide back and forth**, and
a standing jump clears the low cover.

Most of what is scattered about is crates, but a third of it has a way through,
over or under, which is what makes ground worth taking rather than just worth
hiding behind:

| | |
| --- | --- |
| **ramps** | a slope you walk up, cover from the other side |
| **arches** | two posts and a lintel, with headroom to walk under |
| **rooms** | four walls, two or three doorways, no lid |

Rooms are open above on purpose: light reaches inside, and they can be shot
into from the balcony. A roofed box is somewhere safe to stand, which is the
opposite of what cover is for.

**One house per arena**, on a random edge: a room you can go inside with three
doorways, a fence, and a tree. It is the one landmark in a level otherwise made
of scattered crates — somewhere to say "the house" about, and somewhere to be
cornered. The fence is jumpable rather than gated, so it slows an approach and
makes the way in a decision without ever locking anyone out; the gaps between
its panels are too narrow to walk through and wide enough for a round, so
sheltering behind it is harder rather than safe. `house: false` leaves it out.

A ramp is a true triangular prism to look at and a flight of very short steps
to walk on, each one inscribed *under* the slope — never above it, because a
collider poking out of a ramp stops a player in mid-air on nothing. The rise is
an eighth of what a player can step up: at the full step height the climb is a
staircase taken in lurches rather than a slope. The cost is sinking about a
hundredth of the height into the visible surface on the way up, which is a far
better trade than an axis-aligned box around the whole wedge: that is a wall you
can see over and cannot climb. The house's roof is stepped for the same reason.

Nothing is ever spawned into the air inside a room or the house. A target
sealed in one can only be shot through a doorway from exactly the right angle,
if at all — the level cannot be cleared and nothing on screen explains why.

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

## The hunter

Every level has one, on top of the wanderers, and one more every four levels to
a ceiling of four. It is red — the one hue nothing else in the game may use —
and it carries a visor, a pack and a weapon so it reads as something that shoots
back.

**It takes three rounds to put down**, where a wanderer takes one, so the thing
a level is built around is not settled by whoever pulls the trigger first. Once
it has been hit it wears what is left of it, the same bar a hurt player wears;
untouched it shows nothing. Only the round that finishes one pays out or counts
as an NPC down, and it pays 750 against a wanderer's 250.

The hunters are always the first NPCs of a level, because a client rebuilds a
level from a count rather than a list — so which ones come back red has to be
something both sides can work out from the index and the level alone.

**What it knows is a memory, not a feed.** It learns where you are only while
it can actually see you: inside a forward cone, with nothing solid in between,
and within seven tenths of the arena — a distance rather than a fixed number of
units, because the same figure written as "forty-two" saw most of a small map
and a third of a large one. Break the line and it works from where you were and
which way you were going, running that guess on for a couple of seconds and
then walking in on the spot itself. Seven seconds after losing you it gives up
and goes back to patrolling. Standing behind cover is a way out of a fight,
which it would not be if it simply always knew.

**Having seen you it stays on you.** Swapping to whoever is nearest each time
somebody steps behind a crate means fighting nobody, so another player has to
look clearly easier — how far off they are, weighed against how much of them is
left — before it is worth turning away from the one already being worn down.

**Its aim is average on purpose.** A cone that opens with range rather than a
line, and no allowance at all for a target that is moving. Standing in the open
at the range it likes costs about half the rounds it sends; a long shot mostly
does not land. It closes to an eighth of the arena and holds there, sight or no
sight — it never walks into your face, because a hunter you cannot help but
shoot is not one.

Who its rounds hit is settled by whoever owns the players: the room, online,
testing them against the same box a player's round is tested against. Nobody is
credited with those kills and nobody pays for them, and opting out of PvP does
not take you off its list — that setting is an agreement between players, and
the level's own enemy is not one.

| | |
| --- | --- |
| per level | 1, and one more every 4 (`hunters`, `hunterEvery`, `hunterMax` 4) |
| rounds to put down | 3 (`hunterHealth`), against a wanderer's 1 |
| worth | 750 (`scoreHunter`), against a wanderer's 250 |
| sight / field of view | seven tenths of the arena (56u at 80), ±1.15 rad |
| memory / guess | 7s, extrapolated for the first 2.5s |
| aim cone | ±0.11 rad, no leading |
| rate / reaction | one round per 0.8s, 0.45s to open fire |
| speed / standoff | 4.4u/s, holds at an eighth of the arena (10u at 80) |

`index.html?hunters=0` takes it out, which is how the scripted test runs get an
arena where nothing shoots back.

## Dying

Being killed takes everything away until you are put back: no movement, no
turning, no firing, no sights, and the gun goes down. Gravity and whatever you
were standing on still apply, so somebody shot in mid-air comes down rather
than hanging there.

The view falls over half a second from eye height to a foot off the floor and
rolls onto its side, keeping the angle you were looking at when you went down,
and the whole picture goes red. Coming back is a fresh spawn, so the view is
simply upright again.

Offline the world runs that loop itself — you start whole, take damage from the
hunter, go down, and come back after the same delay the server would have used,
somewhere clear of whatever put you down.

**Being shot says which way it came from.** A red flash tells you that you are
being hit and nothing else, which is no use when it came from somewhere you
cannot see. A wedge sits around the crosshair at the bearing the round came
from, fading over a second and a half. It is fixed at the moment of the hit
rather than following the shooter: it marks where the shot came from, not where
they are now, and a mark that swings while you turn to face it is one you can
never line up on. A round stopped by a shield still says where it came from.

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
seconds on the floor — no shooting, no moving, no turning, no body in the world
for anyone else to shoot, and the view down there with them — and come back
whole, somewhere clear and well away from whoever is still standing. Players
arrive the same way, so nobody spawns inside anybody else. See
[Dying](#dying).

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

**Hold `Tab` for the scoreboard**: who is here, their score, kills and deaths,
who is on the floor waiting to come back, who is away, and what their machine
is managing — frames a second and the round trip they last measured. Your own
row is picked out. Offline it lists the one player there is and says why the
rest of the table is empty, because a key that does nothing reads as a broken
key.

The table travels on its own message once a second rather than in the snapshot:
the snapshot carries a score already but no name, kills or deaths, and those
move a handful of times a match. The server sorts it, so every client shows the
same order rather than each inventing its own tie-break.

Frame rate and round trip are each machine's word for itself — nobody else can
see your frame rate, and a round trip is only measurable from the end that
started it — so both are held to a sane range on arrival and nothing depends on
either. Under thirty frames or over a hundred and twenty milliseconds is
coloured.

**Press `Enter` to say something.** The same log carries what the room does
without being asked: who joined, who left, who lost connection and came back,
and who killed whom, including the deaths the hunter hands out. Every line is
stamped in the reader's own local time, while the stamp itself comes from the
server so two people in different places see the same order. Lines fade after a
few seconds and come back in full while the input is open.

The server owns what may be said, because it is other people's text going onto
everyone's screen: control characters out, runs of whitespace collapsed, a
hundred and twenty characters, cut rather than refused. Rate limiting is an
allowance rather than a gap — three in hand, one back every two seconds — so a
burst is conversation and a stream is not, and being turned away is told to the
sender alone. Nothing appears on your own screen until it comes back from the
server, so what you see is what was actually said.

Typing takes the keyboard away from the game entirely rather than pausing it:
"well shot" has W, S and A in it, and a key that still reaches the game is a
player who walks into a wall while writing about it.

**A dropped connection keeps its seat.** The server hands out a token with the
first hello; a socket that goes away has its seat held for forty-five seconds,
and a client that reconnects presents the token to pick it back up — same id,
same score, same kills and deaths. Retries back off from a second to ten over
about a minute, which catches a redeploy quickly without hammering a server
that is down.

They come out of the world the instant the socket goes, though: no body to soak
up rounds or be shot for points, no name over it, no place in a spawn point's
reckoning, nothing to pick a pack or a perk up from, and no healing or
respawning while nobody is driving. They stay on the scoreboard marked AWAY,
because the score is still theirs. Coming back is on the same terms as a
respawn — a moment of protection, and a moment where their own idea of where
they are is not held against them.

Leaving on purpose says so. The server cannot tell a closed tab from a tunnel,
so a client that is going sends word and gives the seat up at once rather than
sitting on the scoreboard for a minute after walking off. If the room emptied
and the match ended while somebody was away, the arena they hold was built from
a seed that no longer applies, and the page reloads rather than papering over
it.

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
match already in progress. Somebody still inside their forty-five seconds of
grace counts as being in the room — their score is being kept for them, and
rebuilding the world underneath it would hand them back a match that no longer
exists. Set `MAP_SEED` to pin the arena instead — the match still resets, but
the layout stays put.

The server takes a few settings from the environment, all of them for tuning
and for tests that need a smaller or quieter world: `MAP_SEED`,
`NPCS_PER_LEVEL`, `TARGETS_PER_LEVEL`, `PERK_EVERY`, and `HUNTERS` (`0` leaves
the arena to the wanderers). The page takes `?hunters=N` and `?shadows=0` for
the same reasons.

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

**One hit volume, defined once.** What a round is tested against is a box
0.52 across, 0.52 deep and 1.68 tall, standing on the figure's soles. Three
places need it — the box hung on the figure, which is what a client raycasts;
the box the server builds for a player; and the one the server rewinds
through — and written out separately they drift, which is a shot that lands on
one screen and not the other. They all read `PB.HIT`.

It hugs the body rather than the pose. The torso measures 0.46 across and the
figure stands from 0.12 to 1.76, so there is very little spare; the old box was
0.72 wide with a hand's width of air under the feet, sized for arms held out
and a leg at the top of its swing. Nobody is shot by the far end of their own
rifle or by a boot thrown out behind them any more — but the flip side is that
a round now has to pass within 26cm of somebody's centre line rather than 36cm.
Square in plan on purpose: the figure turns with its owner and the server's box
does not, so anything else would make a player broader from the side than from
the front.

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
byte-identical arena from the same code. The NPCs and targets — the hunter
among them — are simulated server-side and sent in snapshots; clients render
everyone else one measured interpolation window behind arrival so the motion is
smooth rather than arriving in steps.

| | |
| --- | --- |
| simulation | 30Hz |
| snapshots | 30Hz, one per tick |
| scoreboard | 1Hz, its own message |
| client → server | 60Hz position, 1Hz frame rate and round trip, 5s statistics |
| drawn behind | 45–180ms, measured |
| seat held after a drop | 45s |
| transport | WebSocket, same origin as the page |

The clock everyone else is drawn at advances by the time that actually passed,
not by the frame delta the game hands out — that one is clamped to 50ms so a
hitch cannot fling the player through a wall, which is right for physics and
wrong for a playback clock. A client drawing every 120ms gained 50ms a frame,
fell behind real time by more than half, hit the half-second resynchronisation
and snapped: the other player frozen for a third of a second and then jumping
several metres, on exactly the machines that can least afford it.

**How far behind you see somebody else.** Two things used to make that worse
than it needed to be. Snapshots went out at 20Hz off a 30Hz tick, which does
not divide: they left 33ms apart, then 67ms, then 33ms. And every client held
a flat 110ms buffer, sized for the worst connection and paid for by all of
them — but 110ms was not always enough for that wobble, so a remote player
would freeze for a frame or two and then jump.

Snapshots now go out once per tick, exactly evenly. The buffer is measured
rather than assumed: a client watches how often snapshots arrive and how
unevenly, and holds one interval plus the jitter it is actually seeing, with a
45ms floor. On a local server that settles near 50ms. The clock everyone else
is drawn at runs at wall speed and is eased towards where it should be, rather
than recomputed from the newest arrival every frame — that way one late packet
is a small correction rather than a visible stutter.

Two tools measure it, both under `npm run`:

```bash
npm run test:pipeline   # the server alone, no browser: ~10ms
npm run test:lag        # two real browsers, end to end
```

`test:pipeline` opens two raw sockets, walks one along a known line and reads
the other's snapshots, so it measures exactly what the server adds. `test:lag`
runs two browsers and slides the watcher's trace against the runner's to find
the offset that lines them up. Sampling the two pages "at the same time" from
the driver does not work — each sample is a round trip to a different browser,
and the difference between those two round trips lands straight in the answer.

```
server/index.js   http + websocket on one port, static client, /healthz
server/room.js    the match: players, plausibility checks, snapshots, chat,
                  the scoreboard, and holding a seat for a dropped socket
server/engine.js  loads the browser engine into node
src/net.js        client socket, snapshot buffer, remote bodies, reconnection
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

**Match** — the controls. Add targets, NPCs, hunters or perks to the level
that is running, one to ten at a press; they arrive under the rules a level's
own are placed by, so nothing lands inside cover or sealed in a room. And
restart: a new map, level one, everybody back to nothing and moved somewhere
clear. That takes two presses, because a single misplaced click throws away
the map and every figure in the session. The session's figures go with it; the
lifetime column is kept unless the checkbox says otherwise.

Online both belong to the room rather than to the player who pressed them —
everybody gets the same new map, and a note in the chat names whoever asked
for it. There is no host: anyone in the room may use either, which is worth
knowing before pointing this at a public server. A pinned `MAP_SEED` stays
pinned across a restart.

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
src/world.js    arena: floor, walls, cover, ramps, arches, rooms, the house
src/targets.js  target spawning, drifting, breaking
src/npcs.js     low-poly figures: build, wander, and the hunter that comes for you
src/perks.js    pickups and the rules they bend while they last
src/options.js  settings, validated and kept in local storage
src/debug.js    the hitbox and collider overlays
src/ui.js       the pause-screen panels
src/weapon.js   the viewmodel and its reload animation
src/effects.js  pooled score labels, debris shards, break flashes
src/audio.js    synthesised sound effects
vendor/         three.js r160 (UMD build, loaded as a classic script)
tests/          browser test suite and the end-to-end drivers
tests/chrome.js how every driver launches Chrome, in one place
```

The modules are plain scripts that hang off a `PB` namespace. `createGame` builds
a shared context and passes it to each builder in turn, so the load order in
`index.html` matters.

`src/game.js` is a classic script, not an ES module, on purpose: Chrome refuses to
execute module scripts from `file://` URLs, so a module build would only run behind
a web server.

## Tests

Two layers, both driving the real engine in a real WebGL context.

**Browser suite** (`tests/tests.html`) — 293 tests over bootstrap, world
generation, targets, rendering, movement, collision, shooting, breaking, levels,
input, the reload animation, NPCs, view angles, zoom, drifting targets, scoring,
score indicators, player statistics, telling players from NPCs, the balcony,
moving cover, perks, jumping onto cover, settings, the debug overlays, name
tags, health packs, shields, the hit volume, being dead, the hunter, where a
round came from, the built structures — ramps, arches, rooms and the house —
lifetime statistics, performance, and HUD wiring. Rendering is
checked by reading pixels back off the canvas; input by dispatching real
`KeyboardEvent` / `MouseEvent` objects. Open it in a browser to watch it run, or
let the driver do it.

**End-to-end driver** (`tests/verify.js`) — launches Chrome, runs the suite, then
plays the game through Chrome's own input pipeline (trusted keyboard and mouse
events, real pointer lock) and writes screenshots to `tests/shots/`. It finishes
with a section on the hunter: that every level has one, that it is unmistakably
red and armed, that it finds a player, closes, opens fire and takes health off
them, and that going down offline puts the death screen up and the world brings
you back on its own.

**Server tests** (`tests/server.test.js`) — 99 node tests over the headless
engine, seed determinism, the room's plausibility rules, spawn placement,
server-side shot validation and lag compensation, the player-versus-player rules
(ten hits to kill, healing, respawning, spawn protection, the shield, health
packs, opting out of the fight, no shooting yourself or the dead), the hunter's
rounds (who they may hit, that a kill by one is credited to nobody), the
scoreboard and what each machine reports about itself, chat cleaning and rate
limiting, holding a seat open for a dropped socket and giving it up when the
grace runs out, the hit volume agreeing between client and server, renaming,
snapshot cadence and size, and the static file server's path handling.

**Menus** (`tests/ui.js`) — drives the pause-screen panels in a real browser:
the buttons open their panels without starting the game, the debug toggles put
real geometry in the scene, settings survive a reload, the lifetime figures
outlive the page, a player with no name is asked for one before joining, the
scoreboard and the chat both work offline with nobody else there, and the match
controls add what they say they add and take two presses to restart.

**Multiplayer** (`tests/multiplayer.js`) — starts the server, opens two real
Chrome windows against it, walks one player with genuine key presses and checks
the other window sees that movement on the right body in the right place, that
both built the same arena, that every NPC is facing the way it is walking, and
that a teleport gets rejected and corrected. It also runs one player at the
other and kills them: the health drops on the victim's own screen, the bar
appears over their head on the shooter's, the mark on his screen points back at
her, a point comes back on its own, the tenth hit pays 1000 and takes the body
out of the world, the victim is told who did it, and they return on full health
somewhere else. Then the scoreboard on `Tab` with the frame rate and round trip
each client reported, a message typed with real keystrokes reaching the other
window (and W, S and A not walking the typist across the arena), a socket pulled
out from under one client and reconnecting on its own to the same seat, a rename
crossing the room, a health pack collected by one player and gone for both, and
somebody stepping out of the fight and back into it.

```bash
npm run test:server   # node tests
npm run test:browser  # browser suite + live game
npm run test:ui       # the pause-screen menus
npm run test:mp       # two browsers, one server
npm test              # all three
```

The whole suite — server, browser, menus, two-browser multiplayer — runs in
about 95 seconds.

Two things to know if you write more multiplayer tests. Each client needs its
**own browser window**: a hidden tab stops running `requestAnimationFrame`, so a
second client in a second tab silently freezes and never processes a snapshot.

And the drivers use **hardware GL**, from one place (`tests/chrome.js`). They
used to force `--use-angle=swiftshader`, which rasterises every pixel on the
CPU — on a machine with a GPU that is 13fps against 144, and since every wait in
the suite is on the game clock the whole thing ran at a thirteenth of speed. It
was not only slow: a client drawing at 13fps cannot drain its own socket between
frames, so it processed a third of the snapshots it was sent and the networking
tests spent their time measuring the renderer, failing on whichever check caught
the machine at its worst. `SOFTWARE_GL=1` puts the old behaviour back for a
machine with no GPU at all.

A check that genuinely cannot run — the arena offering no clear line to line up
on, or a starved client that never got the frames to watch with — says so and
says which, rather than failing. A suite that fails half the time stops being
read.

```bash
npm run serve
```

then in another shell:

```bash
npm test
```

The driver needs Chrome at the default Windows path; override with `CHROME_PATH`.
It waits on the game clock rather than the wall clock: a wall-clock wait
measures how fast the machine draws rather than what the game did with the
time, which matters most under `SOFTWARE_GL=1`.

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
- **A ramp you could see straight through.** Its faces were wound the wrong
  way round, so with front-facing materials — which everything in the scene
  uses — most of them were simply not drawn, and what was left was the inside
  of the far side. Its bottom face also lay in the same plane as the floor and
  flickered against it from across the arena; there is nothing under a ramp to
  see, so it does not have one now.
- **NPCs walked through cover.** They never had collision at all: they steered
  with a raycast on a think tick a few times a second, which turns them away
  from most things most of the time, and in between they walked straight
  through whatever was there. Easy to miss on a wanderer clipping the corner of
  a crate, impossible to miss on a hunter coming at you through a wall. They
  are resolved against the same box list the player is now, with the same
  step-up allowance, and gravity runs every frame rather than only while
  airborne — otherwise a figure that walks off a crate never comes down.
- **A target could be sealed inside a room.** Nothing stopped one being spawned
  in the air inside four walls, where it can only be shot through a doorway
  from exactly the right angle. Rooms record their own interior now.
- **A room reached into the middle of the map.** Cover was placed as though
  every piece were a crate — a fixed seven-unit clearance around the spawn,
  measured to the centre of the thing being placed. That is fine for something
  two units across and not for something eight, which is how two players ended
  up unable to shoot each other across the arena's own start point.
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
- **And every NPC in a networked game walked backwards for months.** The same
  fact, in the one place it had not been written down. The wire carries a
  heading — a direction of travel — and the client drawing from a snapshot
  applied it straight to the figure's rotation, half a turn from where it
  should have been. Nobody noticed while they only wandered aimlessly; it was
  unmissable the moment one of them started walking at people. The half turn
  now lives in `figure.js` next to the fact it depends on, and both the engine
  and the client go through it.
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
- **Being shot at cost the player points.** A round somebody else fired — a
  hunter's, offline — travelled as an ordinary bullet and was resolved through
  our own accounting when it landed, which counted it as our miss and took the
  price of one off our score. A round that was never ours settles nothing of
  ours either way now.
- **A death took nothing away.** Until recently being killed meant a caption
  and nothing else: you could still run, turn and shoot while the server was
  refusing every word of it. Everything is taken away now, and the view falls
  to the floor so it reads as a death rather than as the game freezing.
- **The test suite was measuring the renderer.** Every driver forced software
  rasterisation on a machine with a GPU. It made the suite thirteen times
  slower and, worse, starved each client's socket so the networking tests were
  really frame-rate tests — they failed a different check most runs, which is
  how a suite stops being trusted. See [Tests](#tests).
- **A remote player froze and then jumped, on slow clients only.** The
  interpolation clock advanced by the game's frame delta, which is clamped at
  50ms so a hitch cannot fling the player through a wall. Right for physics,
  wrong for a playback clock: a client drawing every 120ms fell behind real
  time by more than half and then hit the half-second resynchronisation.
