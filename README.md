# BOPBALL FC ⚽

A 4v4-plus-goalies arcade cage-soccer prototype with original characters ("beans")
and a hand-written engine. Electric fence, big hits, one-timers, charged shots,
golden-goal overtime.

**This is a prototype test build, and it is finished as far as this repo goes.** It
is a WebGL proof-of-concept with working online netcode, published as a snapshot
rather than an actively maintained project. Later work on this game (new art
direction, a Three.js renderer, redesigned venues) happened elsewhere and is not
here — what you are looking at is the last version of the original WebGL line.

## Take it and do whatever you want

**Free use. Copy it, fork it, modify it, ship it, sell it, learn from it, tear it
apart.** No attribution required, no strings. If some corner of it is useful to
you — the netcode, the renderer, the deterministic sim — help yourself.

It is provided as-is with no warranty and no support.

## Zero dependencies

There is no `npm install`, no CDN, no build toolchain and no framework. Node's
standard library and a browser is the whole requirement.

- **`mini3d.js`** — a ~800-line hand-written WebGL renderer with a Three.js-shaped
  API. WebGL2 with a WebGL1 fallback, accumulating lights, point lights with real
  falloff, additive blending, sorted transparency, multi-pass rendering.
- **`server.js`** — RFC6455 WebSocket implemented by hand on top of `node:http`.
  Same process serves the static files and runs the authoritative match.

## Play it

**Single player, no install:** double-click **`dist/bopball-fc.html`**. The entire
game is in that one file and runs offline from `file://`.

**With the dev server:**

```bash
node server.js        # → http://localhost:8470
```

Modes: Exhibition vs AI (Rookie / Pro / Superstar / Legend), Cup Run, Practice
arena (solo tuning mode — no clock, ball returns to your feet after every goal,
spawnable dummies, live shot/pass readout), and online multiplayer.

Build your lineup bean by bean — six archetypes, four trait points each across
Speed / Shot / Hit / Tackle / Passing — and it persists between sessions.

### Controls

Two schemes, chosen in the **Controls** menu. Everything is rebindable (keyboard
and gamepad) and saved.

**Mouse aim (default):** WASD move · **LMB** pass toward the cursor (or click near
a teammate while defending to take control of them) · **RMB** hold to charge,
release to shoot at the cursor · **Space** deke / big hit · **Q** or middle-click
lob modifier · **Shift** sprint. A reticle shows where you are aiming.

**Classic:** WASD move · **J** pass / switch · **K** shoot (hold to charge) /
slide · **L** deke / big hit · **U** lob · **Shift** sprint.

**F3** toggles the netgraph in an online match.

## Online multiplayer

```bash
node server.js
```

One player picks **ONLINE → Host match** and shares the 5-letter code; others
**Join**. Empty slots are filled by AI, and a player who drops hands their bean
straight back to the AI. Works over LAN with your machine's IP, or over the
internet via a VPS, port-forward or a tunnel.

**Note: the Vercel deployment is single-player only.** Vercel serves this repo as
static files, and multiplayer needs the WebSocket server, so you have to run
`node server.js` somewhere for online play.

### What the netcode actually does

This is the part most worth stealing. It was built and debugged against real
players on a real connection, and most of it is not obvious.

- **Authoritative 60Hz server, 60Hz snapshots.** The client renders remote players
  from an interpolation buffer that **adapts to measured jitter** rather than
  sitting at a fixed worst-case delay.
- **Client-side prediction of your own bean**, by replaying your unacknowledged
  inputs through **the same movement function the server runs** (`moveStep`,
  exported from `sim.js` and imported by both sides). Sharing the function is the
  point — a re-implementation drifts, and drift feels like skating.
- **Rollback netcode, opt-in via `?rollback=1`.** The client runs the whole match
  locally from the server's seed, replaying the server's input stream, and remote
  beans are drawn from that confirmed timeline. Off by default because predicting
  eight free-roaming players is a worse trade than it is in a fighting game.
- **Desync detection and automatic recovery.** Each input batch is stamped with a
  hash of the authoritative state; a client that disagrees asks for a lossless
  full-state resync. Silent divergence is the one failure mode rollback has that
  interpolation does not.
- **The simulation is bit-portable across browsers.** `exp`, `sin`, `cos` and
  `atan2` are not specified to the last bit by IEEE-754, and one differing bit
  compounds until two clients are playing different matches. The shared path uses
  only `+ - * /` and `sqrt`. `node test-sim.js` asserts this.
- **Lag compensation is present but not wired in this build.** `seenAt()` in
  `sim.js` will rewind a tackle or a hit to the tick the attacker was actually
  looking at, and the sim reads `inp.vt` to do it — but nothing in this build ever
  *sets* `vt`, so it never fires. Feeding it the client's render tick is a small
  change and measurably takes hit registration from 0% to 100% above 100ms of lag.

## Architecture

```
sim.js       deterministic 60Hz simulation — physics, mechanics, keeper FSM, match
             flow. No DOM, no Math.random (seeded PRNG), no engine-specific maths.
ai.js        team brain, roles, support spots, per-player utility AI, four
             difficulty profiles (reaction delay, aim error, decision quality —
             never stat cheats).
mini3d.js    the WebGL renderer.
client.js    rendering, menus, input, local game loop, netcode client.
server.js    static files + hand-rolled WebSocket + authoritative rooms.
build.js     flattens everything into dist/bopball-fc.html.
```

Tuning lives in `TUNE` (`sim.js`), archetypes in `ARCHETYPES` (`sim.js`),
difficulty in `DIFFICULTY` (`ai.js`) — all data. Rerun `node build.js` after any
change to refresh the single-file build.

### Tests

```bash
node test-sim.js        # scorelines, difficulty ladder, determinism, portability
node test-practice.js   # practice arena: parked players, no clock, goal resets
node diag-pass.js       # aimed passing, finesse bend, keeper body-check
node build.js           # writes dist/bopball-fc.html
```

### Dev URLs

- `?autotest=1&seed=42` — AI vs AI demo match
- `...&ff=1800` — fast-forward 30s in
- `?autohost=CODE` / `?autojoin=CODE` — headless netcode hooks
- `?harness=1` — exposes `window.__frame(ms)` / `window.__frames(n)` to step the
  render loop by hand, which is how the netcode was tested without a display
- `?rollback=1`, `?predict=0`, `?netgraph=1` — netcode toggles

## Known limits

It is a prototype, and these are real:

- **Balance is hot.** Roughly 4–5 combined goals per 3:00 against a 2.4–4.2 target.
  Six seeds is sampling noise here; anything load-bearing needs 40–60.
- One arena, procedural audio only, no music.
- Stats and trophies are not persisted.
- Lag compensation is inert, as described above.
- The AI is competent but readable once you learn it.
