# BOPBALL FC — Changelog

Running log of changes. Newest first. Every gameplay change is measured against
`node test-sim.js` (scorelines, difficulty ladder, determinism) plus larger
multi-seed runs where the 6-seed suite is too noisy to trust.

**How to read the balance numbers:** the 6-seed figure printed by `test-sim.js`
swings between ~3.5 and ~5.8 run to run. It is a smoke test, not a balance
signal. Anything load-bearing is quoted from a 20–40 seed average.

---

## Unreleased — v0.5 line, session of 4 Aug 2026 (part 2)

Pitch, passing, shooting and keeper overhaul. Measured with `node diag-pass.js`
(new) and 24-seed scoreline runs; the 6-seed suite is still only a smoke test.

### The pitch

- **Field +25%** — 48x30 -> 60x38. **Penalty box far bigger** — 7x10 -> 10x15, and
  it is now a *mechanical* boundary (see the keeper body-check), so the painted
  line is drawn from `boxW`/`boxH` rather than from real-football proportions. A
  painted line that doesn't match the rule is worse than no line.
- **Taller net** — 3.2 -> 4.1 high, 6.3 -> 7.2 wide. `keeperReach` grew to match.
- **Ceiling 7.5 -> 16.** Chips are meant to genuinely float now; this is a safety
  net rather than a lid.
- **Pace lifted** (`runSpeed` 7.0 -> 7.7, keeper speed with it). A 25% bigger field
  at the old speed just reads as the whole game being slowed down.
- Formation spots, practice spots, AI thirds, keeper claim radius and the camera
  framing all rescaled off the new dimensions.
- **This fixed the long-standing scoring problem.** 24 seeds: pro 3.08, superstar
  3.75, legend 3.75 goals per 3:00 — all inside the 2.4-4.2 target band, against
  4.4 before. The legend-vs-rookie ladder still reads 6/6.

### Passing — a weighted pass now goes where you aim it

- **Tap pass is unchanged** (auto-targets a team-mate). **Hold past `aimPassAt`
  and it becomes directional**: the cursor picks the line, the charge picks range
  and pace, movement across that line bends it. The receiver is *derived* — whoever
  is nearest the landing spot — rather than being the thing that chose the
  destination. A pass with no one near the landing spot is legal; it goes into
  space, which is a miss you made rather than a bug.
- Same for **chip passes**, except the charge buys **height** instead of pace
  (apex 2.4 -> 9.0), so a weighted chip genuinely loops a defender.
- Range maps monotonically to hold: 12.5 -> 18.4 -> 24.4 -> 30.3 -> 36.3 m.
- **A landing marker is drawn on the ground while a weighted pass loads.** Charge
  weight is a skill the player has to learn, and a mapping you can't see can't be
  learned. It mirrors the sim formula exactly rather than approximating it.
- Bend now works on every control scheme. It used to be mouse-only, because on the
  classic scheme the movement stick secretly *was* the receiver picker.

### The bug: "a charged pass near the box always goes to the enemy goalie"

Reproduced and measured. It was two defects, neither of them random:

1. At full charge the old pass was played `throughBallLead` (6.5 m) **beyond** the
   chosen team-mate, toward the goal. Near the area that lands inside the keeper's
   claim radius deterministically.
2. The keeper claimed any loose ball within 6.2 m of the goal centre — including
   a ball merely *passing through* on its way to the far post. A cross whipped
   across the face of goal clips that radius every time.

Fix: aimed passes have no through-ball lead at all, and the keeper only comes for
a ball that will **end up** in his area (`fl.land`), not one travelling past him at
25 u/s. Verified from four positions on the edge of the box, ground and chip.

### Finesse — the bend-round-the-keeper shot

- Holding finesse now buys **bend, not pace** (`finesseStageMul` 0.30). Letting the
  full stage multiplier through was self-defeating: a stage-3 finesse flew twice as
  fast, spent half as long in the air, and so the curl had half the time to work.
  Measured, lateral deviation actually *fell* from 11.3 m at a tap to 5.3 m at a
  full hold. Charging made it bend less.
- The inset and the curl are no longer two independent constants that had to be
  kept in sync by hand. The curl is **solved by integrating the real trajectory**
  (bisection, 14 steps) so the ball arrives where the cursor was, at any charge,
  range or pace. Two closed-form attempts before this both bent correctly at one
  charge tier and missed the goal at another.
- Measured across 40 seeds per tier: bend 0.3 -> 0.5 -> 0.7 -> 0.7 m, arriving
  within 0.3-0.5 m of the aimed spot, **100% on target at every tier**.
- Note for future readers: the shot curve is a flat `+Y` acceleration, *not* an
  accel square to the velocity like the pass curve. Modelling it as the latter is
  what made the first solver wrong.

### Keeper body-check

- Carry the ball into the box and the keeper comes through you. Built as a
  **telegraph, not a hitbox**: a 16-tick (267 ms) wind-up where he rears back and
  squares to you, then a 13-tick committed lunge, with a leash so he can never
  lunge himself out of the game.
