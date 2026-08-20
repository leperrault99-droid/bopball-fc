# BOPBALL FC — The Feel Pass

Mechanics are in. This doc is the gap analysis between "systems that work" and "the way
the original *felt*," organized as a prioritized punch list. Each item says what's wrong,
why the original felt different, and the concrete fix in our codebase.

---

## TIER 1 — The mosh pit (kills play-building; fix first)

The complaint: everyone collapses onto the ball, and you can't get it OUT to start a play.
This is actually four separate AI bugs stacking:

### 1.1 Loose-ball swarming
**Now:** when the ball is loose, every AI's time-to-ball is similar, the chaser role flips
constantly, and chase/mark/cover targets all sit near the ball → 6-bean scrum.
**Fix:** hard "one contester per team" rule extended to loose balls. Everyone who is NOT
the chaser gets a **repulsion field from the ball** (if within ~3.5m and not chaser, steer
away). Two beans fight for the ball; six beans spread. This one change is probably half
the whole problem.

### 1.2 Teammate separation
**Now:** teammates only separate via physical overlap resolution (they must literally touch).
**Fix:** separation steering in the AI layer — teammates within 2.5m repel each other in
steering, weight strong. Cheap, classic boids term, huge visual improvement.

### 1.3 No outlets when the ball is contested ("show for the ball")
**Now:** supports position relative to the ball — so when the ball is in a scrum, the
supports stand NEAR the scrum. There is nobody to pass out to.
**Fix:** when the ball is contested (2+ opponents within ~2m of carrier/ball), supports run
**away** to wide outlet spots (one wide left, one wide right, ~8–10m from the scrum, in
passing-lane sightline). This is real-soccer "show for the ball" behavior and it's exactly
what creates the escape pass the player is looking for.

### 1.4 Scrums never resolve
**Now:** tackles/hits in a crowd pop the ball randomly → it lands in the same crowd → loop.
**Fix:** when the ball pops loose (tackle/hit/drop), bias the pop velocity **away from the
local crowd centroid** instead of random. Scrums self-clear like a hockey puck squirting
out of a board battle. Also: while 3+ players are within 1.5m of a loose ball for >1s,
give it a small outward impulse (the "greasy ball" rule).

### 1.5 Escape valves for the carrier
- New AI action: **clear** — when swarmed in your own third, boot it long downfield
  (the original's pressure-release play). High utility score when pressD < 1.5 and own half.
- Pass scoring: when pressured, boost *long* outlet passes and allow **back-passes to the
  safety bean to reset** (currently backward passes are penalized — a reset pass is how
  you build play from pressure).
- After passing, the passer sprints forward into space for ~1s (give-and-go instinct)
  instead of instantly re-evaluating roles.

---

## TIER 2 — Shot feel (bend + tracer + punch)

The original's shots felt like *events*. Ours are correct but polite.

### 2.1 Tracer trail
Shots get a **ribbon/streak trail** behind the ball, colored by charge stage
(white → yellow → orange → hot pink at stage 3). Perfect one-timers get a brighter trail +
sparkle particles. Implementation: ring buffer of last ~14 ball positions → triangle-strip
ribbon in mini3d (or a chain of fading sprite dots — cheaper, still reads great).

### 2.2 Visible bend
Curve exists in the sim (`curveAccel`) but it's subtle and there's no wind-up telegraph.
- Raise curve strength on charged shots (stage 2–3 curve ~1.6×), so held-direction bend
  is an actual aiming tool around the keeper.
- Mouse scheme: cursor movement during charge sets curve (drag left while charging =
  bend left) — very natural.
- The tracer makes the bend READABLE — bend without a trail is invisible at this speed.

### 2.3 Release punch
- Stage-3 release: 3-frame hit-stop + camera micro-punch toward the goal + muzzle-flash
  ring at the shooter's foot + deeper SFX thunk (pitch drops with power).
- Ball **squash & stretch**: scale ball ~1.25× along velocity on hard shots.
- Charge telegraph for EVERYONE: right now only the controlled bean shows a charge ring.
  Give every charging bean a glow ring (defenders need to read "he's at stage 3 — tackle
  NOW" — that's a core skill loop from the original).

---

## TIER 3 — Impact & juice (the original was a contact-sport game first)

- **Hit-stop tuning:** big hits 4 → 7 frames frozen, plus 60ms slow-mo tail. Impacts
  should feel like a car crash, not a bump.
- **Directional camera nudge** on big hits (camera shoves 0.3m in hit direction, springs
  back) in addition to shake.
- **Fence zap upgrade:** arc-lightning particles along the nearest rail segment, rail
  flashes white→yellow, victim flickers, bigger SFX crackle. It's the signature moment —
  currently it's ~40% of the drama it should be.
- **Deke afterimage:** 2–3 ghost copies fading over 150ms + tiny hop. Sells the juke.
- **Sprint texture:** dust puffs at feet + slight forward lean + faint speed lines on the
  controlled bean. Turbo should *look* like turbo.
- **Wall bounces livelier:** wallBounce 0.72 → ~0.8 and keep more tangential speed — cage
  pinball is part of the fantasy.
- **Knockdown ragdoll-ish:** victims should tumble (rotate through the knockback) rather
  than rotate-and-slide. Even a fixed 2-spin tumble reads 10× better.

## TIER 4 — Readability aids the original had

- **Receiver indicator:** during a pass flight, put a bouncing arrow/ring on the receiver
  (original always told you who's getting the ball). Also fixes "who am I about to be?"
  confusion on auto-switch.
- **"PERFECT!" popups** on perfect passes and perfect one-timers (small, juicy text
  burst at the bean, not center-screen).
- **Switch telegraph:** when control switches beans, flash the ring + a short line from
  old bean to new bean for 200ms.
- **Skippable celebrations:** any button skips the goal celebration (currently fixed ~2.5s;
  the design doc promised skippable — not yet wired).
- **Crowd reactivity:** crowd gasp SFX + lean-in on shots that miss by little; big roar
  ramp in final 60s (partially in).

## TIER 5 — Pace & flow tuning (numbers to try, all in TUNE)

| Knob | Now | Try | Why |
|---|---|---|---|
| passSpeed | 14.5 | 16.5 | original passes ZIP; floaty passes make midfield feel muddy |
| passMagnet | 0.22 | 0.26 | snappier catches = confident possession feel |
| goalCeleT | 150 | 110 + skippable | back to action faster |
| countdownT | 88 | 60 after goals (keep 88 at kickoff) | pace |
| bhDownBase | 66 | 78 | knockdowns a touch longer → hits matter more |
| keeper parry outward speed | 5–10 | 8–14 | juicier rebound scrambles in front of goal |
| camera | fixed height | +zoom-in ~12% when ball in attacking third | drama |

---

## Suggested implementation order

1. **Tier 1 complete** (mosh pit) — it's the fun-blocker. Verify with the headless harness:
   average pairwise distance between all 8 field beans should rise ~30%+, possession
   duration up, and "3+ beans within 2m of ball" time share should drop from whatever it
   is now to <15%.
2. **2.1 + 2.3** (tracer + punch) — biggest visible wow per line of code.
3. **Tier 3 zap/hit-stop/deke** — the contact-sport identity.
4. **Tier 4 readability** — quick wins, mostly UI.
5. **Tier 5 numbers** — 30-minute tuning session with the AI harness + hands-on play.

Everything above is renderer/AI-side except the Tier 1 sim tweaks (pop-out bias, greasy
ball) and Tier 5 numbers — netcode and determinism are unaffected.