- **A deke during the active window beats it outright**, and leaves him out of
  position with a longer recovery — so reading it is worth a goal, not just a
  dodge. That asymmetry is the mechanic.
- Own wind-up sound, popup, distinct animation, screen shake and slow-mo on
  contact. Measured at ~1-2 per match with roughly half dodged.

### Fixed along the way

- **A targetless aimed pass froze in mid-air.** The new no-receiver branch returned
  early and skipped the ball integrator. Caught by the headless repro, not by eye.
- `passIsThreat` and the pass-arrival path both assumed a receiver exists; an aimed
  pass can legitimately have none.

---

## Unreleased — v0.5 line, session of 4 Aug 2026

### Practice arena

- **New mode: a tuning arena.** Title screen → *Practice arena*. You, the
  opposing keeper, and nothing else. No clock, no countdown, no kickoff, and no
  goal celebration — the ball rests in the net for ~0.6 s and comes straight back
  to your feet. Iterating on feel was previously costing a 6-second presentation
  and a restart between every rep.
- **Inert dummies, spawnable live.** `1`/`2` add or remove team-mates (0–3),
  `3`/`4` defenders (0–4), `5` toggles your own keeper. Nothing on the pitch has a
  brain: a target that reacts is a target you cannot measure against, so the same
  input twice gives the same result twice. Passing and deking are testable
  without introducing AI noise.
- **Hotkeys.** `R` ball to your feet · `T` loose ball at halfway · `G` reset the
  dummies to their marks · `0` clear the readout.
- **Shot readout.** Live panel showing shots / goals / saved / off-target and
  accuracy, plus release speed, charge stage and bend for the last shot, and a
  rolling log of what each one did. This is the number to tune against.

### Implementation notes

- The sim's fixed roster of 10 is load-bearing — `snapshot()`, the lag-comp
  history `Float64Array(20)`, and every `team * 5 + slot` index assume it. Practice
  therefore does **not** remove players; it marks unused ones `off` and parks them
  120 m off-pitch. `off` is gated in six places (control loop, integrator,
  separation, the two contact scans, the countdown glide) plus the three uncapped
  "pick the best team-mate" searches. Everything else in the sim is already
  distance-gated.
- `practiceSetup` / `practiceResetBall` / `practiceResetPlayers` are exported
  state mutations and are never called from `step()`, so the sim stays a pure
  function of (state, inputs).
- **No behaviour change to normal matches**, verified: `node test-sim.js` output
  is byte-identical before and after, and match hashes match across three seeds.
- New `node test-practice.js` covers the mode: parked players never re-enter the
  pitch or touch the ball, live reconfiguration is stable, the clock does not run,
  and a goal resets rather than stopping play.

---

## Unreleased — session of 1 Aug 2026

Prototype → playable online with friends. 26 commits.

### Netcode & multiplayer

- **Server ran at 37 Hz, not 60.** The authoritative loop stepped one sim tick
  per `setInterval` fire; Windows timer granularity (~15.6 ms) meant online
  matches ran in slow motion. Now steps on elapsed real time via an accumulator.
  Verified 1200 ticks per 20 s.
- **Lobby seat picker** — all 8 field seats listed, click a free one to take it.
  Previously the second human was auto-seated on the *opposing* team, so two
  friends could never be team-mates.
- **Control follows the ball** like single player, with manual switching. You
  used to be welded to one bean for the whole match.
- **Cycle freely through open men whenever you're off the ball**, including
  while a team-mate carries. Repeat presses step nearest-ball-first through the
  rest rather than re-picking the same man.
- **A bean driven by another human can never be taken.** Switching used to steal
  a team-mate's bean and shunt them elsewhere — measured 32 displacements in one
  test, now 0.
- **Nameplates name whoever is driving**, colour-coded: gold you, green
  team-mate, red opponent, white bot. The seat name was meaningless once control
  started moving.
- **Lost presses fixed** — momentary buttons latch server-side so a tap landing
  between ticks can't vanish.
- Latency trim: snapshots 20 → 30 Hz, input 30 → 60 Hz, interpolation buffer
  120 → 80 ms.
- Match length and weather selectable in the lobby (host's choice).
- Controls menu reachable mid-match online — overlays a live game and holds your
  bean still rather than pausing (you can't pause an authoritative shared match).

**Measured capacity** (simulated clients against the real server):

| Setup | Sim rate | Download per player | Server upload |
|---|---|---|---|
| 2 players | 60.0 Hz | 18.1 KB/s | 0.28 Mbit/s |
| 4 players | 60.0 Hz | 18.1 KB/s | 0.57 Mbit/s |
| 8 players | 60.0 Hz | 18.6 KB/s | 1.16 Mbit/s |
| 12 concurrent 4-player matches | 60.0 Hz (all) | — | — |

Per-player bandwidth is flat because the snapshot always carries all 10 beans
regardless of how many are human. Adding players costs a client nothing.

### Gameplay & feel

- **Hits launch 6.4× farther.** The cause wasn't hit strength — downed bodies
  decayed at 0.86/tick, killing all momentum in a fifth of a second. Fence zaps
  went from 0 per match to ~4.
- **Charged big hits** — hold to load, 1.85× knockback at full charge, auto-fires
  when loaded. A tap is exactly the hit it always was.
- **Deke** is pure lateral (it used to dash you at the net), dashes where you're
  *holding*, ~37% farther than original.
- **Power passes** — hold for 1.6× pace, **through balls** into space past 45%
  charge, and a **bend** on the mouse scheme.
- **Pass magnet removed.** The ball no longer curves mid-flight to home in on
  receivers; receivers run onto passes instead.
- **Mouse aims at the net itself** — the cursor projects onto the goal face for
  both across *and* height. Accuracy is a skill check: error grows with range and
  your own speed, and a high Shot stat trims it.
- **Full shot-height spectrum.** Every shot used to launch with a flat `vz` of
  1.2 and skim the turf. From 15 u: tap crosses at 0.11, stage 3 at 1.96.
- **The lob is a real chip** — arcs to 3.0 and drops on the line. It used to need
  ~8 u of height and hit the 7.5 ceiling: it went *up*, not *over*.
- **Perfect passes must threaten the goal** — must now arrive within 17 u of the
  goal being attacked. ~70 a match → ~7.5. Green tracer in flight (drops the
  moment a defender can spoil it) and a green glow on the receiver.
- **One-timing a perfect pass fires the pink power shot.**
- **Diving keepers** — dives are aimed to land on the ball's crossing point, plus
  vertical leaps for high shots.
- **Run into the keeper at pace and you go down** like you'd been hit, and lose
  the ball. Team-mates are only shoved.
- **Charging isn't a commitment** — pass or deke out of a shot, deke out of a pass.
- **Bigger nets**: 5.5 × 2.4 → 6.3 × 3.2. Keeper reach grew with them.
- **Conceding team restarts with the ball** (verified 25/25).

### Presentation

- **Arena overhaul** — 14 mown bands with wear, full markings driven by the real
  gameplay dimensions, netting rebuilt as an actual box of mesh with roof, sides
  and stanchions.
- **Dynamic weather** — Clear / Golden hour / Overcast / Rain / Snow / Night,
  pickable or Random. Cosmetic only; the host rolls `random` once so every client
  draws the same sky.
- **Atmospheric lighting** — fill light, per-weather fog, and corner pylons that
  grow into working floodlights as conditions darken.
- **Instant replay on goals** — ~5.7 s across two cut camera angles.
- **Goal celebration** — camera orbits the scorer, names them, accent confetti.
- **Real ball rotation** — an actual 3×3 orientation with a rolling constraint.
  Accumulated Euler angles could never work; the axes compose wrongly the moment
  the ball changes direction.
- **Bean identity** — floating name tags, per-bean accent colours and sashes.
- **Full roster editor** in the lobby: archetype, stat points and colour for every
  bean including bots.

### Bugs fixed

- `/.git` was **fully downloadable** from the static server — over a tunnel that
  is the entire private repo. Dotfiles now 403.
- **Match clock stuck showing "1"** all game. The countdown digit never expired,
  and online's render lag meant the whistle never cleared it.
- **Keepers moved at double speed** — the main loop integrated every player and
  `moveKeeper` integrated again. Present since before this session; it's why
  nothing ever needed a dive.
- **Long-range power shots scored 100%.** The keeper committed its dive on the
  reaction tick, so from range the dive expired and it sat frozen in recovery as
  the ball arrived. Separately, a standing keeper couldn't reach high central
  shots in the taller goal.
- **Goalies vibrated on the spot** — velocity snapped to a target recomputed from
  ball noise every tick.
- **Crowd sounded like ocean surf** — 2 s of noise amplitude-swept by
  `sin(i/8000)`, on loop. Now a steady murmur, plus volume sliders.
- **Camera stuck zoomed in after a skipped celebration.** Skipping is a sim-level
  phase change (one player mashing cuts it for everyone) but the celebration
  orbit ran on a wall-clock deadline, so it kept orbiting into live play. The
  celebration can no longer be skipped until the replay has finished.
- **Hits felt janky** — quick taps were dropped between ticks, and every press
  lurched you to 62% speed before the wind-up had begun.
- **Keeper faced down its own goal line** after a save, taking the catch side-on.
  It now tracks the ball.

### Infrastructure

- Git repo created; **static build deployed to Vercel** (single-player only —
  serverless can't host a persistent match server).
- Public play via a `cloudflared` tunnel. Note the URL is regenerated every time
  the tunnel restarts.

### Known state

- **Scoring runs ~4.4 goals per 3:00**, marginally over the 2.4–4.2 target band,
  and was already there before the last features landed. Individual knobs measure
  *below the noise floor*: keeper reflex 15/13/11/9 gave 4.33/4.72/4.65/4.30 at 40
  seeds each — no monotonic relationship. Pulling this into band needs a dedicated
  pass over several levers with large samples, not another single-knob guess.
- **No lag compensation or rollback.** Feel is set by ping, not player count.
  Crisp on LAN and regional ping; cross-continent will suffer regardless of how
  little data is sent.
- No matchmaking, no reconnection (drop out and your bean goes to AI for good),
  no persistence, no anti-cheat.
