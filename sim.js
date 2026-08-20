// ============================================================================
// BOPBALL FC — core simulation (pure, deterministic, engine-agnostic)
// 5v5 arcade soccer: 4 field beans + AI keeper per team, walled electric pitch.
// No rendering, no DOM, no Date.now, no Math.random — seeded PRNG in state.
// step(state, inputs) advances exactly 1 tick (1/60 s).
// ============================================================================

export const DT = 1 / 60;
export const TICK_RATE = 60;

// ---------------------------------------------------------------- tuning ----
export const TUNE = {
  // Pitch grew ~25% for the v1.0 line. Everything below that is expressed as a
  // fraction of pitchW/pitchH scales with it; the constants that had to be chased
  // by hand are marked "scaled with the pitch".
  pitchW: 60, pitchH: 38,          // x length, y width (half extents 30 / 19)
  goalW: 7.2, goalH: 4.1,          // goal mouth (inside faces of the frame) — taller net
  postR: 0.15, ballR: 0.24,        // frame radius / ball radius — used for woodwork hits
  postBounce: 0.62,                // how lively the frame is
  postPickupCd: 8,                 // brief no-pickup so a rebound clears the scramble
  aimWide: 1.25, aimHigh: 0.9,     // how far off target a shot is allowed to end up
  // Shots vs bodies. Below blockMaxZ a shot can strike an outfield bean; past
  // blockKnockSpeed it stops being a block and starts being a hit.
  blockR: 0.5, blockMaxZ: 1.7, blockBounce: 0.45, blockScatter: 1.6, blockPickupCd: 10,
  blockKnockSpeed: 30, blockKnockBase: 7, blockKnockPerSpeed: 0.55,
  // Finesse: the placement shot. Slower, far more accurate, and it curls.
  finessePowerMul: 0.82,           // slower than a drive, but not so slow it's free to save
  // These two must agree: the curl has to carry the ball back out by roughly the
  // inset over a typical flight. curveAccel is 26, so a curve of ~0.45 moves it
  // about 1.3m over half a second. Values in the 3s banana it off the pitch.
  // Finesse is the bend-it-round-the-keeper shot. You launch INSIDE the spot you
  // picked and the curl carries the ball back out to it, so it visibly arcs around
  // the keeper into the side netting. Both the inset and the curl scale with how
  // long you held it: a tapped finesse is a gentle placement, a fully weighted one
  // is a proper banana from the corner of the box.
  finesseInset: 1.1,               // swing available at zero charge...
  finesseInsetMax: 3.4,            // ...and at a full hold
  finesseCurveMax: 1.85,           // ceiling on the solved curl — raised with the arc
  finesseShoScale: 0.085,          // swing available per point of Shot
  // ---- and it has to be MISSABLE -------------------------------------------
  // Solving the curl exactly made this shot land within 0.3 m of the cursor every
  // single time, at every charge, for every player. That is not a skill shot, it
  // is a button. So the solved curl is the shot you get when you weight it right;
  // everything else drifts off it. Over-curl and it stays wide of the post;
  // under-curl and it never leaves the keeper. Rushing it is worse than holding
  // it, and a poor finisher is worse than a good one at both.
  finesseLatErr: 3.4,              // metres of sideways error at the goal line when you
                                   // weight it badly — enough to find the post, or miss
  finesseZErr: 1.6,               // extra height scatter (metres at the goal line) —
                                   // this is what puts one over the bar
  finesseShoErr: 0.088,            // error removed per point of Shot
  finesseWeightErr: 0.38,          // how badly the strike itself can be weighted
  finesseMissFloor: 0.06,          // even a 10-rated finisher is not a machine
  finesseOutMax: 6.5,              // how far OUTSIDE the post the launch line may point.
                                   // This is the "looks like it's missing" part of the
                                   // shot; the curl brings it back in to the post.
  finesseStageMul: 0.10,           // charge on a finesse barely touches pace. It is a
                                   // placement shot; holding it longer must not turn it
                                   // into a power shot that happens to curl.
  // Charge on a finesse buys ACCURACY. A tap is a scuffed attempt at a clever
  // shot; a full hold is a struck, deliberate one. This is the stat/skill line —
  // it is where a good Shot rating and a patient player get rewarded.
  finesseAimTap: 0.62,             // aim-error multiplier at zero charge...
  finesseAimFull: 0.09,            // ...and at a full hold
  // The curl is SOLVED from the inset (see launchShot) rather than tuned, but the
  // textbook 1/2*a*t^2 over-predicts the displacement here: the lateral accel is
  // applied square to the CURRENT velocity, so it rotates the ball's heading
  // instead of pushing it sideways in a straight frame, and the ball is dragging
  // as it goes. Measured achieved-vs-intended across all four charge tiers, the
  // shortfall is a consistent ~2.1x. One calibration constant, measured once.
  finesseCurveK: 2.15,
  finesseBeat: 0.20,               // placement's reward in the save roll
  boxW: 10, boxH: 15,              // keeper box (x depth from line, y width) — deeper and wider
  // Chips are meant to genuinely float now, so this is a safety net rather than a
  // lid. Nothing should reach it in normal play; if a ball is touching it, that's
  // a bug worth seeing rather than a shot to silently clamp.
  ceiling: 16,

  // Pace lifted with the pitch. A 25% bigger field at the old speed reads as the
  // whole game being slowed down, which is not what a bigger pitch is for.
  runSpeed: 7.7, speedPerStat: 0.28,
  sprintMul: 1.22, dribbleMul: 0.97, chargeMul: 0.55,
  accelK: 11,                      // exponential accel factor
  playerR: 0.45,

  possessionR: 1.05, leashD: 0.6, pickupCd: 22,

  passSpeed: 21.5, passPerStat: 0.62,   // scaled with the pitch: 16.5 on a 48m field read as a soft roll on a 60m one
  passLead: 1.0,                   // aim where the receiver WILL be; the ball then flies straight
  passChargeMax: 32,               // ~0.53s hold for a fully weighted pass
  passPowerBonus: 0.6,             // full charge = 1.6x pace
  throughBallAt: 0.45,             // charge past this and it's played into space, not to feet
  throughBallLead: 6.5,            // metres in behind the runner at full charge
  passBend: 1.1, passBendMax: 0.9, passCurveAccel: 20.8,   // +30% curl
  lobPassSpeed: 14.5, interceptR: 0.8, catchR: 1.45,
  perfectPassClearR: 1.35, perfectPassMinD: 5, perfectBuffT: 90,

  // ---- AIMED PASSING -------------------------------------------------------
  // A tap still auto-targets a team-mate. Hold past aimPassAt and the pass stops
  // being "who should get this" and becomes "where am I putting it" — the cursor
  // picks the line, the charge picks how far and how hard, and movement across
  // that line bends it. The receiver becomes a *consequence* of where the ball
  // lands rather than the thing that decided where it went.
  //
  // This also kills the old bug where a charged pass near the box was played
  // `throughBallLead` metres past the receiver — i.e. directly into the keeper's
  // claim radius, every single time.
  aimPassAt: 0.18,                 // charge past this and the pass goes where you aimed
  aimPassRangeMin: 8,              // metres at just-past-threshold
  aimPassRangeMax: 34,             // metres at a full hold
  aimPassSpeedMin: 19.0,
  aimPassSpeedMax: 32,
  aimPassStatRange: 0.45,          // metres of extra range per point of Pass
  aimPassTgtR: 5.0,                // a team-mate this close to the landing spot is the receiver
  // Chips fly on the same aim, but the charge buys height instead of pace, so a
  // full-weight chip genuinely loops a defender rather than skimming past them.
  aimChipApexMin: 2.4,
  aimChipApexMax: 9.0,

  attackThirdD: 21,                // scaled with the pitch
  perfectPassZone: 21,             // must arrive within this of the goal being attacked —
                                   // a perfect pass is a threatening one, not just a long one
  perfectPassBeat: 2,              // ...or one that strands this many defenders behind it,
                                   // which is what a bent ball down the line actually does

  shotBase: 15.5, shotPerStat: 1.0,
  // Stage 0 is a normal shot; the charged tiers are meant to be startling. Was
  // [0, .14, .30, .50] — a full charge only 50% quicker than a tap, which is why
  // power shots read as ordinary.
  stageMul: [0, 0.26, 0.62, 1.05],
  hardShotP: 27, beatShotP: 30,    // keeper "this one's hard" thresholds, in ball speed
  // Height a shot is aimed to cross the goal line at. Shots used to launch with a
  // flat vz of 1.2, so every one of them skimmed the turf; this gives the full
  // spread from a low drive to a raised finish.
  shotZBase: 0.35, shotZPerStage: 0.66, shotZOneTimer: 0.72, shotZSpread: 0.58,
  // A chip is no longer a fixed arc. It is SOLVED to clear whatever the keeper can
  // reach at the point it passes him, and still drop under the bar. A fixed 2.7 m
  // apex could not do that: against a keeper who has come out and is standing tall
  // it was simply a slow shot straight at him.
  chipApex: 2.7,                   // fallback only, when there is no keeper to clear
  chipSpeedMin: 8.5, chipSpeedMax: 19,
  chipClearMargin: 0.85,           // clear his reach by this much...
  chipBarMargin: 0.60,             // ...and still be this far under the bar on the way down
  chipMaxT: 1.9,                   // longest flight we will loop it to
  chipBackspin: 3.2,               // visual: chips come off with real backspin
  // Human aim error (the AI has its own via prof.sigma). Grows with range and with
  // your own speed; a high Shot stat trims it. Sigma in metres at the goal line.
  aimErrBase: 0.12, aimErrPerDist: 0.031, aimErrPerSpeed: 0.046, aimErrShoRelief: 0.055,
  chargeStageT: [16, 38, 62],      // ticks to reach stage 1/2/3 (fast — ~1.0s to max)
  chipSpeed: 12.5, curveAccel: 26,
  oneTimerWindow: 9,               // ticks before arrival for "perfect"
  otStage: 2, perfectOtStage: 3,   // one-timers fire at a charge tier, green ones at the top.
                                   // Was 1 (stageMul 0.26, the weakest shot in the game) —
                                   // you did the hard part and got a tap. Redirecting a
                                   // moving ball should carry weight on its own.
  otMashMax: 2,                    // presses allowed before the timing bonus is void
  otArmWindow: 75,                 // how long a press stays live waiting for the ball.
                                   // Measured: passes are airborne p50 0.45s / p90 0.85s,
                                   // lobs p50 0.75s / p90 1.18s. At 45t a press the moment
                                   // you saw a lob played missed half the time and you
                                   // trapped instead. 75t covers 97% of all passes.
  volleyReachZ: 1.9,               // highest ball a bean can still meet
  volleyMinZ: 0.85,                // above this it's struck out of the air, not off the deck
  volleyDur: 26,                   // how long the strike animation holds
  volleyPowerMul: 1.08, volleyLift: 0.5,   // volleys fly a touch harder and higher
  incomingR: 2.8, incomingMinZ: 0.95,      // when a loose airborne ball counts as "coming to me"
  leapLead: 0.28, leapDur: 22, leapCdT: 95, // jump this far ahead of a dropping ball
  leapMinZ: 1.2,                   // don't leave the ground for anything lower than this
  trapRecT: 8,                     // settling touch after plucking one out of the air
  oneTimerPower: 2.0, perfectOtPower: 2.4,   // trimmed: perfect-pass finishes made these common
  perfectPassOt: true,             // finishing an untouched pass also fires the pink one

  slideDur: 30, slideMul: 1.38, slideRecover: 24, slideCd: 30,
  tackleBaseR: 0.55, tackleRangePerStat: 0.06,
  tripDur: 40,

  bhChargeMax: 50,                 // ticks of wind-up to a fully loaded hit (~0.85s)
  bhChargeBonus: 0.85,             // full charge = 1.85x knockback and a longer stay-down
  bhChargeMoveMul: 0.72,           // a real hold slows you: the cost of loading one up
  bhChargeGrace: 9,                // ticks before that penalty starts — taps stay clean
  bhWindup: 6, bhActive: 14, bhSettle: 5, bhMul: 1.32,
  bhReach: 0.78,
  bhKnockBase: 11.5, bhKnockPerStat: 0.95,
  bhDownDrag: 0.955,               // downed bodies keep sliding (0.86 = stops dead)
  bhDownBase: 64, bhDownPerStat: 2.4,   // shorter lie-down: the launch is the drama, not the nap
  bhRecCarrier: 30, bhRecOffBall: 66, bhRecWhiff: 58, bhCdOffBall: 240,
  zapDur: 40, zapSpeedMin: 2.2,
  immuneAfterDown: 50,

  dekeDur: 22, dekeMul: 1.95, dekeCd: 62,
  dekeDrag: 0.95,                  // was a hardcoded 0.94 — higher = the juke carries

  keeperReadSpeed: 32,             // pace above this is read early rather than reacted to
  keeperReadPerSpeed: 0.45,        // ticks of anticipation bought per u/s over that
  keeperReadMax: 9, keeperMinReact: 3,
  keeperStretchPerSpeed: 0.055, keeperStretchMax: 0.9,    // full-stretch reach vs pace
  keeperSpeed: 14.2, keeperWeakSpeed: 11.2,               // scaled with the pitch
  keeperReach: 1.90,               // grew with the goal mouth (6.3x3.2 -> 7.2x4.1)
  keeperHoldT: 45, keeperStunT: 92, keeperStunImmuneT: 360,
  keeperStunP: 0.42, keeperCatchP: 0.66, keeperRushR: 6.0,
  keeperLine: 1.8,
  keeperClaimR: 6.8,               // loose ball inside this of the goal centre gets chased.
                                   // Scaled with the pitch; was a bare 6.2 literal.

  // ---- KEEPER BODY-CHECK ---------------------------------------------------
  // Walk into the box with the ball and the keeper will come through you. It is a
  // telegraphed lunge, not a hitbox: a long readable wind-up, then a short burst.
  // A deke fired during the active window beats it outright and leaves the keeper
  // committed and out of position, so the box becomes a timing duel rather than a
  // place you dribble through for free.
  kCheckR: 4.6,                    // starts one when a carrier is inside this
  kCheckMinBoxDepth: 0.0,          // ...and inside the box (x from the goal line)
  kCheckWindup: 16,                // ~0.27s of telegraph. Long enough to read and dodge.
  kCheckActive: 13,
  kCheckSettle: 12,
  kCheckSpeed: 17.5,
  kCheckReach: 1.30,
  kCheckKnock: 15.5,               // knockback, on the scale of a charged big hit
  kCheckDownT: 74,
  kCheckLeash: 6.5,                // never lunge further than this from the goal line
  kCheckCd: 240,                   // ~2.8s between attempts
  kCheckWhiffRec: 46,              // ...and a longer punish if you dodged it
  kCheckImmuneT: 60,               // brief immunity after being checked
  keeperDeadzone: 0.16,            // don't chase sub-16cm target noise
  keeperAccelK: 24,                // ease into the target velocity (was an instant snap)
  // Diving saves — with a 6.3-wide mouth a keeper can't cover the corners on foot.
  keeperDiveDur: 20, keeperDiveSpeed: 16, keeperDiveReach: 0.85,
  keeperDiveZ: 3.0,                // a dive reaches higher than a standing save (2.35)
  keeperDiveCd: 26,                // recovery before another dive. Was 40 — two thirds
                                   // of a second face-down, sluggish and a rebound gift.
  keeperDiveMinGap: 2.1,           // don't dive for something you can just step to.
                                   // Raised alongside the shorter cooldown: measured,
                                   // a keeper that dives MORE saves LESS, because one
                                   // on his feet covers the middle of the goal better.
  keeperHighSave: 1.85,            // above this the keeper must leave its feet, even centrally
  keeperBumpR: 1.15,               // run inside this of the keeper and you're going down
  keeperBumpSpeed: 5.6,            // ...but only at a genuine run, not a drift
  keeperDiveLead: 0.75,            // only commit inside this many seconds of arrival
  // ---- COMING OUT ----------------------------------------------------------
  // A keeper who never leaves his line is free to shoot past. Get in behind with
  // nobody covering and he comes to meet you, narrowing the angle and standing
  // tall. That is the moment the chip exists for: he is big, he is committed, and
  // he is no longer under his own bar.
  keeperOutTrigger: 22,            // carrier inside this of the goal is worth coming for
  keeperOutMax: 8.5,              // furthest off his line he will advance
  keeperOutSpeed: 1.45,            // he closes quicker than he shuffles
  keeperOutCoverR: 3.4,            // a defender this close to the carrier's line counts
                                   // as cover, and he stays home instead
  keeperOutMinClosing: 2.6,        // he only comes for a man who is RUNNING AT HIM. Nobody
                                   // charges out at someone standing still lining up a
                                   // shot — against that you set yourself. Without this
                                   // gate a placed finesse scored 100% at every charge
                                   // tier, because the corners were always vacated.
  keeperBigR: 0.60,                // extra block radius once he is out and set — this
                                   // is "making himself big"
  keeperBigZ: 0.55,                // ...and the extra height that comes with it

  // ---- JUMPING -------------------------------------------------------------
  // He can leave the ground for a lofted ball. Close enough and he plucks it out
  // of the air; too high or too far and it sails over him, which is exactly the
  // outcome a good chip has earned.
  keeperJumpZ: 3.45,               // top of his reach at full stretch off the ground
  keeperJumpR: 1.55,               // horizontal reach while airborne
  keeperJumpDur: 26,
  keeperJumpCd: 34,
  keeperJumpLead: 0.40,            // only leaves the ground inside this many seconds
  keeperJumpMinZ: 2.35,            // below this he just reaches — jumping at a driven shot
                                   // he could already touch made every finesse a certain
                                   // catch (measured: 40/40 saved)
  keeperJumpCatchP: 0.62,          // reached it in the air: catch it cleanly...
                                   // ...otherwise he punches it clear

  keeperCurveCommit: 0.92,         // how hard a keeper commits to his first read of a
                                   // CURLING shot. 0 = re-solves every tick and is never
                                   // beaten by bend; 1 = never corrects at all.

  countdownT: 88, countdownShortT: 60,
  goalCeleT: 460,                  // ~7.7s: the ~4.9s replay finishes, then the orbit.
                                   // The clock is paused here, so it costs no match time.
  goalCeleMinT: 330,               // unskippable until the ~4.9s replay has finished.
                                   // One player mashing skip cuts the phase for EVERYONE,
                                   // so this window has to outlast the presentation.
  ballGravity: 21, ballDragG: 0.988, ballDragA: 0.998, ballBounce: 0.62,
  wallBounce: 0.8,
};

// ------------------------------------------------------------- archetypes ---
// stats 0..10: spd speed, sho shot power, hit check power, tkl tackle reach,
// pas passing.  size scales body/hurtbox (bigger = easier to hit/tackle).
export const ARCHETYPES = {
  striker:   { label: 'Striker',    desc: 'Lives to shoot. Cannon boots.',        spd: 6, sho: 9, hit: 4, tkl: 4, pas: 5, size: 0.95 },
  enforcer:  { label: 'Enforcer',   desc: 'Big body, bigger hits.',               spd: 4, sho: 5, hit: 9, tkl: 7, pas: 4, size: 1.15 },
  playmaker: { label: 'Playmaker',  desc: 'Threads perfect passes all day.',      spd: 7, sho: 4, hit: 3, tkl: 5, pas: 9, size: 0.90 },
  allround:  { label: 'All-Rounder',desc: 'Good at everything, great at nothing.',spd: 6, sho: 6, hit: 6, tkl: 6, pas: 6, size: 1.00 },
  speedster: { label: 'Speedster',  desc: 'Gone before you blink.',               spd: 9, sho: 3, hit: 3, tkl: 4, pas: 6, size: 0.85 },
  tank:      { label: 'Tank',       desc: 'A wall that tackles back.',            spd: 3, sho: 6, hit: 8, tkl: 9, pas: 3, size: 1.25 },
};
export const TRAIT_POINTS = 4;   // extra points a player may distribute
export const STAT_KEYS = ['spd', 'sho', 'hit', 'tkl', 'pas'];

// ------------------------------------------------------------------- rng ----
export function rnd(s) {           // mulberry32 on s.rngState
  let t = (s.rngState += 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function gauss(s) { return (rnd(s) + rnd(s) + rnd(s) - 1.5) * 1.155; } // ~N(0,1)

// --------------------------------------------------------------- helpers ----
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const len = (x, y) => Math.sqrt(x * x + y * y);

// ---- portable maths ---------------------------------------------------------
// Everything the sim does must be bit-identical on every engine, or two clients
// running the same inputs slowly become two different matches. IEEE-754 pins
// +,-,*,/ and sqrt exactly. It does NOT pin exp, sin, cos, atan2 — Chrome,
// Firefox and Safari may each return a different last bit, and one bit is all it
// takes once it compounds into a comparison flipping. So the sim uses none of
// them; these are the deterministic stand-ins.

// A random unit vector by rejection: only multiply and sqrt, and both sides
// consume the same draws because rnd() is the same seeded stream.
function randUnit(s) {
  for (let i = 0; i < 16; i++) {
    const ux = rnd(s) * 2 - 1, uy = rnd(s) * 2 - 1;
    const l2 = ux * ux + uy * uy;
    if (l2 > 1e-6 && l2 <= 1) { const inv = 1 / Math.sqrt(l2); return [ux * inv, uy * inv]; }
  }
  return [1, 0];
}
// Rotation by a small angle, parameterised by its tangent instead of the angle.
// cos = 1/sqrt(1+t^2), sin = t/sqrt(1+t^2) — exact, and no trig table to drift.
function rotT(x, y, t) {
  const c = 1 / Math.sqrt(1 + t * t), sn = t * c;
  return [x * c - y * sn, x * sn + y * c];
}
// 1 - e^(-k*dt) for the fixed timestep, precomputed as literals. Same numbers
// Math.exp gives in V8, but frozen so no other engine can disagree.
// REGENERATE THESE if accelK or keeperAccelK ever change, or movement silently
// stops matching the tuning value. assertPortable() below catches exactly that.
const ACCEL_K_DT = 0.16750938738839727;      // 1 - exp(-accelK       / 60), accelK 11
const KEEPER_K_DT = 0.3296799539643607;      // 1 - exp(-keeperAccelK / 60), keeperAccelK 24
function norm(x, y) { const l = len(x, y) || 1; return [x / l, y / l]; }
export const NEUTRAL_INPUT = Object.freeze({ mx: 0, my: 0, sprint: false, aHeld: false, bHeld: false, yHeld: false, lobHeld: false });

export function statsFrom(arche, traits) {
  const a = ARCHETYPES[arche] || ARCHETYPES.allround;
  const t = traits || {};
  const st = {};
  for (const k of STAT_KEYS) st[k] = clamp((a[k] || 5) + (t[k] || 0), 0, 10);
  st.size = a.size;
  return st;
}
export function maxSpeed(p) { return TUNE.runSpeed + p.stats.spd * TUNE.speedPerStat; }

// The exact movement the server will run, factored out so a predicting client
// can use the real physics instead of guessing. Any drift between this and the
// block in step() shows up as rubber-banding, so they must stay one thing —
// step() calls this too.
export function moveStep(p, hasBall, dt) {
  const T = TUNE;
  const canAct = (p.st === 'norm' || p.st === 'leap') && p.recT <= 0;
  if (canAct) {
    let sp = maxSpeed(p);
    if (hasBall) sp *= T.dribbleMul;
    if (p.inSprint && !p.charging) sp *= T.sprintMul;
    if (p.charging) sp *= T.chargeMul;
    if (p.bhChargeT > T.bhChargeGrace) sp *= T.bhChargeMoveMul;
    // Fixed step uses the frozen constant so every engine agrees. A variable dt
    // only ever comes from the client's local presentation smoothing, which is
    // never part of the shared truth, so exp is fine there.
    const k = dt === DT ? ACCEL_K_DT : 1 - Math.exp(-T.accelK * dt);
    p.vx += (p.inMx * sp - p.vx) * k; p.vy += (p.inMy * sp - p.vy) * k;
    if (len(p.vx, p.vy) > 0.6) { const [fx, fy] = norm(p.vx, p.vy); p.fx = fx; p.fy = fy; }
    return true;
  }
  return false;
}

// ------------------------------------------------------------ formations ----
// attacking direction d = +1 (team0) or -1 (team1); slots 0..3 field (0=captain), 4=keeper
function formationSpot(team, slot, kickoffTeam) {
  const d = team === 0 ? 1 : -1;
  const ko = team === kickoffTeam;
  let x, y;
  const hw = TUNE.pitchW / 2, hh = TUNE.pitchH / 2;
  if (slot === 4) { x = -(hw - TUNE.keeperLine); y = 0; }
  else if (slot === 0) { x = ko ? -0.9 : -6.9; y = ko ? 0 : 0.5; }   // ko captain stands over the ball
  else if (slot === 1) { x = -hw * 0.40; y = -hh * 0.52; }
  else if (slot === 2) { x = -hw * 0.40; y = hh * 0.52; }
  else { x = -(hw * 0.65); y = 0; }
  return [x * d, y];
}

// ---------------------------------------------------------------- practice --
// A training match: you, a keeper, and whatever inert dummies you ask for.
//
// The sim's fixed roster of 10 is load-bearing — snapshot(), the lag-comp history
// Float64Array(20), and every `team * 5 + slot` index assume it. So practice does
// NOT remove players; it marks the ones you aren't using `off` and parks them well
// outside the pitch. `off` is gated in exactly six places (the control loop, the
// integrator, separation, the two contact scans, and the countdown glide) plus the
// three uncapped "pick the best team-mate" searches. Everything else in the sim is
// already distance-gated, and PARK_Y is 120m away, so nothing else needs to know.
const PARK_Y = 120;

// Where a dummy stands. Slots are the normal formation ones, pushed into useful
// training positions: team-mates spread ahead of you, defenders between you and
// the net you're shooting at.
function practiceSpot(i) {
  const hw = TUNE.pitchW / 2, line = TUNE.keeperLine;
  switch (i) {
    case 0: return [-4, 0];        // you — a run-up, not a marathon
    case 1: return [10, -11];      // team-mate dummies: wide, ahead, cross-able
    case 2: return [10, 11];
    case 3: return [17, 0];        // the man in the middle for a cut-back
    case 4: return [-(hw - line), 0];    // your keeper
    case 5: return [11, -4.5];     // defender dummies: between you and the goal
    case 6: return [11, 4.5];
    case 7: return [19, 0];
    case 8: return [22, -7];
    case 9: return [hw - line, 0];       // opponent keeper
  }
  return [0, 0];
}

// Set which players exist. `mates` 0..3, `defs` 0..4, `ownKeeper` bool.
// Safe to call mid-match — this is a practice-only state mutation and is never
// called from step(), so the sim stays a pure function of (state, inputs).
export function practiceSetup(s, { mates = 0, defs = 0, ownKeeper = false } = {}) {
  s.practice = true;
  const on = new Set([0, 9]);                                  // you + their keeper, always
  for (let n = 0; n < Math.min(mates, 3); n++) on.add(1 + n);   // 1,2,3
  for (let n = 0; n < Math.min(defs, 4); n++) on.add(5 + n);    // 5,6,7,8
  if (ownKeeper) on.add(4);
  for (const p of s.players) {
    const live = on.has(p.i);
    if (live && p.off) {                       // coming back on: place and reset
      const [x, y] = practiceSpot(p.i);
      p.x = x; p.y = y;
    }
    p.off = !live;
    if (p.off) { p.x = 0; p.y = PARK_Y; }
    p.vx = 0; p.vy = 0;
    p.st = 'norm'; p.stT = 0; p.recT = 0; p.immuneT = 0;
    p.charging = false; p.chargeT = 0; p.bhChargeT = 0; p.passChargeT = 0;
    p.fx = p.team === 0 ? 1 : -1; p.fy = 0;
  }
  s.practiceOn = { mates, defs, ownKeeper };
  return s;
}

// Put the ball back. 'feet' = at your feet with possession, 'spot' = loose on the
// practice mark, 'far' = loose out near the halfway line to run onto.
export function practiceResetBall(s, where = 'feet') {
  const b = s.ball;
  b.vx = b.vy = b.vz = 0; b.flight = null; b.owner = -1; b.pickupCd = 0; b.z = 0.11;
  s.pResetT = 0;
  const me = s.players[0];
  if (where === 'feet') {
    b.x = me.x + me.fx * 0.7; b.y = me.y + me.fy * 0.7;
    giveBall(s, 0);
  } else if (where === 'far') {
    b.x = -2; b.y = 0;
  } else {
    b.x = me.x; b.y = me.y;
  }
  return s;
}

// Reset every dummy to its mark without touching the ball — for when a scramble
// has left them scattered.
export function practiceResetPlayers(s) {
  for (const p of s.players) {
    if (p.off) continue;
    const [x, y] = practiceSpot(p.i);
    if (p.i !== 0) { p.x = x; p.y = y; }        // leave YOU where you are
    p.vx = 0; p.vy = 0; p.st = 'norm'; p.stT = 0; p.recT = 0;
    p.fx = p.team === 0 ? 1 : -1; p.fy = 0;
  }
  return s;
}

// ------------------------------------------------------------ make match ----
export function makeMatch(cfg) {
  // cfg: { seed, timerLen, teams:[{name,color,captain:{arche,traits},sidekick:{arche,traits}},x2],
  //        weakGoalies, keeperReflex:[ticks,ticks], goldenGoal:true }
  const s = {
    tick: 0, rngState: (cfg.seed >>> 0) || 1,
    phase: 'countdown', phaseT: TUNE.countdownT,
    clock: cfg.timerLen ?? 180, timerLen: cfg.timerLen ?? 180,
    overtime: false, score: [0, 0], kickoffTeam: 0,
    players: [], events: [],
    cfg: {
      teams: cfg.teams,
      weakGoalies: !!cfg.weakGoalies,
      keeperReflex: cfg.keeperReflex || [14, 14],
      goldenGoal: cfg.goldenGoal !== false,
    },
    ball: { x: 0, y: 0, z: 0.11, vx: 0, vy: 0, vz: 0, owner: -1, pickupCd: 0, flight: null, lastTouch: -1 },
    keeper: [ // per-team keeper brain scratch
      { reactT: -1, shotId: -1, tgtY: 0 },
      { reactT: -1, shotId: -1, tgtY: 0 },
    ],
    shotSeq: 0,
  };
  for (let team = 0; team < 2; team++) {
    const tc = cfg.teams[team];
    for (let slot = 0; slot < 5; slot++) {
      const isK = slot === 4;
      const src = (tc.lineup && tc.lineup[slot]) || (slot === 0 ? tc.captain : tc.sidekick);
      const stats = isK ? { spd: 6, sho: 5, hit: 5, tkl: 5, pas: 6, size: 1.1 } : statsFrom(src.arche, src.traits);
      const [x, y] = formationSpot(team, slot, 0);
      s.players.push({
        i: team * 5 + slot, team, slot, keeper: isK,
        arche: isK ? 'keeper' : src.arche,
        x, y, vx: 0, vy: 0, fx: team === 0 ? 1 : -1, fy: 0,
        st: 'norm', stT: 0, recT: 0,
        chargeT: 0, charging: false, lobHeld: false,
        cdBigHit: 0, cdDeke: 0, cdSlide: 0, immuneT: 0, buffT: 0,
        bhChargeT: 0, passChargeT: 0, diveT: 0, diveCd: 0, leapCd: 0,   // undefined <= 0 is false — must init
        shotLocked: false, passLocked: false,
        otArm: -1,                                   // tick one-timer was armed
        otPress: 0,                                  // presses this approach (mash guard)
        stunImmuneT: 0, holdT: 0,
        off: false,
        kchkCd: 0, kchkV: -1, kchkHit: false, jumpT: 0, jumpCd: 0,
        stats, prevA: false, prevB: false, prevY: false,
      });
    }
  }
  if (cfg.practice) {
    // Straight into play — no countdown, no clock, no whistle to wait for.
    s.phase = 'play'; s.phaseT = 0;
    s.clock = s.timerLen = 9999;
    s.pResetT = 0;
    practiceSetup(s, cfg.practice === true ? {} : cfg.practice);
    practiceResetBall(s, 'feet');
  }
  return s;
}

function ev(s, type, data) { s.events.push({ t: type, ...data }); }

// ---- lag compensation -------------------------------------------------------
// A remote player is drawn to you as they were ~58ms ago, because that is when
// their position left their machine. So when you lunge at where you SEE someone,
// the live positions the sim tests against are not the ones you aimed at, and
// contact lands somewhere you never chose. The server therefore rewinds: an
// input carries the tick its sender was actually looking at, and contact is
// judged against the world as it was then.
//
// This lives in the sim, not the server, because a rollback client replays these
// same inputs and has to reach the same answer or it desyncs. vt travels in the
// input, so both sides rewind identically. AI inputs carry no vt and are judged
// live, which also keeps every offline result unchanged.
const LAGCOMP_MAX = 40;                  // ~0.67s of history is plenty

function pushHistory(s) {
  const h = s.hist || (s.hist = []);
  const row = new Float64Array(20);
  for (let i = 0; i < s.players.length; i++) { row[i * 2] = s.players[i].x; row[i * 2 + 1] = s.players[i].y; }
  h.push(row);
  if (h.length > LAGCOMP_MAX) h.shift();
}
// Where player i appeared to whoever sent this input, or null meaning "use now".
function seenAt(s, i, vt) {
  const h = s.hist;
  if (!vt || !h || !h.length) return null;
  const back = s.tick - vt;                      // how many ticks to wind back
  if (back <= 0 || back > h.length) return null;
  const row = h[h.length - back];
  return row ? [row[i * 2], row[i * 2 + 1]] : null;
}

// ---------------------------------------------------------- possession ------
function dropBall(s, popVz, spread) {
  const b = s.ball;
  if (b.owner >= 0) {
    b.z = 0.25;
    // pop away from the local crowd centroid so scrums self-clear
    let cx = 0, cy = 0, n = 0;
    for (const p of s.players) {
      if (p.keeper) continue;
      if (len(p.x - b.x, p.y - b.y) < 2.6) { cx += p.x; cy += p.y; n++; }
    }
    if (n >= 2) {
      let dx = b.x - cx / n, dy = b.y - cy / n;
      if (Math.abs(dx) + Math.abs(dy) < 0.05) { const [ux, uy] = randUnit(s); dx = ux; dy = uy; }
      const [ux, uy] = norm(dx, dy);
      const mag = 4.5 + rnd(s) * 2.5;
      b.vx = ux * mag + (rnd(s) - 0.5) * 2;
      b.vy = uy * mag + (rnd(s) - 0.5) * 2;
    } else {
      b.vx = (rnd(s) - 0.5) * (spread || 4);
      b.vy = (rnd(s) - 0.5) * (spread || 4);
    }
    b.vz = popVz || 2.5;
  }
  b.owner = -1; b.flight = null; b.pickupCd = 8;
}
function giveBall(s, i) {
  const b = s.ball;
  b.owner = i; b.flight = null; b.vx = b.vy = b.vz = 0;
  b.lastTouch = i;
  const p = s.players[i];
  p.holdT = 0;
  // one-timer resolution happens in flight arrival, not here
}

// -------------------------------------------------------------- actions -----
// A "perfect" pass is a threatening one: untouched through traffic, a real
// distance, AND arriving in range of the goal being attacked. Used both to award
// the buff on arrival and to paint the ball green while it's still travelling.
function passIsThreat(s, fl, r) {
  if (!fl || !fl.clean || fl.dist <= TUNE.perfectPassMinD) return false;
  const d = r.team === 0 ? 1 : -1;
  const gx = d * TUNE.pitchW / 2;
  if (len(gx - r.x, r.y) < TUNE.perfectPassZone) return true;
  // A ball threaded or bent past the back line is dangerous wherever it lands —
  // what makes it a chance is the defenders it took out of the play, not the
  // postcode it arrives in. A long one down the line counts.
  let beat = 0;
  if (fl.beat) for (const qi of fl.beat) if (s.players[qi].x * d < r.x * d) beat++;
  return beat >= TUNE.perfectPassBeat;
}

// A weighted pass goes WHERE YOU AIMED. The cursor picks the line, the charge
// picks the range and the pace, and holding a movement direction across that line
// bends it. Nobody is "selected" — the receiver is whoever happens to be nearest
// where the ball is going to arrive, which is what makes a cross to a runner a
// thing you executed rather than a thing the game did for you.
//
// This replaced a receiver-picking pass that, at full charge, played the ball
// `throughBallLead` (6.5m) BEYOND the chosen team-mate toward the goal. Near the
// box that lands inside the keeper's claim radius deterministically — which is
// why a charged pass on the edge of the area went to the opposing keeper every
// single time. It was not random and it was not the keeper being clever.
// Where a bent pass ACTUALLY ends up, by integrating the same curve the ball will
// experience. Mirrors ballUpdate()'s pass branch: the accel is applied square to
// the CURRENT velocity, so it rotates the heading — a straight-line extrapolation
// of a curling ball is wrong by the whole swing, and gets wronger the harder you
// bent it.
function flyPass(px, py, ux, uy, spd, curve, ticks) {
  const T = TUNE;
  let bx = px, by = py, vx = ux * spd, vy = uy * spd;
  for (let i = 0; i < ticks; i++) {
    if (curve) {
      const sp = len(vx, vy) || 1;
      const nx = -vy / sp, ny = vx / sp;
      vx += nx * curve * T.passCurveAccel * DT;
      vy += ny * curve * T.passCurveAccel * DT;
    }
    bx += vx * DT; by += vy * DT;
  }
  return [bx, by];
}

// Aiming has to survive bending. Without this, putting bend on a pass silently
// moved where it landed — so the ball curled away from the runner you pointed at,
// and no team-mate had any reason to be there. Rotate the launch until the BENT
// trajectory ends on the spot you picked. Three fixed-point steps is plenty.
function aimPassLaunch(px, py, lx, ly, spd, curve, ticks) {
  let [ux, uy] = norm(lx - px, ly - py);
  if (!curve) return [ux, uy];
  for (let i = 0; i < 3; i++) {
    const [ex, ey] = flyPass(px, py, ux, uy, spd, curve, ticks);
    const [cx, cy] = norm(ux + (lx - ex) / Math.max(len(lx - px, ly - py), 1),
                          uy + (ly - ey) / Math.max(len(lx - px, ly - py), 1));
    ux = cx; uy = cy;
  }
  return [ux, uy];
}

// Where the live pass is going to arrive. Used by the AI so a receiver runs onto
// the ball rather than at where it happens to be pointing this instant.
export function passLandingSpot(s) {
  const fl = s.ball.flight;
  if (!fl || (fl.type !== 'pass' && fl.type !== 'lobpass')) return null;
  if (fl.land) return fl.land;
  const b = s.ball, sp = len(b.vx, b.vy) || 1;
  const left = Math.max((fl.eta || 0) - fl.t, 0);
  if (!left) return { x: b.x, y: b.y };
  const [ex, ey] = flyPass(b.x, b.y, b.vx / sp, b.vy / sp, sp, fl.curve || 0, left);
  return { x: ex, y: ey };
}

function aimedPass(s, p, lob, power) {
  const b = s.ball, T = TUNE;
  const dTeam = p.team === 0 ? 1 : -1;
  // Aim: cursor if we have one, else the stick, else facing. Gamepad and keyboard
  // players still get a directional pass — they just aim with the stick.
  const [ax, ay] = p.inAx !== undefined ? [p.inAx, p.inAy]
    : (Math.abs(p.inMx) + Math.abs(p.inMy) > 0.2) ? norm(p.inMx, p.inMy) : [p.fx, p.fy];

  // How far it travels is entirely the charge — this is the thing players learn.
  const w = clamp((power - T.aimPassAt) / (1 - T.aimPassAt), 0, 1);
  const range = (T.aimPassRangeMin + (T.aimPassRangeMax - T.aimPassRangeMin) * w)
    + p.stats.pas * T.aimPassStatRange;
  const spd = T.aimPassSpeedMin + (T.aimPassSpeedMax - T.aimPassSpeedMin) * w
    + p.stats.pas * T.passPerStat;

  // Landing spot, kept on the pitch. Clamping rather than letting it fly out
  // means a badly over-charged ball still plays, it just hits the wall.
  const hx = T.pitchW / 2 - 0.6, hy = T.pitchH / 2 - 0.6;
  const lx = clamp(p.x + ax * range, -hx, hx);
  const ly = clamp(p.y + ay * range, -hy, hy);
  const d = Math.max(len(lx - p.x, ly - p.y), 1.2);
  const [nx, ny] = norm(lx - p.x, ly - p.y);
  const tAim = d / spd;

  // Receiver is derived, not chosen: nearest team-mate to where it will land.
  // Drives the one-timer arm and the perfect-pass paint. -1 is legal — a ball
  // played into space that nobody reaches is a miss you made, not a bug.
  let tgt = -1, bestD = T.aimPassTgtR;
  for (const q of s.players) {
    if (q.team !== p.team || q.i === p.i || q.keeper || q.off) continue;
    const qt = len(q.x + q.vx * tAim - lx, q.y + q.vy * tAim - ly);
    if (qt < bestD) { bestD = qt; tgt = q.i; }
  }

  // Bend first, then aim: the launch direction is corrected so the curled ball
  // still finishes on the spot you picked. Bend is a ROUTE control — it decides
  // which side of a defender the ball goes — not a way to move the destination.
  const bend = clamp((p.inMx * ny - p.inMy * nx) * w * T.passBend, -T.passBendMax, T.passBendMax);
  const flightTicks = Math.max(Math.round(tAim * TICK_RATE), 1);
  const [ax2, ay2] = aimPassLaunch(p.x, p.y, lx, ly, spd, bend, flightTicks);
  const nx2 = ax2, ny2 = ay2;

  b.owner = -1; b.lastTouch = p.i; b.pickupCd = 6;
  b.x = p.x + nx2 * 0.7; b.y = p.y + ny2 * 0.7;
  b.vx = nx2 * spd; b.vy = ny2 * spd;
  if (lob) {
    // The charge buys HEIGHT on a chip, not pace: a full-weight chip genuinely
    // loops a defender instead of skimming past their shins.
    const apex = T.aimChipApexMin + (T.aimChipApexMax - T.aimChipApexMin) * w;
    b.z = 0.4;
    b.vz = Math.sqrt(2 * T.ballGravity * apex);
    // re-pace so it lands at the aim point rather than short or long
    const tFlight = 2 * b.vz / T.ballGravity;
    const need = clamp(d / tFlight, 6, T.aimPassSpeedMax);
    b.vx = nx2 * need; b.vy = ny2 * need;
  } else { b.z = 0.3; b.vz = 0; }

  const beat = [];
  for (const q of s.players) {
    if (q.team === p.team || q.keeper || q.off) continue;
    if (q.x * dTeam > p.x * dTeam) beat.push(q.i);
  }
  b.flight = {
    type: lob ? 'lobpass' : 'pass', from: p.i, tgt, clean: true, aimed: true,
    dist: d, t: 0, eta: Math.round((lob ? d / len(b.vx, b.vy) : tAim) * TICK_RATE),
    curve: bend, beat, land: { x: lx, y: ly },
  };
  ev(s, 'PASS', { from: p.i, to: tgt, lob: !!lob, power, aimed: true, bend,
    lx: Math.round(lx * 10) / 10, ly: Math.round(ly * 10) / 10 });
}

function tryPass(s, p, lob, power = 0) {
  const b = s.ball;
  const T = TUNE;
  // A real hold means you are aiming, not asking. Only humans get this — the AI
  // has no cursor and its passing game is built on the auto-target scoring below.
  if (p.isHuman && power >= T.aimPassAt) return aimedPass(s, p, lob, power);
  // choose receiver: aim channel (mouse) wins, else movement direction, else facing
  const [ax, ay] = p.inAx !== undefined ? [p.inAx, p.inAy]
    : (Math.abs(p.inMx) + Math.abs(p.inMy) > 0.2) ? norm(p.inMx, p.inMy) : [p.fx, p.fy];
  const dTeam = p.team === 0 ? 1 : -1;
  const through = power >= T.throughBallAt;      // a charged pass is played into space
  let best = -1, bestScore = -Infinity;
  for (const q of s.players) {
    if (q.team !== p.team || q.i === p.i || q.keeper || q.off) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = len(dx, dy);
    if (d < 1) continue;
    const [nx, ny] = norm(dx, dy);
    const cos = nx * ax + ny * ay;
    if (cos < -0.25) continue;
    let open = 0;
    for (const o of s.players) if (o.team !== p.team && !o.keeper && !o.off) open += Math.min(len(o.x - q.x, o.y - q.y), 8);
    let score = cos * 2 + open * 0.03 - d * 0.02;
    // a through ball wants the runner in behind, not the safe man at your feet
    if (through) score += (q.x - p.x) * dTeam * 0.09 + Math.max(0, q.vx * dTeam) * 0.16;
    if (score > bestScore) { bestScore = score; best = q.i; }
  }
  if (best < 0) return;
  const r = s.players[best];
  const d = len(r.x - p.x, r.y - p.y);
  b.owner = -1; b.lastTouch = p.i; b.pickupCd = 6;
  const spd = ((lob ? T.lobPassSpeed : T.passSpeed) + p.stats.pas * T.passPerStat) * (1 + power * T.passPowerBonus);
  const t = d / spd;
  // lead the receiver — with no in-flight magnet this is the only thing making
  // a pass to a moving bean land. A through ball is deliberately played further
  // ahead of them, into the space rather than to the feet.
  const ahead = through ? (power * T.throughBallLead) : 0;
  const tx = r.x + r.vx * t * T.passLead + dTeam * ahead, ty = r.y + r.vy * t * T.passLead;
  const [nx, ny] = norm(tx - p.x, ty - p.y);
  // Only a through ball travels meaningfully past the receiver, so only then does
  // the flight time need recomputing — otherwise keep the original timing exactly,
  // since eta drives one-timer windows and the keeper's read.
  const tAim = ahead ? len(tx - p.x, ty - p.y) / spd : t;
  b.x = p.x + nx * 0.7; b.y = p.y + ny * 0.7;
  b.vx = nx * spd; b.vy = ny * spd;
  if (lob) { b.z = 0.4; b.vz = 0.5 * T.ballGravity * tAim; }   // arc that lands ~at receiver
  else { b.z = 0.3; b.vz = 0; }
  // Bend: hold a direction across the pass line while charging and it curves that
  // way. Scales with charge, so a tapped pass is always dead straight.
  // Only when the receiver was picked with the cursor — on the classic scheme the
  // movement stick IS the receiver picker, so bending with it would silently send
  // the ball to a different team-mate.
  const bend = p.inAx !== undefined
    ? clamp((p.inMx * ny - p.inMy * nx) * power * T.passBend, -T.passBendMax, T.passBendMax)
    : 0;
  // Who this ball has to get past: every outfield opponent currently goal-side of
  // the passer. If it lands with them behind the receiver, the pass broke the line.
  const beat = [];
  for (const q of s.players) {
    if (q.team === p.team || q.keeper || q.off) continue;
    if (q.x * dTeam > p.x * dTeam) beat.push(q.i);
  }
  b.flight = {
    type: lob ? 'lobpass' : 'pass', from: p.i, tgt: best, clean: true,
    dist: d, t: 0, eta: Math.round(tAim * TICK_RATE), curve: bend, beat,
  };
  ev(s, 'PASS', { from: p.i, to: best, lob: !!lob, power, through, bend });
}

// How hard must this ball curl to start at `launchY` and arrive at `targetY`?
//
// Solved by integrating the real trajectory rather than with a closed form. The
// closed form (displacement = 1/2*a*t^2) is wrong here by a factor that drifts
// with pace: the lateral accel is applied square to the CURRENT velocity, so it
// rotates the heading rather than pushing sideways in a fixed frame, and the ball
// drags the whole way. Two attempts to correct that with a tuned constant both
// produced a shot that bent correctly at one charge tier and missed the goal at
// another — which is exactly the trap the rest of this file keeps falling into.
//
// A dozen bisection steps over a ~60-step integration is nothing at shot rate,
// it uses only the constants the ball itself uses, and it stays deterministic.
// The payoff is that the aim promise becomes literal: the ball arrives where the
// cursor was, at every charge, from every angle.
function solveFinesseCurve(px, py, gx, targetY, launchY, power, side) {
  const T = TUNE;
  // Mirrors ballUpdate()'s shot branch exactly: the curve is a flat +Y
  // acceleration, NOT an accel square to the velocity. Modelling it as the latter
  // is what made two previous closed-form attempts miss.
  const fly = curve => {
    const [ux, uy] = norm(gx - px, launchY - py);
    let bx = px + ux * 0.7, by = py + uy * 0.7;   // ball spawns ahead of the boot
    let vx = ux * power, vy = uy * power;
    for (let i = 0; i < 90; i++) {
      // Same order as ballUpdate: curve, then drag, then integrate.
      vy += curve * T.curveAccel * DT;
      vx *= T.ballDragA; vy *= T.ballDragA;
      const nxp = bx + vx * DT, nyp = by + vy * DT;
      if ((gx > px && nxp >= gx) || (gx < px && nxp <= gx)) {
        const f = (gx - bx) / (nxp - bx || 1);
        return by + (nyp - by) * f;                    // y where it crosses the goal line
      }
      bx = nxp; by = nyp;
    }
    return by;
  };
  // Bisect on magnitude; `side` fixes the direction, so the crossing point is
  // monotonic in the magnitude and bisection is safe.
  //
  // The guard has to be a BRACKET test, not "is max better than zero". At full
  // curl the ball overshoots the corner by more than a straight ball undershoots
  // it, so a nearest-endpoint test rejects every solvable shot and silently
  // returns no bend at all — which is what it did.
  let lo = 0, hi = T.finesseCurveMax;
  const y0 = fly(0), yMax = fly(side * hi);
  if ((targetY - y0) * side <= 0) return 0;            // already there or past it
  if ((targetY - yMax) * side >= 0) return side * hi;  // can't curl that far; give it everything
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if ((targetY - fly(side * mid)) * side < 0) hi = mid; else lo = mid;
  }
  return side * ((lo + hi) / 2);
}

function launchShot(s, p, opts) {
  // opts: {stage, oneTimer, perfectOt, chip, curve}
  const b = s.ball;
  const gx = p.team === 0 ? TUNE.pitchW / 2 : -TUNE.pitchW / 2;
  const buff = p.buffT > 0 ? 1.5 : 0;
  let power = TUNE.shotBase + p.stats.sho * TUNE.shotPerStat + buff;
  // On a finesse, charge buys BEND, not pace. This is the whole point of the
  // button: you are not trying to hit it harder, you are trying to wrap it round
  // the keeper. Letting the full stage multiplier through was self-defeating —
  // a stage-3 finesse flew twice as fast, spent half as long in the air, and so
  // the curl had half the time to act. Measured: lateral deviation actually FELL
  // from 11.3m at a tap to 5.3m at a full hold. Charging made it bend less.
  power *= 1 + TUNE.stageMul[opts.stage || 0] * (opts.finesse ? TUNE.finesseStageMul : 1);
  if (opts.oneTimer) power += opts.perfectOt ? TUNE.perfectOtPower : TUNE.oneTimerPower;
  // Finesse trades pace for placement: it beats a keeper by angle, not speed, so
  // one with time to set still gets there. That's what stops it being strictly better.
  if (opts.finesse) power *= TUNE.finessePowerMul;
  if (opts.volley) power *= TUNE.volleyPowerMul;
  // Shots may now MISS. This used to clamp inside the frame, so every shot was on
  // target by construction — the posts were unreachable and woodwork impossible.
  const aimSpread = (TUNE.goalW / 2) + TUNE.aimWide;
  let aimY = clamp(p.inMy * 3.0 + (opts.aimNoise || 0), -aimSpread, aimSpread);
  if (opts.aimY !== undefined) aimY = clamp(opts.aimY + (opts.aimNoise || 0), -aimSpread, aimSpread);
  // Finesse curls: launch it INSIDE the spot you picked and let the bend carry it
  // back out to the corner, so it visibly arcs around the keeper and still arrives.
  // Finesse: bend it round the keeper into the side netting. You launch INSIDE the
  // spot you picked and the curl carries the ball back out to it, so it visibly
  // arcs around the keeper rather than flying at him.
  //
  // The inset and the curl are NOT two independent knobs. The curl has to carry
  // the ball back out by exactly the inset over exactly this flight, or the shot
  // arrives somewhere you did not aim. Tuning them separately is how the previous
  // pass ended up bending LESS at full charge than at a tap. So: pick the inset
  // from the charge, then SOLVE for the curl.
  //
  //   lateral displacement = 1/2 * a * t^2,  a = curve * curveAccel,  t = d / power
  //   => curve = 2 * inset / (curveAccel * t^2)
  //
  // which holds at any charge, any range and any pace, by construction.
  // Finesse is placement, not power. The shape it is trying to reproduce is the
  // one a real player hits from the top corner of the box: the ball leaves on a
  // line that looks like it is going straight at the keeper, and bends away late
  // into the far corner. One-on-one, you place it around him rather than through
  // him.
  //
  // That means the launch line is anchored to WHERE THE KEEPER ACTUALLY IS, not
  // to the middle of the goal. A keeper who has come out to narrow the angle
  // changes the shot; a fixed geometric inset would not notice him at all.
  // The shape: the ball leaves on a line that is going WIDE — outside the post,
  // away from the keeper, looking like it will miss — and then curls back in and
  // tucks inside the post you picked. That is the shot a real player hits from the
  // top corner of the box, and it beats a keeper because for most of its flight it
  // is nowhere near him; he has no reason to come, and by the time it turns in he
  // cannot.
  //
  // Note this is the OPPOSITE arc from launching at him and curling away. Both
  // "bend", but only this one goes around the outside of the keeper.
  let finesseCurve = 0, finesseInset = 0, finesseSide = 1;
  const finesseTargetY = aimY;                        // where the player actually pointed
  if (opts.finesse) {
    const w = clamp((opts.stage || 0) / 3, 0, 1);
    const k = s.players[(1 - p.team) * 5 + 4];
    const kY = (k && !k.off) ? k.y : 0;
    // Swing out on the side of the goal you aimed at, i.e. away from the keeper.
    finesseSide = Math.sign(aimY - kY) || Math.sign(aimY) || (Math.sign(-p.y) || 1);
    // How far outside the post the ball is launched. Holding it longer buys a
    // wider arc, so a fully-weighted one looks like it is going out for a throw
    // before it comes back.
    // How much you can bend it is a shooting stat, not a free action. A 10-rated
    // finisher wraps it round him; a 2 barely moves it. This is where "the better
    // shooter you are, the more you can do this" actually lives.
    const skill = clamp(0.35 + p.stats.sho * TUNE.finesseShoScale, 0.35, 1.25);
    const budget = (TUNE.finesseInset + (TUNE.finesseInsetMax - TUNE.finesseInset) * w) * skill;
    const outLimit = TUNE.goalW / 2 + TUNE.finesseOutMax;
    const launchAt = clamp(aimY + finesseSide * budget, -outLimit, outLimit);
    finesseInset = Math.abs(launchAt - finesseTargetY);
    aimY = launchAt;
  }
  const dx = gx - p.x, dy = aimY - p.y, d = len(dx, dy);
  if (opts.finesse && finesseInset > 0) {
    // aimY is now the WIDE launch line; solve the curl that brings it back INWARD
    // to the spot the player picked. Hence -finesseSide.
    // Weight it wrong and it does not come back to where you pointed. The error is
    // an ABSOLUTE distance at the goal line, not a fraction of the curl — as a
    // fraction, a small tapped swing came out accurate and a big committed one came
    // out wild, which is exactly backwards. Now: rushing it is bad, being a poor
    // finisher is bad, and doing both puts it in the side netting or over the bar.
    const wF = clamp((opts.stage || 0) / 3, 0, 1);
    const miss = Math.max(TUNE.finesseMissFloor,
      (1 - p.stats.sho * TUNE.finesseShoErr) * 0.55 + (1 - wF) * 0.45);
    const missY = gauss(s) * miss * TUNE.finesseLatErr;
    opts.zErr = (opts.zErr || 0) + gauss(s) * miss * TUNE.finesseZErr;
    finesseCurve = solveFinesseCurve(
      p.x, p.y, gx, finesseTargetY + missY, aimY, power, -finesseSide);
    // And the weight of the strike itself. Under-curl a wide arc and it simply
    // never comes back — that is the shot that sails past the far post, and it is
    // the honest punishment for launching it that wide without the technique to
    // bring it home. Over-curl and it wraps too far, back toward the keeper.
    finesseCurve *= 1 + gauss(s) * miss * TUNE.finesseWeightErr;
  }
  let [nx, ny] = norm(dx, dy);
  // banana shots: launch angled away from the target, curve accel bends them back in.
  // Finesse is deliberately EXCLUDED from the launch rotation — its offset is the
  // inset above, and rotating as well would double-count and overshoot the corner.
  const curveAmt = ((opts.curve || 0) * (1 + (opts.stage || 0) * 0.8)) + finesseCurve;
  const rotAmt = (opts.curve || 0) * (1 + (opts.stage || 0) * 0.8);
  if (rotAmt && !opts.chip) {
    // Parameterised by tangent rather than angle so the rotation needs no trig.
    // tan(0.34) = 0.354, so the clamp covers the same cone as before.
    const [rx, ry] = rotT(nx, ny, clamp(-rotAmt * 0.10, -0.354, 0.354));
    nx = rx; ny = ry;
  }
  b.owner = -1; b.lastTouch = p.i; b.pickupCd = TUNE.pickupCd;
  b.x = p.x + nx * 0.7; b.y = p.y + ny * 0.7;
  b.z = 0.4;
  if (opts.chip) {
    // A chip has one job: get over the man in front of you and come down before
    // the bar. So solve it against the keeper's ACTUAL position and reach rather
    // than arcing to a fixed height and hoping.
    //
    // Two constraints, one free parameter. Pick the flight time T to the goal
    // line; that fixes the horizontal pace (d/T) and the launch vz needed to
    // arrive under the bar. Then check the height where it passes the keeper. Too
    // low? Loop it more. This is why a chip over a keeper who has come out looks
    // completely different from one at a keeper on his line — because it is.
    const T2 = TUNE, g = T2.ballGravity;
    const k2 = s.players[(1 - p.team) * 5 + 4];
    const zGoal = Math.max(T2.goalH - T2.chipBarMargin, 0.8);
    // how far along the flight the keeper stands, and how high he can get there
    let fK = 0.5, clearZ = 0;
    if (k2 && !k2.off) {
      const dK = len(k2.x - b.x, k2.y - b.y);
      fK = clamp(dK / Math.max(d, 0.1), 0.05, 0.95);
      const big = k2.st === 'kout' ? T2.keeperBigZ : 0;
      clearZ = T2.keeperJumpZ + big + T2.chipClearMargin;
    }
    let bestT = 0.55, ok2 = false;
    for (let i = 0; i < 16; i++) {
      const tT = 0.45 + i * (T2.chipMaxT - 0.45) / 15;
      const vz0 = (zGoal - b.z) / tT + 0.5 * g * tT;
      const tK = tT * fK;
      const zK = b.z + vz0 * tK - 0.5 * g * tK * tK;
      bestT = tT;
      if (zK >= clearZ) { ok2 = true; break; }
    }
    if (!ok2) bestT = T2.chipMaxT;          // loop it as hard as we can and hope
    const need = clamp(d / bestT, T2.chipSpeedMin, T2.chipSpeedMax);
    b.vx = nx * need; b.vy = ny * need;
    // recompute vz against the pace we actually got after clamping
    const tReal = d / Math.max(need, 0.1);
    b.vz = (zGoal - b.z) / tReal + 0.5 * g * tReal;
  } else {
    const spd = power;
    b.vx = nx * spd; b.vy = ny * spd;
    // aim to cross the line at a chosen height — harder shots get lifted
    let aimZ = opts.aimZ !== undefined
      ? opts.aimZ + (opts.zErr || 0)                       // you picked the height with the cursor
      : TUNE.shotZBase + (opts.stage || 0) * TUNE.shotZPerStage
        + (opts.oneTimer ? TUNE.shotZOneTimer : 0)
        + (opts.zNoise || 0) * TUNE.shotZSpread;
    if (opts.volley) aimZ += TUNE.volleyLift;              // struck out of the air, so it flies higher
    aimZ = clamp(aimZ, 0.12, TUNE.goalH + TUNE.aimHigh);   // may sail over the bar
    const tG = Math.max(d / spd, 0.08);
    b.vz = (aimZ - b.z) / tG + 0.5 * TUNE.ballGravity * tG;
  }
  s.shotSeq++;
  b.flight = {
    type: 'shot', id: s.shotSeq, shooter: p.i, team: p.team,
    stage: opts.stage || 0, power, chip: !!opts.chip,
    curve: curveAmt, finesse: !!opts.finesse, finesseW: clamp((opts.stage || 0) / 3, 0, 1),
    backspin: opts.chip ? TUNE.chipBackspin : 0,
    oneTimer: !!opts.oneTimer, perfectOt: !!opts.perfectOt,
    otPenalty: opts.oneTimer ? (opts.perfectOt ? 5 : 4) : 0,
    tgt: { x: gx, y: opts.finesse ? finesseTargetY : aimY }, t: 0,
  };
  if (p.buffT > 0) p.buffT = 0;
  ev(s, 'SHOT', { p: p.i, stage: opts.stage || 0, oneTimer: !!opts.oneTimer, perfect: !!opts.perfectOt, chip: !!opts.chip });
  if (opts.perfectOt) ev(s, 'PERFECT_OT', { p: p.i });
}

function startSlide(s, p) {
  p.st = 'slide'; p.stT = TUNE.slideDur; p.cdSlide = TUNE.slideCd + TUNE.slideDur;
  const sp = maxSpeed(p) * TUNE.slideMul;
  p.vx = p.fx * sp; p.vy = p.fy * sp;
  ev(s, 'SLIDE', { p: p.i });
}
// Is a ball on its way to this bean? Either a pass aimed at them, or a loose ball
// dropping onto them. Drives the one-timer arm, the auto-leap, and — importantly —
// stops the shoot button turning into a slide tackle while you wait for it.
function ballIncoming(s, p) {
  const b = s.ball, T = TUNE;
  if (b.owner === p.i) return null;
  const fl = b.flight;
  const targeted = !!fl && (fl.type === 'pass' || fl.type === 'lobpass') && fl.tgt === p.i;
  const d = len(b.x - p.x, b.y - p.y);
  const sp = len(b.vx, b.vy);
  if (!targeted) {
    // An untargeted ball only counts if it's properly up in the air, close, closing,
    // and I'm the nearest to it. Without the nearest test the whole box leaps at
    // every bouncing ball — it measured 164 leaps a match.
    if (b.owner >= 0 || b.z < T.incomingMinZ || d > T.incomingR) return null;
    if (sp > 0.5) {
      const [ux, uy] = norm(b.vx, b.vy);
      if ((p.x - b.x) * ux + (p.y - b.y) * uy < 0) return null;      // heading away
    }
    for (const q of s.players) {
      if (q.i === p.i || q.keeper) continue;
      if (len(q.x - b.x, q.y - b.y) < d) return null;                // someone else is closer
    }
  }
  const t = sp > 0.5 ? d / sp : 0;
  const zAt = b.z + b.vz * t - 0.5 * T.ballGravity * t * t;          // height when it reaches me
  return { targeted, t, zAt, d };
}

function startBigHit(s, p, charge = 0) {
  p.st = 'bighit'; p.stT = TUNE.bhWindup + TUNE.bhActive + TUNE.bhSettle;
  p.bhHit = false;
  p.bhPower = 1 + charge * TUNE.bhChargeBonus;    // 1.0 tap → full charge multiplier
  p.bhCharge = charge;
  ev(s, 'BIGHIT_START', { p: p.i });
}
function startDeke(s, p) {
  p.st = 'deke'; p.stT = TUNE.dekeDur; p.cdDeke = TUNE.dekeCd + TUNE.dekeDur;
  const sp = maxSpeed(p) * TUNE.dekeMul;
  // You dash exactly where you're holding. Only with no stick input does it fall
  // back to picking a side of your facing.
  let dx, dy;
  if (len(p.inMx, p.inMy) > 0.2) {
    [dx, dy] = norm(p.inMx, p.inMy);
  } else {
    const dir = rnd(s) < 0.5 ? 1 : -1;
    dx = p.fy * dir; dy = -p.fx * dir;
  }
  p.vx = dx * sp; p.vy = dy * sp;
  ev(s, 'DEKE', { p: p.i });
}
// forceKb overrides the hitter-derived knockback (used by shots flattening people)
function knockDown(s, victim, dirX, dirY, hitter, forceKb) {
  const st = hitter ? hitter.stats.hit : 5;
  const pw = (hitter && hitter.bhPower) || 1;      // charged hits launch harder
  dropIfCarrier(s, victim);
  victim.st = 'down';
  victim.stT = Math.round((TUNE.bhDownBase + st * TUNE.bhDownPerStat) * (1 + (pw - 1) * 0.5));
  const kb = forceKb !== undefined ? forceKb : (TUNE.bhKnockBase + st * TUNE.bhKnockPerStat) * pw;
  victim.vx = dirX * kb; victim.vy = dirY * kb;
  victim.charging = false; victim.chargeT = 0;
}
function dropIfCarrier(s, p) {
  if (s.ball.owner === p.i) dropBall(s, 2.8, 5);
}

// ---------------------------------------------------------------- step ------
export function step(s, inputs) {
  s.events = [];
  // Snapshot positions BEFORE anything moves, so history[tick] is the world as it
  // was rendered at that tick — which is what a client actually saw.
  pushHistory(s);
  s.tick++;
  const T = TUNE, b = s.ball;

  // ---- phase machine
  if (s.phase === 'countdown') {
    s.phaseT--;
    // glide players to formation
    for (const p of s.players) {
      if (p.off) continue;
      const [tx, ty] = formationSpot(p.team, p.slot, s.kickoffTeam);
      p.x += (tx - p.x) * 0.14; p.y += (ty - p.y) * 0.14;
      p.vx = p.vy = 0; p.st = 'norm'; p.stT = 0; p.recT = 0; p.charging = false; p.chargeT = 0;
      p.fx = p.team === 0 ? 1 : -1; p.fy = 0;
    }
    b.x = 0; b.y = 0; b.z = 0.11; b.vx = b.vy = b.vz = 0; b.owner = -1; b.flight = null; b.pickupCd = 0;
    if (s.phaseT <= 0) {
      s.phase = 'play';
      // The side that was just scored on restarts WITH the ball, rather than the
      // centre spot being a scramble.
      giveBall(s, s.kickoffTeam * 5);
      ev(s, 'WHISTLE', {});
    }
    return;
  }
  if (s.phase === 'goalcele') {
    s.phaseT--;
    // A HUMAN can skip, and only after the celebration has had a moment to play.
    // This used to accept any input at all — and the AI holds buttons constantly,
    // so the bots cut every celebration to 12 ticks before anyone saw it.
    const elapsed = T.goalCeleT - s.phaseT;
    if (inputs && elapsed > T.goalCeleMinT) {
      for (const inp of inputs) {
        if (inp && inp.human && (inp.aHeld || inp.bHeld || inp.yHeld)) { s.phaseT = Math.min(s.phaseT, 12); break; }
      }
    }
    if (s.phaseT <= 0) {
      if (s.overtime || (s.clock <= 0 && s.score[0] !== s.score[1])) { s.phase = 'over'; ev(s, 'FULLTIME', {}); }
      else { s.phase = 'countdown'; s.phaseT = T.countdownShortT; }   // quicker restart after goals
    }
    return;
  }
  if (s.phase === 'over') return;

  // ---- practice: the ball sits in the net for a beat, then comes back to you
  if (s.practice && s.pResetT > 0) {
    s.pResetT--;
    if (s.pResetT <= 0) practiceResetBall(s, 'feet');
  }

  // ---- clock
  if (s.practice) { /* no clock in practice — the session ends when you stop */ }
  else if (!s.overtime) {
    s.clock -= DT;
    if (s.clock <= 0) {
      s.clock = 0;
      if (s.score[0] === s.score[1] && s.cfg.goldenGoal) { s.overtime = true; ev(s, 'OVERTIME', {}); }
      else { s.phase = 'over'; ev(s, 'FULLTIME', {}); return; }
    }
  }

  // ---- timers & input edges
  for (const p of s.players) {
    const inp = (inputs && inputs[p.i]) || NEUTRAL_INPUT;
    p.inMx = clamp(inp.mx || 0, -1, 1); p.inMy = clamp(inp.my || 0, -1, 1);
    // the tick this input was aimed at, for lag compensation (AI sends none)
    p.inVt = inp.vt || 0;
    // optional aim channel (mouse scheme): unit direction from player toward cursor
    if (typeof inp.ax === 'number' && typeof inp.ay === 'number' && isFinite(inp.ax) && isFinite(inp.ay) && (inp.ax || inp.ay)) {
      const al = len(inp.ax, inp.ay) || 1;
      p.inAx = inp.ax / al; p.inAy = inp.ay / al;
    } else { p.inAx = undefined; p.inAy = undefined; }
    p.inSprint = !!inp.sprint;
    p.aHeld = !!inp.aHeld;
    p.aEdge = !!inp.aHeld && !p.prevA; p.aRel = !inp.aHeld && p.prevA; p.prevA = !!inp.aHeld;
    p.bHeld = !!inp.bHeld; p.bEdge = !!inp.bHeld && !p.prevB; p.bRel = !inp.bHeld && p.prevB; p.prevB = !!inp.bHeld;
    p.isHuman = !!inp.human;
    p.inAz = typeof inp.az === 'number' ? inp.az : undefined;   // cursor height on the goal
    p.inAgy = typeof inp.agy === 'number' ? inp.agy : undefined; // cursor across the goal
    p.yHeld = !!inp.yHeld;
    p.yEdge = !!inp.yHeld && !p.prevY; p.yRel = !inp.yHeld && p.prevY; p.prevY = !!inp.yHeld;
    p.lobHeld = !!inp.lobHeld;
    p.finesse = !!inp.finesse;
    if (p.stT > 0) p.stT--;
    if (p.stT <= 0 && p.st !== 'norm') {
      if (p.st === 'slide') p.recT = Math.max(p.recT, T.slideRecover);
      if (p.st === 'down' || p.st === 'zap' || p.st === 'trip') p.immuneT = T.immuneAfterDown;
      if (p.st === 'bighit' && !p.bhHit) p.recT = Math.max(p.recT, T.bhRecWhiff);
      if (p.st === 'kstun') { /* keeper recovered */ }
      p.st = 'norm';
    }
    if (p.recT > 0) p.recT--;
    if (p.cdBigHit > 0) p.cdBigHit--;
    if (p.cdDeke > 0) p.cdDeke--;
    if (p.cdSlide > 0) p.cdSlide--;
    if (p.leapCd > 0) p.leapCd--;
    if (p.immuneT > 0) p.immuneT--;
    if (p.buffT > 0) p.buffT--;
    if (p.stunImmuneT > 0) p.stunImmuneT--;
  }
  if (b.pickupCd > 0) b.pickupCd--;

  // ---- player control & actions
  for (const p of s.players) {
    if (p.off) continue;    // not in this practice session
    if (p.keeper) continue; // keeper handled separately
    // 'leap' is cosmetic — you rise to meet the ball but keep full control. Making
    // it a blocking state cost 0.37s of agency every time and measurably hurt play
    // (goals 3.65 -> 2.5, Legend 6/6 -> 5/6). Jumping should never take the
    // controller off you.
    const canAct = (p.st === 'norm' || p.st === 'leap') && p.recT <= 0;
    const hasBall = b.owner === p.i;

    // movement
    // Shared with the client's prediction — see moveStep. Only a deliberate hold
    // slows you; that used to bite on the very first tick, so every tapped hit
    // began with a lurch down to 62% speed.
    if (canAct) {
      moveStep(p, hasBall, DT);
    } else if (p.st === 'down' || p.st === 'zap') {
      p.vx *= T.bhDownDrag; p.vy *= T.bhDownDrag;   // launched: skid, don't stop dead
    } else if (p.st === 'trip' || p.st === 'norm' || p.st === 'volley') {
      p.vx *= 0.86; p.vy *= 0.86;
    }

    // actions
    if (hasBall || !canAct) p.bhChargeT = 0;   // can't hold a wind-up through a tackle or a pickup
    if (!hasBall || !canAct) p.passChargeT = 0;   // lost the ball mid-wind-up: no banked pass
    if (canAct && hasBall) {
      // A wind-up is no longer a commitment. Pass or deke both bail out of a
      // charging shot, and a deke bails out of a charging pass. Each bail locks
      // that button until it's released, otherwise the finger still holding it
      // just starts a fresh charge on the very next tick.
      if (!p.bHeld) p.shotLocked = false;
      if (!p.aHeld) p.passLocked = false;
      const dekeNow = p.yEdge && p.cdDeke <= 0;
      if (p.charging && (p.aEdge || dekeNow)) {
        p.charging = false; p.chargeT = 0; p.shotLocked = true;
        ev(s, 'CHARGE_CANCEL', { p: p.i });
      }
      if ((p.passChargeT || 0) > 0 && dekeNow) {
        p.passChargeT = 0; p.passLocked = true;
        ev(s, 'CHARGE_CANCEL', { p: p.i });
      }

      // charging shot
      if (p.bHeld && !p.shotLocked) { p.charging = true; p.chargeT++; }
      if (p.bRel && p.charging) {
        const ct = p.chargeT;
        let stage = 0;
        if (ct >= T.chargeStageT[2]) stage = 3; else if (ct >= T.chargeStageT[1]) stage = 2; else if (ct >= T.chargeStageT[0]) stage = 1;
        const opts = { stage, chip: p.lobHeld, curve: p.inMy * 0.6, aimNoise: p.inSprint ? gauss(s) * 0.8 : 0,
          zNoise: gauss(s), finesse: p.finesse && !p.lobHeld };
        const gx2 = p.team === 0 ? T.pitchW / 2 : -T.pitchW / 2;
        if (p.inAx !== undefined) {
          const dx2 = gx2 - p.x;
          if (dx2 * p.inAx > 0 && Math.abs(p.inAx) > 0.05) {
            opts.aimY = p.y + (p.inAy / p.inAx) * dx2;   // cursor ray ∩ goal line (launchShot clamps)
          }
        }
        // Mouse pointing straight at the net wins: it's literally where you aimed.
        // Movement-derived curve is dropped while doing so — otherwise running
        // bends the ball away from the spot you just picked, which reads as the
        // aim being broken rather than as a curve.
        if (p.inAgy !== undefined) { opts.aimY = p.inAgy; opts.curve = 0; }
        if (p.inAz !== undefined) opts.aimZ = p.inAz;
        // Placement is a skill check, not a guarantee — error grows with range and
        // with how fast you're moving, and a good Shot stat cuts it down.
        if (p.isHuman) {
          const rng = len(gx2 - p.x, p.y);
          let spread = (T.aimErrBase + rng * T.aimErrPerDist + len(p.vx, p.vy) * T.aimErrPerSpeed)
            * Math.max(0.35, 1 - p.stats.sho * T.aimErrShoRelief)
            * (p.inSprint ? 1.35 : 1);
          // Finesse: charge buys precision. Scaled across the tiers rather than a
          // flat multiplier, so holding it is what makes it a placed shot.
          if (opts.finesse) {
            const fw = clamp(stage / 3, 0, 1);
            spread *= T.finesseAimTap + (T.finesseAimFull - T.finesseAimTap) * fw;
          }
          opts.aimNoise = gauss(s) * spread;
          opts.zNoise = 0;
          opts.zErr = gauss(s) * spread * 0.55;
        }
        launchShot(s, p, opts);
        p.charging = false; p.chargeT = 0;
      }
      // Pass: hold for pace. A tap fires the same pass it always did (charge ~0);
      // hold and it goes harder, gets played into space, and takes your bend.
      if (!p.charging && !p.isHuman) {
        if (p.aEdge) tryPass(s, p, p.lobHeld);       // AI passes instantly, as it always has
      } else if (!p.charging) {
        if (p.aHeld && !p.passLocked) {
          p.passChargeT = Math.min((p.passChargeT || 0) + 1, T.passChargeMax);
          if (p.passChargeT >= T.passChargeMax) {      // never feels dead at full load
            tryPass(s, p, p.lobHeld, 1); p.passChargeT = 0;
          }
        } else if (p.aRel && (p.passChargeT || 0) > 0) {
          tryPass(s, p, p.lobHeld, (p.passChargeT || 0) / T.passChargeMax);
          p.passChargeT = 0;
        }
      }
      if (p.yEdge && p.cdDeke <= 0 && !p.charging) startDeke(s, p);
    } else {
      if (p.charging) { p.charging = false; p.chargeT = 0; }
      // A ball on its way to you takes over the shoot button entirely. It used to
      // only count when the flight's tgt was exactly you, so a loose airborne ball,
      // a deflection, or a lob whose flight had expired all fell through and you
      // slide-tackled thin air instead of striking it.
      // Deliberately NOT gated on canAct. It used to be, which meant a press while
      // sliding or recovering saw inc === null and never armed — so mashing before
      // the pass was even played slide-tackled thin air, and you were still picking
      // yourself up when the ball landed. You trapped it and your next press was a
      // limp stage-0 shot. Arming during recovery is what makes mashing work.
      const inc = !hasBall ? ballIncoming(s, p) : null;
      // Arming is deliberately generous — any press inside 0.75s of arrival pops a
      // one-timer, so mashing at an incoming ball works. But re-stamping the tick on
      // every press meant a masher sat permanently inside the 9-tick window and got
      // the *power* version every time. Count the presses: spam still gets you the
      // one-timer, it just doesn't get you the rocket.
      if (inc && p.bEdge) {
        const stale = p.otArm < 0 || (s.tick - p.otArm) > T.otArmWindow;
        p.otPress = stale ? 1 : p.otPress + 1;
        p.otArm = s.tick;
      }
      // dropping ball: go up and meet it rather than waiting for it to land
      // Only leave the ground for a ball that's genuinely up there. A leap costs
      // 0.37s of control, so triggering it on a half-bouncing ball would feel like
      // the game taking the controller off you.
      if (inc && p.st === 'norm' && inc.zAt > T.leapMinZ && inc.t < T.leapLead && (p.leapCd || 0) <= 0) {
        p.st = 'leap'; p.stT = T.leapDur; p.leapCd = T.leapCdT;
        ev(s, 'LEAP', { p: p.i });
      }
      if (canAct && !hasBall) {
        if (p.bEdge && !inc && p.cdSlide <= 0) startSlide(s, p);   // never slide onto your own ball
        // charged big hit: hold to wind up, release to throw it. A tap still
        // fires the same hit it always did (charge ~0).
        if (p.cdBigHit <= 0) {
          if (p.yHeld) {
            p.bhChargeT = Math.min((p.bhChargeT || 0) + 1, T.bhChargeMax);
            // fire by itself at full load, so holding never feels dead
            if (p.bhChargeT >= T.bhChargeMax) { startBigHit(s, p, 1); p.bhChargeT = 0; }
          } else if (p.yRel && (p.bhChargeT || 0) > 0) {
            startBigHit(s, p, (p.bhChargeT || 0) / T.bhChargeMax);
            p.bhChargeT = 0;
          }
        } else p.bhChargeT = 0;
      }
    }

    // scripted-state motion
    if (p.st === 'bighit') {
      const t = (T.bhWindup + T.bhActive + T.bhSettle) - p.stT;
      if (t >= T.bhWindup && t < T.bhWindup + T.bhActive) {
        const sp = maxSpeed(p) * T.bhMul * (1 + ((p.bhPower || 1) - 1) * 0.45);
        p.vx = p.fx * sp; p.vy = p.fy * sp;
        // contact check
        for (const q of s.players) {
          if (q.team === p.team || q.keeper || q.off) continue;
          if (q.immuneT > 0 || q.st === 'down' || q.st === 'zap') continue;
          const reach = T.bhReach + 0.28 * q.stats.size;
          // judge the hit against where the hitter actually saw them
          const sq = seenAt(s, q.i, p.inVt);
          const qx = sq ? sq[0] : q.x, qy = sq ? sq[1] : q.y;
          if (len(qx - p.x, qy - p.y) < reach + T.playerR) {
            const hadBall = b.owner === q.i;
            knockDown(s, q, p.fx, p.fy, p);
            p.bhHit = true;
            p.st = 'norm'; p.stT = 0;
            p.vx = 0; p.vy = 0;
            if (hadBall) { p.recT = T.bhRecCarrier; }
            else { p.recT = T.bhRecOffBall; p.cdBigHit = T.bhCdOffBall; }
            ev(s, 'BIG_HIT', { p: p.i, v: q.i, hadBall, charge: p.bhCharge || 0 });
            break;
          }
        }
      } else if (t >= T.bhWindup + T.bhActive) { p.vx *= 0.7; p.vy *= 0.7; }
      else { p.vx *= 0.5; p.vy *= 0.5; }
    }
    if (p.st === 'slide') {
      p.vx *= 0.965; p.vy *= 0.965;
      // tackle check
      for (const q of s.players) {
        if (q.team === p.team || q.keeper || q.off) continue;
        const carrier = b.owner === q.i;
        const reach = T.tackleBaseR + p.stats.tkl * T.tackleRangePerStat + 0.22 * q.stats.size;
        const sq = seenAt(s, q.i, p.inVt);
        const qx = sq ? sq[0] : q.x, qy = sq ? sq[1] : q.y;
        if (len(qx - p.x, qy - p.y) < reach + T.playerR) {
          if (q.st === 'deke') continue;               // deke beats slides
          if (!carrier) continue;
          const behind = (p.fx * q.fx + p.fy * q.fy) > 0.55;
          if (behind) {
            // from behind: both go down
            dropBall(s, 2.5, 5);
            q.st = 'trip'; q.stT = T.tripDur; q.charging = false; q.chargeT = 0;
            p.st = 'trip'; p.stT = T.tripDur;
            ev(s, 'TACKLE_FOULISH', { p: p.i, v: q.i });
          } else {
            q.st = 'trip'; q.stT = T.tripDur - 6; q.charging = false; q.chargeT = 0;
            giveBall(s, p.i);
            p.st = 'norm'; p.stT = 0; p.recT = 12;
            ev(s, 'STEAL', { p: p.i, v: q.i });
          }
          break;
        }
      }
      // slide onto a loose ball
      if (b.owner < 0 && !b.flight && b.pickupCd <= 0 && b.z < 1.0 &&
          len(b.x - p.x, b.y - p.y) < T.catchR) {
        giveBall(s, p.i); p.st = 'norm'; p.stT = 0; p.recT = 10;
      }
    }
    if (p.st === 'deke') { p.vx *= T.dekeDrag; p.vy *= T.dekeDrag; }
  }

  // ---- integrate players, walls, zap
  for (const p of s.players) {
    if (p.off) continue;    // stays parked; must not be clamped back onto the pitch
    p.x += p.vx * DT; p.y += p.vy * DT;
    const hx = T.pitchW / 2 - T.playerR, hy = T.pitchH / 2 - T.playerR;
    let hitWall = false;
    if (p.x < -hx) { p.x = -hx; hitWall = true; } if (p.x > hx) { p.x = hx; hitWall = true; }
    if (p.y < -hy) { p.y = -hy; hitWall = true; } if (p.y > hy) { p.y = hy; hitWall = true; }
    if (hitWall && p.st === 'down' && len(p.vx, p.vy) > T.zapSpeedMin) {
      p.st = 'zap'; p.stT = T.zapDur + p.stT; p.vx = 0; p.vy = 0;
      ev(s, 'ZAP', { p: p.i });
    }
    if (hitWall) { p.vx *= 0.4; p.vy *= 0.4; }
  }
  // gentle player-player separation (same team mostly, avoid stacking)
  for (let a = 0; a < s.players.length; a++) {
    for (let c = a + 1; c < s.players.length; c++) {
      const p = s.players[a], q = s.players[c];
      if (p.off || q.off) continue;
      const dx = q.x - p.x, dy = q.y - p.y, d = len(dx, dy);
      const min = T.playerR * (p.stats.size + q.stats.size);
      if (d < min && d > 0.001) {
        const push = (min - d) / 2, nx = dx / d, ny = dy / d;
        p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push;
      }
    }
  }

  // ---- keepers
  for (let team = 0; team < 2; team++) {
    if (s.players[team * 5 + 4].off) continue;
    keeperUpdate(s, team, inputs);
  }

  // ---- ball
  ballUpdate(s);

  // ---- goal check
  goalCheck(s);
}

// -------------------------------------------------------------- keeper ------
function keeperUpdate(s, team, inputs) {
  const T = TUNE, b = s.ball;
  const k = s.players[team * 5 + 4];
  const kb = s.keeper[team];
  const d = team === 0 ? 1 : -1;               // attack dir; own goal at -d*21
  const goalX = -d * (T.pitchW / 2);
  const lineX = goalX + d * T.keeperLine;
  if (k.stT > 0) { /* ticked in main loop */ }
  if (k.st === 'kstun') { k.diveT = 0; k.vx *= 0.8; k.vy *= 0.8; return; }
  if (s.phase !== 'play') { k.diveT = 0; k.diveCd = 0; k.kchkCd = 0; }
  if (k.kchkCd > 0) k.kchkCd--;
  if (k.jumpCd > 0) k.jumpCd--;

  // ---- jump for a lofted ball ---------------------------------------------
  // Anything looping toward the goal — a chip, a lob, a cross — he can leave the
  // ground for. If it is inside his stretch he plucks it out of the air. If it is
  // over that, it is over: he lands, and whatever happens next happens without
  // him. No fudge factor, no last-second extension. Beating a keeper in the air
  // has to be a real thing you can do or the chip is worthless.
  if (k.jumpT > 0) {
    k.jumpT--;
    const up = Math.sin((1 - k.jumpT / T.keeperJumpDur) * Math.PI);   // 0 -> 1 -> 0
    const reach = T.keeperJumpMinZ + (T.keeperJumpZ - T.keeperJumpMinZ) * up;
    if (b.owner < 0 && b.pickupCd <= 0 && b.z <= reach
        && len(b.x - k.x, b.y - k.y) < T.keeperJumpR) {
      const wasShot = b.flight && b.flight.type === 'shot';
      k.jumpT = 0; k.jumpCd = T.keeperJumpCd;
      // Getting a hand to it is not the same as holding it. At full stretch, at
      // the top of a jump, most keepers punch.
      const clean = rnd(s) < T.keeperJumpCatchP * (b.z < reach * 0.8 ? 1.25 : 0.7);
      if (clean) {
        giveBall(s, k.i); k.holdT = 0;
        ev(s, wasShot ? 'SAVE_CATCH' : 'KEEPER_CLAIM', { k: k.i, air: true });
      } else {
        parry(s, team, k);
        ev(s, wasShot ? 'SAVE_PARRY' : 'KEEPER_PUNCH', { k: k.i, air: true });
      }
      return;
    }
    if (k.jumpT <= 0) { k.jumpCd = T.keeperJumpCd; ev(s, 'KEEPER_JUMP_MISS', { k: k.i }); }
    k.vx *= 0.86; k.vy *= 0.86;
    return;
  }
  // Only for genuinely LOFTED balls: chips, lobs, crosses, loose balls dropping in.
  // A driven shot — including a curling finesse — belongs to the dive/save system,
  // which has a reaction time and a roll you can beat. Letting the jump grab those
  // too was an unbeatable second save on top of the first: measured 40/40 finesse
  // shots caught, because the ball passes near him on its way to the far corner
  // and he simply plucked it out of the air mid-flight.
  const lofted = !b.flight || b.flight.type !== 'shot' || b.flight.chip;
  if (lofted && k.jumpCd <= 0 && k.diveT <= 0 && b.owner < 0 && s.phase === 'play' && b.vz < 6) {
    // where will it be when it gets to me, and will it be up in the air?
    const sp2 = len(b.vx, b.vy);
    if (sp2 > 1) {
      const toMe = len(b.x - k.x, b.y - k.y);
      const tArr = toMe / sp2;
      if (tArr < T.keeperJumpLead) {
        const zArr = b.z + b.vz * tArr - 0.5 * T.ballGravity * tArr * tArr;
        const closing = ((k.x - b.x) * b.vx + (k.y - b.y) * b.vy) > 0;
        if (closing && zArr > T.keeperJumpMinZ && zArr < T.keeperJumpZ + 0.9) {
          k.jumpT = T.keeperJumpDur;
          k.st = 'kjump'; k.stT = T.keeperJumpDur;
          ev(s, 'KEEPER_JUMP', { k: k.i });
          return;
        }
      }
    }
  }

  // ---- body-check ----------------------------------------------------------
  // Bring the ball into my box and I will come through you. Deliberately built
  // as a telegraph rather than a hitbox: a long readable wind-up where the keeper
  // stands up and squares to you, then a short committed burst. A deke thrown
  // during the active window beats it outright — and because the keeper is by
  // then out of position with a long recovery, beating one is a goal, not just a
  // dodge. That asymmetry is the whole mechanic: it should punish the player who
  // walks in, and reward the player who reads it.
  if (k.st === 'kcheck') {
    const t = (T.kCheckWindup + T.kCheckActive + T.kCheckSettle) - k.stT;
    if (t < T.kCheckWindup) {
      // wind-up: plant and square up. Face the victim so the pose reads.
      k.vx *= 0.55; k.vy *= 0.55;
      const v = s.players[k.kchkV];
      if (v && !v.off) { const [fx2, fy2] = norm(v.x - k.x, v.y - k.y); k.fx = fx2; k.fy = fy2; }
    } else if (t < T.kCheckWindup + T.kCheckActive) {
      // committed. Leashed so a keeper can never lunge itself out of the game.
      const outByLine = Math.abs(k.x - goalX);
      if (outByLine > T.kCheckLeash) { k.vx *= 0.5; k.vy *= 0.5; }
      else { k.vx = k.fx * T.kCheckSpeed; k.vy = k.fy * T.kCheckSpeed; }
      for (const q of s.players) {
        if (q.team === team || q.keeper || q.off) continue;
        if (q.immuneT > 0 || q.st === 'down' || q.st === 'zap') continue;
        if (q.st === 'deke') continue;                      // a deke beats the check
        if (len(q.x - k.x, q.y - k.y) > T.kCheckReach + T.playerR + 0.30 * q.stats.size) continue;
        const hadBall = b.owner === q.i;
        knockDown(s, q, k.fx, k.fy, k, T.kCheckKnock);
        q.stT = T.kCheckDownT;
        q.immuneT = Math.max(q.immuneT, T.kCheckImmuneT);
        k.kchkHit = true;
        k.st = 'norm'; k.stT = 0; k.vx *= 0.2; k.vy *= 0.2;
        k.kchkCd = T.kCheckCd;
        ev(s, 'KEEPER_CHECK', { k: k.i, v: q.i, hadBall });
        break;
      }
    } else {
      k.vx *= 0.62; k.vy *= 0.62;
    }
    if (k.stT <= 1 && k.st === 'kcheck' && !k.kchkHit) {
      // whiffed — you dodged it. Longer punish, and the keeper is off its line.
      k.kchkCd = T.kCheckCd + T.kCheckWhiffRec;
      ev(s, 'KEEPER_CHECK_WHIFF', { k: k.i });
    }
    return;
  }
  // Start one? Only against a carrier, only inside my box, only with nothing in
  // flight to deal with — saving always outranks hitting someone.
  if (k.diveT <= 0 && k.diveCd <= 0 && k.kchkCd <= 0 && b.owner >= 0 && s.phase === 'play'
      && (!b.flight || b.flight.type !== 'shot')) {
    const c = s.players[b.owner];
    const inMyBox = c && !c.off && c.team !== team
      && Math.abs(c.x - goalX) < T.boxW && Math.abs(c.y) < T.boxH / 2;
    if (inMyBox && len(c.x - k.x, c.y - k.y) < T.kCheckR) {
      k.st = 'kcheck'; k.stT = T.kCheckWindup + T.kCheckActive + T.kCheckSettle;
      k.kchkV = c.i; k.kchkHit = false;
      const [fx2, fy2] = norm(c.x - k.x, c.y - k.y);
      k.fx = fx2; k.fy = fy2;
      ev(s, 'KEEPER_CHECK_START', { k: k.i, v: c.i });
      return;
    }
  }

  // Always watch the ball. This keeps the keeper square to whatever it's dealing
  // with, so a save and the catch that follows both read the right way round —
  // including on the side it just dived to.
  if (len(b.x - k.x, b.y - k.y) > 0.2) {
    const [kfx, kfy] = norm(b.x - k.x, b.y - k.y);
    k.fx = kfx; k.fy = kfy;
  }

  // mid-dive: coast on the launch velocity (the main integrator moves us) and
  // swat at anything inside the extended reach
  if (k.diveT > 0) {
    k.diveT--;
    const flD = b.flight;
    if (flD && flD.type === 'shot' && flD.team !== team) {
      // Full-stretch: against a rocket the keeper throws everything at it. Scaled
      // with pace on purpose — a flat reach bonus lifted saves at every speed and
      // made tap-ins saveable too, when the problem was only ever the fast ones.
      const spD = len(b.vx, b.vy);
      const stretch = clamp((spD - T.keeperReadSpeed) * T.keeperStretchPerSpeed, 0, T.keeperStretchMax);
      if (len(b.x - k.x, b.y - k.y) < T.keeperReach + T.keeperDiveReach + stretch && b.z < T.keeperDiveZ) {
        resolveSave(s, team, k, flD);
      }
    }
    if (k.diveT <= 0) { k.diveCd = T.keeperDiveCd; k.vx *= 0.25; k.vy *= 0.25; }
    return;
  }
  if (k.diveCd > 0) { k.diveCd--; k.vx *= 0.8; k.vy *= 0.8; return; }

  const spd = s.cfg.weakGoalies ? T.keeperWeakSpeed : T.keeperSpeed;
  const reflex = s.cfg.keeperReflex[team] + (s.cfg.weakGoalies ? 7 : 0);

  // holding the ball → distribute
  if (b.owner === k.i) {
    k.holdT++;
    let doThrow = false, doPunt = false;
    if (inputs) for (const p of s.players) {
      if (p.team !== team || p.keeper) continue;
      const inp = inputs[p.i];
      if (inp && inp.distA) doThrow = true;
      if (inp && inp.distB) doPunt = true;
    }
    if (k.holdT > T.keeperHoldT) { (rnd(s) < 0.7 ? (doThrow = true) : (doPunt = true)); }
    // drift back to line while holding
    k.x += (lineX - k.x) * 0.06; k.y += (0 - k.y) * 0.06;
    if (doThrow) {
      // throw to least-pressured teammate
      let best = -1, bestScore = -Infinity;
      for (const q of s.players) {
        if (q.team !== team || q.keeper || q.off) continue;
        let near = 99;
        for (const o of s.players) if (o.team !== team && !o.keeper && !o.off) near = Math.min(near, len(o.x - q.x, o.y - q.y));
        const fwd = (q.x - k.x) * d;
        const dd = len(q.x - k.x, q.y - k.y);
        const score = near * 0.5 + fwd * 0.08 + (dd < 6 ? -1.2 : 0);  // avoid dumping to crowded box
        if (score > bestScore) { bestScore = score; best = q.i; }
      }
      if (best >= 0) {
        const r = s.players[best];
        b.owner = -1; b.lastTouch = k.i; b.pickupCd = 4;
        const dd = len(r.x - k.x, r.y - k.y), spd2 = T.passSpeed + 2;
        const [nx, ny] = norm(r.x - k.x, r.y - k.y);
        b.x = k.x + nx; b.y = k.y + ny; b.z = 0.5; b.vx = nx * spd2; b.vy = ny * spd2; b.vz = 0;
        b.flight = { type: 'pass', from: k.i, tgt: best, clean: true, dist: dd, t: 0, eta: Math.round(dd / spd2 * TICK_RATE) };
        ev(s, 'KEEPER_THROW', { k: k.i, to: best });
      }
    } else if (doPunt) {
      b.owner = -1; b.lastTouch = k.i; b.pickupCd = 20;
      const ty = (rnd(s) - 0.5) * 16;
      const [nx, ny] = norm(d * 18, ty);
      b.x = k.x + nx; b.y = k.y + ny; b.z = 0.6;
      b.vx = nx * 17; b.vy = ny * 17; b.vz = 9;
      b.flight = null;
      ev(s, 'KEEPER_PUNT', { k: k.i });
    }
    return;
  }

  // shot incoming?
  const fl = b.flight;
  const shotAtMe = fl && fl.type === 'shot' && fl.team !== team;
  if (shotAtMe) {
    if (kb.shotId !== fl.id) {
      // Reaction was a flat tick count, so it cost the keeper a fixed slice of
      // TIME while a faster ball spent less and less time in the air — save rate
      // fell off a cliff with pace (64% under 25 u/s, 13% at 45-55, 0% above 55).
      // A keeper doesn't beat a rocket on reflex, they read the wind-up: a hard
      // shot is a charged shot and it is telegraphed. So pace buys anticipation,
      // which turns the flat time budget back into roughly a distance budget.
      const sp = len(b.vx, b.vy);
      const read = clamp((sp - T.keeperReadSpeed) * T.keeperReadPerSpeed, 0, T.keeperReadMax);
      kb.shotId = fl.id;
      kb.reactT = Math.max(T.keeperMinReact, reflex + (fl.otPenalty || 0) - read);
      kb.dived = false; kb.planDive = false;
    }
    if (kb.reactT > 0) kb.reactT--;
    if (kb.reactT <= 0) {
      // predict crossing y at my line
      const tToLine = Math.abs((lineX - b.x) / (b.vx || 0.001));
      const predY = clamp(b.y + b.vy * tToLine, -T.goalW / 2 - 0.4, T.goalW / 2 + 0.4);
      // A curling ball is READ WRONG, and that is the whole point of bending one.
      // The prediction above is a straight-line extrapolation, so on a bending
      // shot it is wrong by exactly the swing still to come — but re-solving it
      // every tick let the keeper quietly correct all the way to the post, which
      // made a placed finesse strictly worse than just hitting it hard.
      //
      // So: commit. He goes where he thinks it is going and only drifts toward
      // the truth slowly. Bend it enough and he is beaten by the bend, which is
      // what a player who picked the far corner has earned.
      const bendy = Math.min(1, Math.abs(fl.curve || 0) / 0.45);
      if (kb.tgtY === undefined || !bendy) kb.tgtY = predY;
      else kb.tgtY += (predY - kb.tgtY) * (1 - bendy * T.keeperCurveCommit);
      // Can I still get there on my feet? If not, leave them — a 6.3-wide mouth
      // is too much to cover by shuffling along the line.
      // Commit or don't, once, at the instant we react — a keeper who re-checks
      // every tick has already shuffled the gap closed and never leaves its feet.
      const gap = kb.tgtY - k.y;
      // Where will it cross, height-wise? A standing keeper only reaches 2.35 into
      // a 3.2-tall goal, so anything above that has to be a leap even when it's
      // straight at them — otherwise high central shots are free goals.
      const zAtLine = b.z + b.vz * tToLine - 0.5 * T.ballGravity * tToLine * tToLine;
      // Decide whether this one needs a dive, once, when we react...
      if (!kb.dived && tToLine > 0.08) {
        kb.dived = true;
        kb.planDive = Math.abs(gap) > T.keeperDiveMinGap || zAtLine > T.keeperHighSave;
      }
      // ...but launch it LATE, so the dive is still in the air when the ball gets
      // here. Diving on the reaction tick meant that from range the dive expired
      // and the keeper sat frozen in its recovery as the shot arrived — every
      // full-power effort from distance was a certain goal.
      const diveWindow = (T.keeperDiveDur / TICK_RATE) * 0.85;
      if (kb.planDive && k.diveCd <= 0 && tToLine <= diveWindow
          && (Math.abs(gap) > T.keeperDiveMinGap * 0.6 || zAtLine > T.keeperHighSave)) {
        k.diveT = T.keeperDiveDur;
        k.st = 'kdive'; k.stT = T.keeperDiveDur;         // drives the dive pose client-side
        // Aim the dive so it puts the keeper ON the ball's crossing point, rather
        // than flinging it sideways at a fixed speed and hoping the ball is there.
        k.vx = 0;
        k.vy = clamp(gap / Math.max(tToLine, 0.06), -T.keeperDiveSpeed, T.keeperDiveSpeed);
        ev(s, 'KEEPER_DIVE', { k: k.i, dir: Math.sign(gap) });
        return;
      }
      moveKeeper(k, lineX, kb.tgtY, spd * 1.15);
    } else {
      moveKeeper(k, lineX, k.y, spd * 0.4);
    }
    // save attempt. A keeper who has come out is standing tall and spread — he
    // covers more of the ground-level goal, which is the trade for the air he has
    // given up above him.
    const big = k.st === 'kout' ? T.keeperBigR : 0;
    const reach = T.keeperReach + 0.15 + big;
    if (len(b.x - k.x, b.y - k.y) < reach && b.z < 2.35 + (k.st === 'kout' ? T.keeperBigZ : 0)) {
      resolveSave(s, team, k, fl);
    }
    return;
  }
  kb.shotId = -1;

  // Loose ball near my goal → rush & claim. Two conditions, and the second one
  // matters more than it looks:
  //
  // The ball must be ENDING UP near my goal, not merely passing through. A cross
  // whipped across the face of goal clips this radius on its way to the far post,
  // and claiming it meant every charged cross in the box was eaten by the keeper —
  // which is exactly what "it always goes to the enemy goalie" felt like from the
  // other side. A keeper comes for balls that will arrive in his area; he does not
  // get to reach out and take one that is travelling past him at 25 u/s.
  const land = fl && fl.land;
  const arrivesHere = !land || len(land.x - goalX, land.y) < T.keeperClaimR;
  const inMyBox = len(b.x - goalX, b.y) < T.keeperClaimR && arrivesHere;
  if (b.owner < 0 && inMyBox && (!fl || fl.type !== 'shot')) {
    moveKeeper(k, b.x, b.y, spd);
    if (b.pickupCd <= 0 && b.z < 1.4 && len(b.x - k.x, b.y - k.y) < 1.25) {
      giveBall(s, k.i); k.holdT = 0;
      ev(s, 'KEEPER_CLAIM', { k: k.i });
      return;
    }
  } else {
    // tend: arc between ball and goal center
    const bx = b.owner >= 0 ? s.players[b.owner].x : b.x;
    const by = b.owner >= 0 ? s.players[b.owner].y : b.y;
    // cos(atan2(y,x)) and sin(atan2(y,x)) ARE the normalised direction. Same
    // answer using nothing but sqrt, and cheaper than three trig calls.
    const [ax2, ay2] = norm(bx - goalX, by);

    // ---- come out and close the angle -------------------------------------
    // If an opponent is carrying at us with nobody covering, standing on the line
    // is the worst thing he can do — the shooter has the whole mouth. So he
    // advances down the ball-to-goal line, which shrinks the visible goal to
    // almost nothing, and stands tall. The cost is that he is now well off his
    // line and there is a large amount of air above him, which is precisely the
    // opening a chip is supposed to punish.
    const carrier = b.owner >= 0 ? s.players[b.owner] : null;
    // ...and he has to actually be coming at me.
    const closing = carrier
      ? ((goalX - carrier.x) * carrier.vx + (0 - carrier.y) * carrier.vy)
        / Math.max(len(goalX - carrier.x, carrier.y), 0.1)
      : 0;
    const threat = carrier && !carrier.off && carrier.team !== team
      && len(carrier.x - goalX, carrier.y) < T.keeperOutTrigger
      && closing > T.keeperOutMinClosing;
    let covered = false;
    if (threat) {
      // is one of my own between him and the goal, near enough to the line to matter?
      const [lx2, ly2] = norm(goalX - carrier.x, -carrier.y);
      const ld2 = len(goalX - carrier.x, carrier.y);
      for (const o of s.players) {
        if (o.team !== team || o.keeper || o.off) continue;
        const t2 = clamp((o.x - carrier.x) * lx2 + (o.y - carrier.y) * ly2, 0, ld2);
        if (len(carrier.x + lx2 * t2 - o.x, carrier.y + ly2 * t2 - o.y) < T.keeperOutCoverR) { covered = true; break; }
      }
    }
    if (threat && !covered) {
      // how far out scales with how close he is: a man on the edge of the area
      // gets met further from goal than one still 20 m away.
      // Ramp faster than linear: he should already be off his line while the
      // attacker is still arriving, not arrive at the same time the shot does.
      const raw = clamp(1 - len(carrier.x - goalX, carrier.y) / T.keeperOutTrigger, 0, 1);
      const closeness = Math.pow(raw, 0.55);
      const out = T.keeperLine + (T.keeperOutMax - T.keeperLine) * closeness;
      const tx2 = goalX + ax2 * out;
      const ty2 = ay2 * out;
      if (k.st === 'norm') { k.st = 'kout'; k.stT = 8; } else if (k.st === 'kout') k.stT = 8;
      moveKeeper(k, tx2, ty2, spd * T.keeperOutSpeed);
    } else {
      const tx = goalX + ax2 * T.keeperLine * 1.4;
      const ty = clamp(ay2 * 2.8, -(T.goalW / 2 + 0.55), T.goalW / 2 + 0.55);
      moveKeeper(k, clamp(tx, Math.min(goalX, goalX + d * 4), Math.max(goalX, goalX + d * 4)), ty, spd * 0.85);
    }
  }
  // Run into the keeper and you go down — they're a brick wall in gloves. Anyone,
  // not just attackers, so barging through your own keeper costs you too. Drifting
  // into them slowly is still just a shove; you have to actually run in.
  for (const q of s.players) {
    if (q.keeper) continue;
    const dd = len(q.x - k.x, q.y - k.y);
    if (dd >= T.keeperBumpR) continue;
    const [nx, ny] = norm(q.x - k.x, q.y - k.y);
    // Own defenders only get shoved. Flattening them too cost about +0.6 goals a
    // match — it kept clearing your own six-yard box for the other side.
    const canFlatten = q.team !== team && len(q.vx, q.vy) > T.keeperBumpSpeed
      && q.immuneT <= 0 && q.st !== 'down' && q.st !== 'zap';
    if (canFlatten) {
      knockDown(s, q, nx, ny, k);            // same treatment as a big hit
      ev(s, 'KEEPER_BUMP', { k: k.i, v: q.i });
    } else {
      q.vx += nx * 6; q.vy += ny * 6;
    }
  }
}
function moveKeeper(k, tx, ty, spd) {
  const T = TUNE;
  const dx = tx - k.x, dy = ty - k.y, dd = len(dx, dy);
  // The target is recomputed from the ball every tick, so it jitters by a few cm.
  // Snapping velocity straight at it made the keeper vibrate on the spot; ease in
  // and hold still inside a deadzone instead.
  // NOTE: no position integration here. The main loop already advances every
  // player by v*DT; doing it again made keepers travel at double keeperSpeed,
  // which let them cover the whole mouth on foot and never need to dive.
  if (dd < T.keeperDeadzone) { k.vx *= 0.55; k.vy *= 0.55; return; }
  const [nx, ny] = norm(dx, dy);
  const v = Math.min(spd, dd / DT);
  const kk = KEEPER_K_DT;
  k.vx += (nx * v - k.vx) * kk; k.vy += (ny * v - k.vy) * kk;
  // Facing is NOT taken from velocity here — shuffling along the line left the
  // keeper looking down the goal line, so it saved and then received the ball
  // side-on. keeperUpdate points it at the ball instead.
}
function resolveSave(s, team, k, fl) {
  const T = TUNE, b = s.ball;
  if (fl.saveRolled) return;           // one roll per shot
  fl.saveRolled = true;
  // stun-through on max charge
  // Blasting a keeper off his feet is a POWER mechanic. A finesse is the opposite
  // shot — it is slow on purpose — so it must never trigger the stun-through, and
  // certainly must not get parried by one. Measured: without this exclusion the
  // stun ate 17 of every 40 fully-weighted finesses, so charging a placement shot
  // made it LESS likely to score than scuffing one.
  if (!fl.finesse && fl.stage >= 3 && k.stunImmuneT <= 0 && rnd(s) < T.keeperStunP + (fl.perfectOt ? 0.18 : 0)) {
    k.st = 'kstun'; k.stT = T.keeperStunT; k.stunImmuneT = T.keeperStunImmuneT + T.keeperStunT;
    parry(s, team, k);
    ev(s, 'KEEPER_STUN', { k: k.i });
    return;
  }
  // clean beat: hard/fast/tricky shots can go straight through even in reach
  let beatP = 0.07;
  if (fl.power > T.beatShotP) beatP += 0.12;
  if (fl.stage >= 2) beatP += 0.08;
  if (fl.oneTimer) beatP += 0.12;
  if (fl.perfectOt) beatP += 0.14;
  // A curling ball placed in the corner is hard to deal with even though it's slow.
  // Without this the save roll keys purely off pace, so finesse could never win.
  // A placed, curling ball is hard to deal with even though it is slow — and the
  // harder you bent it around him, the harder. Without this, finesse can never win
  // against a save roll that keys off pace.
  if (fl.finesse) beatP += T.finesseBeat * (0.55 + 0.45 * clamp(fl.finesseW || 0, 0, 1));
  if (fl.chip) beatP += 0.12;
  if (s.cfg.weakGoalies) beatP += 0.18;
  if (rnd(s) < beatP) return;          // keeper whiffs — ball continues goalward
  // finesse counts as hard to HOLD: it gets parried rather than caught
  const hard = fl.power > T.hardShotP || fl.perfectOt || fl.finesse || fl.stage >= 2;
  const catchP = (hard ? T.keeperCatchP - 0.42 : T.keeperCatchP) - (fl.oneTimer ? 0.15 : 0) + (s.cfg.weakGoalies ? -0.15 : 0);
  if (rnd(s) < catchP) {
    giveBall(s, k.i); k.holdT = 0;
    ev(s, 'SAVE_CATCH', { k: k.i });
  } else {
    parry(s, team, k);
    ev(s, 'SAVE_PARRY', { k: k.i });
  }
}
function parry(s, team, k) {
  const b = s.ball, d = team === 0 ? 1 : -1; // team's attack dir; parry outward = +d... own goal at -d
  b.owner = -1; b.flight = null; b.pickupCd = 6; b.lastTouch = k.i;
  b.vx = d * (8 + rnd(s) * 6);               // punched out hard from own goal
  b.vy = (rnd(s) - 0.5) * 14;
  b.vz = 2 + rnd(s) * 2.5; b.z = Math.max(b.z, 0.5);
}

// ---------------------------------------------------------------- ball ------
function ballUpdate(s) {
  const T = TUNE, b = s.ball;
  if (b.owner >= 0) {
    const o = s.players[b.owner];
    const tx = o.x + o.fx * T.leashD, ty = o.y + o.fy * T.leashD;
    b.x += (tx - b.x) * 0.55; b.y += (ty - b.y) * 0.55;
    b.z = 0.11; b.vx = o.vx; b.vy = o.vy; b.vz = 0;
    return;
  }
  const fl = b.flight;
  if (fl) {
    fl.t++;
    if (fl.type === 'pass' || fl.type === 'lobpass') {
      // An aimed pass can legitimately have no receiver — you played it into space
      // and nobody got there. It stays a live ball, it can still be intercepted,
      // and it simply goes loose at the end of its flight.
      const r = fl.tgt >= 0 ? s.players[fl.tgt] : null;
      const passTeam = r ? r.team : s.players[fl.from].team;
      // No homing — a pass goes where it was aimed. The only in-flight steer is
      // the bend you deliberately put on it, applied square to the direction of
      // travel so it works whichever way you're passing.
      // Bend only over the flight it was weighted for. Left running, the lateral
      // accel keeps rotating the velocity and the ball loops back like a boomerang.
      if (fl.curve && fl.t < fl.eta) {
        const sp2 = len(b.vx, b.vy) || 1;
        const px = -b.vy / sp2, py = b.vx / sp2;      // normal, taken before we mutate
        b.vx += px * fl.curve * T.passCurveAccel * DT;
        b.vy += py * fl.curve * T.passCurveAccel * DT;
      }
      // cleanliness + interception
      for (const o of s.players) {
        if (o.keeper || o.off) continue;
        if (o.team !== passTeam) {
          const dd = len(o.x - b.x, o.y - b.y);
          if (dd < T.perfectPassClearR) fl.clean = false;
          if (dd < T.interceptR && b.z < 1.4 && o.st === 'norm' && o.recT <= 0 && b.pickupCd <= 0) {
            giveBall(s, o.i); ev(s, 'INTERCEPT', { p: o.i });
            return;
          }
        }
      }
      // An aimed ball with no receiver runs out of flight and goes loose. It must
      // NOT return here — everything below this block still has to run, including
      // the integrator. Returning froze the ball in mid-air for the whole flight.
      if (!r) { if (fl.t > fl.eta + 8) b.flight = null; }
      // arrival
      else if (len(r.x - b.x, r.y - b.y) < T.catchR && b.z < T.volleyReachZ && r.st !== 'down' && r.st !== 'zap') {
        const perfect = passIsThreat(s, fl, r);
        const armedAge = r.otArm >= 0 ? (s.tick - r.otArm) : 999;
        const armed = armedAge < T.otArmWindow;
        // The big pink one: perfect timing OR a perfect pass. Finishing a ball that
        // came through untouched is worth the same as nailing the window.
        const timed = armedAge <= T.oneTimerWindow && r.otPress <= T.otMashMax;
        const perfectOt = armed && (timed || (perfect && T.perfectPassOt));
        // Meeting it above the knee is a volley: the bean leaves the ground to
        // strike it, the way a lob one-timer does in Strikers.
        const aerial = b.z > T.volleyMinZ;
        if (perfect) { r.buffT = T.perfectBuffT; ev(s, 'PERFECT_PASS', { p: r.i }); }
        // A slide in progress no longer eats the strike: if you called for it and
        // the ball turns up, you scramble out of the slide and hit it.
        if (armed && (r.st === 'norm' || r.st === 'leap' || r.st === 'slide')) {
          if (r.st === 'slide') { r.st = 'norm'; r.stT = 0; r.recT = 0; }
          giveBall(s, r.i);
          // A one-timer is no longer a tap-speed shot — it rips at a charge tier,
          // and a green (perfect) ball rips at the top one.
          launchShot(s, r, {
            stage: perfectOt ? T.perfectOtStage : T.otStage,
            oneTimer: true, perfectOt, volley: aerial,
            aimNoise: perfectOt ? 0 : gauss(s) * 0.7, zNoise: gauss(s),
          });
          if (aerial) {
            r.st = 'volley'; r.stT = T.volleyDur; r.vx *= 0.3; r.vy *= 0.3;
            ev(s, 'VOLLEY', { p: r.i, z: b.z, perfect: perfectOt });
          }
          ev(s, 'ONE_TIMER', { p: r.i, perfect: perfectOt, volley: aerial });
        } else {
          // not striking it: bring it down out of the air and keep it
          giveBall(s, r.i);
          if (aerial) { r.st = 'norm'; r.stT = 0; r.recT = Math.max(r.recT, T.trapRecT); ev(s, 'TRAP', { p: r.i }); }
        }
        r.otArm = -1; r.otPress = 0;
        return;
      }
      if (fl.t > fl.eta * 3 + 60) b.flight = null; // pass died
    } else if (fl.type === 'shot') {
      if (fl.curve) { // lateral curve accel
        b.vy += fl.curve * T.curveAccel * DT;
      }
    }
  }
  // physics
  b.vz -= T.ballGravity * DT;
  const dragging = b.z <= 0.15 ? T.ballDragG : T.ballDragA;
  b.vx *= dragging; b.vy *= dragging;
  const pvx = b.x, pvy = b.y, pvz = b.z;        // pre-integration, for swept woodwork
  b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;

  // ---- shots hit people. Outfield beans used to be transparent to shots: only
  // the keeper ever interacted with one. Now a shot deflects off a body, and a
  // hard enough one puts them on the floor, the harder the further.
  if (b.flight && b.flight.type === 'shot' && b.z < T.blockMaxZ) {
    const flS = b.flight, R = T.blockR + T.ballR;
    let hit = null, hitT = 2, hitD = Infinity;
    for (const o of s.players) {
      if (o.keeper || o.i === flS.shooter) continue;         // keeper saves are separate
      if (o.st === 'down' || o.st === 'zap') continue;
      const r2 = R + (o.stats.size - 1) * 0.35;
      // swept: shots move ~0.8u a tick, wider than a body, so a point test misses
      const dx = b.x - pvx, dy = b.y - pvy;
      const den = dx * dx + dy * dy;
      const t = den > 1e-9 ? clamp(((o.x - pvx) * dx + (o.y - pvy) * dy) / den, 0, 1) : 0;
      const cx = pvx + dx * t, cy = pvy + dy * t;
      const d = len(cx - o.x, cy - o.y);
      if (d < r2 && t < hitT) { hit = o; hitT = t; hitD = d; }
    }
    if (hit) {
      const [nx, ny] = norm(hitD > 1e-4 ? b.x - hit.x : 1, hitD > 1e-4 ? b.y - hit.y : 0);
      const speed = len(b.vx, b.vy);
      // deflect off the body, with a little scatter so blocks aren't mirror-perfect
      const dot = b.vx * nx + b.vy * ny;
      b.vx -= (1 + T.blockBounce) * dot * nx;
      b.vy -= (1 + T.blockBounce) * dot * ny;
      b.vx += gauss(s) * T.blockScatter; b.vy += gauss(s) * T.blockScatter;
      b.x = hit.x + nx * (R + 0.02); b.y = hit.y + ny * (R + 0.02);
      b.flight = null; b.pickupCd = Math.max(b.pickupCd, T.blockPickupCd);
      // a hard shot bowls them over — force scales with how hard it was hit
      const over = speed - T.blockKnockSpeed;
      if (over > 0 && hit.immuneT <= 0) {
        knockDown(s, hit, -nx, -ny, null, T.blockKnockBase + over * T.blockKnockPerSpeed);
        ev(s, 'SHOT_FLATTEN', { p: hit.i, x: hit.x, y: hit.y, speed });
      } else {
        ev(s, 'BLOCK', { p: hit.i, x: hit.x, y: hit.y, speed });
      }
    }
  }
  if (b.z < 0.11) {
    b.z = 0.11;
    if (b.vz < -1) b.vz = -b.vz * T.ballBounce; else b.vz = 0;
    if (Math.abs(b.vz) < 0.4) b.vz = 0;
  }
  if (b.z > T.ceiling) { b.z = T.ceiling; b.vz = -Math.abs(b.vz) * 0.6; }
  // ---- woodwork. The frame had no collision at all: the goal was a bare
  // rectangle test, so the posts and bar simply didn't exist. Now they're solid,
  // which is where bar-downs and post-ins come from.
  {
    const half = T.pitchW / 2, R = T.postR + T.ballR;
    // Swept, not a point test: near the goal the ball covers ~0.5u a tick while the
    // frame's collision band is only ~0.78u across, so a point test grazes past it
    // and a really hard shot tunnels straight through. Find the closest approach of
    // this tick's motion segment to the frame instead.
    const nearest = (p0, p1, c) => {
      const d = p1 - p0;
      return { d2: d * d, num: (c - p0) * d };
    };
    for (const sx of [-1, 1]) {
      const gx = sx * half;
      // uprights — closest approach in plan view (x,y)
      if (Math.min(pvz, b.z) < T.goalH + T.postR) {
        for (const gy of [-T.goalW / 2, T.goalW / 2]) {
          const ax = nearest(pvx, b.x, gx), ay = nearest(pvy, b.y, gy);
          const den = ax.d2 + ay.d2;
          const t = den > 1e-9 ? clamp((ax.num + ay.num) / den, 0, 1) : 0;
          const cx = pvx + (b.x - pvx) * t, cy = pvy + (b.y - pvy) * t;
          const dx = cx - gx, dy = cy - gy, d = len(dx, dy);
          if (d < R) {
            const nx = d > 1e-4 ? dx / d : 1, ny = d > 1e-4 ? dy / d : 0;
            const dot = b.vx * nx + b.vy * ny;
            if (dot < 0) {
              b.x = gx + nx * R; b.y = gy + ny * R;
              b.z = pvz + (b.z - pvz) * t;
              b.vx -= (1 + T.postBounce) * dot * nx;
              b.vy -= (1 + T.postBounce) * dot * ny;
              b.vz *= 0.85;
              b.flight = null; b.pickupCd = Math.max(b.pickupCd, T.postPickupCd);
              ev(s, 'WOODWORK', { part: 'post', x: b.x, y: b.y, z: b.z });
            }
          }
        }
      }
      // crossbar — closest approach in the (x,z) plane, anywhere across the mouth
      if (Math.abs(b.y) < T.goalW / 2 + T.postR) {
        const ax = nearest(pvx, b.x, gx), az = nearest(pvz, b.z, T.goalH);
        const den = ax.d2 + az.d2;
        const t = den > 1e-9 ? clamp((ax.num + az.num) / den, 0, 1) : 0;
        const cx = pvx + (b.x - pvx) * t, cz = pvz + (b.z - pvz) * t;
        const dx = cx - gx, dz = cz - T.goalH, d = len(dx, dz);
        if (d < R) {
          const nx = d > 1e-4 ? dx / d : -sx, nz = d > 1e-4 ? dz / d : 1;
          const dot = b.vx * nx + b.vz * nz;
          if (dot < 0) {
            b.x = gx + nx * R; b.z = T.goalH + nz * R;
            b.y = pvy + (b.y - pvy) * t;
            b.vx -= (1 + T.postBounce) * dot * nx;
            b.vz -= (1 + T.postBounce) * dot * nz;
            b.flight = null; b.pickupCd = Math.max(b.pickupCd, T.postPickupCd);
            ev(s, 'WOODWORK', { part: 'bar', x: b.x, y: b.y, z: b.z });
          }
        }
      }
    }
  }

  // walls (goal mouths handled by goalCheck before clamping x)
  const hx = T.pitchW / 2, hy = T.pitchH / 2;
  const inMouth = Math.abs(b.y) < T.goalW / 2 && b.z < T.goalH;
  if (b.x < -hx && !inMouth) { b.x = -hx; b.vx = -b.vx * T.wallBounce; b.flight = null; }
  if (b.x > hx && !inMouth) { b.x = hx; b.vx = -b.vx * T.wallBounce; b.flight = null; }
  if (b.x < -hx - 0.2 && inMouth) { /* entering net; goalCheck scores */ }
  if (b.y < -hy) { b.y = -hy; b.vy = -b.vy * T.wallBounce; b.flight = null; }
  if (b.y > hy) { b.y = hy; b.vy = -b.vy * T.wallBounce; b.flight = null; }

  // greasy ball: if 3+ beans crowd a loose ball for ~0.8s, it squirts out
  if (b.owner < 0 && !b.flight) {
    let n = 0, cx = 0, cy = 0;
    for (const p of s.players) {
      if (p.keeper) continue;
      if (len(p.x - b.x, p.y - b.y) < 1.7) { n++; cx += p.x; cy += p.y; }
    }
    if (n >= 3) {
      s.scrumT = (s.scrumT || 0) + 1;
      if (s.scrumT > 48) {
        s.scrumT = 0;
        let dx = b.x - cx / n, dy = b.y - cy / n;
        if (Math.abs(dx) + Math.abs(dy) < 0.05) { const [ux, uy] = randUnit(s); dx = ux; dy = uy; }
        const [ux, uy] = norm(dx, dy);
        b.vx += ux * 6.5; b.vy += uy * 6.5; b.vz = Math.max(b.vz, 2.2);
        b.pickupCd = Math.max(b.pickupCd, 12);
        ev(s, 'SQUIRT', {});
      }
    } else s.scrumT = 0;
  }

  // pickup (loose balls only — pass/shot flights resolve via their own logic)
  if (b.owner < 0 && b.pickupCd <= 0 && b.z < 1.1 && !b.flight) {
    let best = -1, bestD = T.possessionR;
    for (const p of s.players) {
      if (p.keeper) continue;
      if (p.st === 'down' || p.st === 'zap' || p.st === 'trip' || p.st === 'bighit') continue;
      const dd = len(p.x - b.x, p.y - b.y);
      if (dd < bestD) { bestD = dd; best = p.i; }
    }
    if (best >= 0) giveBall(s, best);
  }
}

// ---------------------------------------------------------------- goals -----
function goalCheck(s) {
  const T = TUNE, b = s.ball;
  if (s.phase !== 'play') return;
  // Practice stays in 'play' with the ball resting in the net, so without this the
  // same goal is counted again on every tick until the reset fires.
  if (s.practice && s.pResetT > 0) return;
  const half = T.pitchW / 2;
  let scored = -1;
  if (b.x > half + 0.25 && Math.abs(b.y) < T.goalW / 2 && b.z < T.goalH) scored = 0;
  if (b.x < -half - 0.25 && Math.abs(b.y) < T.goalW / 2 && b.z < T.goalH) scored = 1;
  if (scored >= 0) {
    s.score[scored]++;
    const scorer = b.lastTouch >= 0 && s.players[b.lastTouch].team === scored ? b.lastTouch : -1;
    ev(s, 'GOAL', { team: scored, scorer });
    s.kickoffTeam = 1 - scored;
    b.owner = -1; b.flight = null; b.vx = b.vy = b.vz = 0;
    // Practice never leaves play: the ball rests in the net for ~0.6s so you can
    // see where it went in, then comes straight back to your feet. A celebration
    // and a kickoff between every rep is the single biggest tax on iterating.
    if (s.practice) { s.pResetT = 36; return; }
    s.phase = 'goalcele'; s.phaseT = T.goalCeleT;
  }
}

// ----------------------------------------------------------- serialization --
// Is the ball right now a live threatening pass? Drives the green tracer, and it
// can drop mid-flight the moment a defender gets close enough to spoil it.
export function livePassThreat(s) {
  const fl = s.ball.flight;
  if (!fl || (fl.type !== 'pass' && fl.type !== 'lobpass')) return false;
  if (!fl || fl.tgt < 0) return false;
  return passIsThreat(s, fl, s.players[fl.tgt]);
}

export function snapshot(s) {
  const r2 = v => Math.round(v * 100) / 100;
  return {
    t: s.tick, ph: s.phase, phT: s.phaseT, ck: Math.round(s.clock * 10) / 10,
    ot: s.overtime ? 1 : 0, sc: [s.score[0], s.score[1]], ko: s.kickoffTeam,
    ba: [r2(s.ball.x), r2(s.ball.y), r2(s.ball.z), s.ball.owner,
      s.ball.flight && s.ball.flight.type === 'shot' ? (s.ball.flight.perfectOt ? 4 : s.ball.flight.stage) : -1,
      s.ball.flight && (s.ball.flight.type === 'pass' || s.ball.flight.type === 'lobpass') ? s.ball.flight.tgt : -1,
      livePassThreat(s) ? 1 : 0],
    pl: s.players.map(p => [r2(p.x), r2(p.y), r2(p.vx), r2(p.vy), r2(p.fx), r2(p.fy),
      p.st, p.stT, p.charging ? p.chargeT : 0, p.buffT > 0 ? 1 : 0, p.bhChargeT || 0, p.passChargeT || 0,
      // recT completes canAct. Without it a predicting client keeps walking during
      // recovery, the server says otherwise, and you get yanked right after contact.
      p.recT || 0]),
  };
}

// ---- rollback support ------------------------------------------------------
// A full copy of everything step() mutates. Spread first so any field added
// later is carried without having to remember this function exists; only the
// nested mutables need explicit work. cfg and stats are never written, so they
// stay shared by reference.
export function cloneState(s) {
  const c = { ...s };
  c.score = s.score.slice();
  c.players = s.players.map(p => ({ ...p }));
  c.events = [];
  c.ball = { ...s.ball };
  c.ball.flight = s.ball.flight ? { ...s.ball.flight } : null;
  if (c.ball.flight && s.ball.flight.beat) c.ball.flight.beat = s.ball.flight.beat.slice();
  c.keeper = s.keeper.map(k => ({ ...k }));
  // Shared by reference the predicted sim would append to the confirmed one's
  // history every tick and corrupt what lag compensation rewinds into.
  if (s.hist) c.hist = s.hist.map(r => r.slice());
  return c;
}

// Inputs on the wire. Sending these instead of state is what makes one shared
// clock possible, and they are smaller than a snapshot into the bargain.
const IB = { sprint: 1, aHeld: 2, bHeld: 4, yHeld: 8, lobHeld: 16, human: 32, distA: 64, distB: 128 };
export function encodeInput(inp) {
  if (!inp) return 0;
  let b = 0;
  for (const k in IB) if (inp[k]) b |= IB[k];
  const r = [Math.round((inp.mx || 0) * 100) / 100, Math.round((inp.my || 0) * 100) / 100, b, inp.vt | 0];
  if (typeof inp.ax === 'number') { r.push(Math.round(inp.ax * 100) / 100, Math.round(inp.ay * 100) / 100); }
  return r;
}
export function decodeInput(a) {
  if (!a) return null;
  const inp = { mx: a[0], my: a[1] };
  for (const k in IB) inp[k] = (a[2] & IB[k]) !== 0;
  inp.vt = a[3] | 0;
  if (a.length > 4) { inp.ax = a[4]; inp.ay = a[5]; }
  return inp;
}

// Full authoritative state for a desync recovery. Lossless, unlike snapshot(),
// which rounds — you cannot restart a deterministic sim from rounded numbers.
// cfg is static and the client already has it, so it stays off the wire.
export function serializeState(s) {
  const c = cloneState(s);
  delete c.cfg; delete c.hist;
  for (const p of c.players) delete p.stats;    // derived from cfg
  return c;
}
export function restoreState(s, data) {
  const cfg = s.cfg, stats = s.players.map(p => p.stats);
  for (const k in data) if (k !== 'players') s[k] = data[k];
  s.cfg = cfg;
  s.players = data.players.map((p, i) => ({ ...p, stats: stats[i] }));
  s.events = [];
  return s;
}

// The frozen constants above are the one thing here that can rot silently: change
// accelK and movement quietly keeps using the old number. Called by test-sim.
export function assertPortable() {
  const bad = [];
  const chk = (name, frozen, live) => {
    if (Math.abs(frozen - live) > 1e-15) bad.push(`${name}: frozen ${frozen} but tuning implies ${live}`);
  };
  chk('ACCEL_K_DT', ACCEL_K_DT, 1 - Math.exp(-TUNE.accelK * DT));
  chk('KEEPER_K_DT', KEEPER_K_DT, 1 - Math.exp(-TUNE.keeperAccelK * DT));
  return bad;
}

export function matchHash(s) { // cheap determinism check
  let h = 2166136261 >>> 0;
  const mix = v => { h ^= (Math.round(v * 1000) & 0xffffffff) >>> 0; h = Math.imul(h, 16777619) >>> 0; };
  mix(s.tick); mix(s.ball.x); mix(s.ball.y); mix(s.ball.z); mix(s.score[0] * 7 + s.score[1]);
  for (const p of s.players) { mix(p.x); mix(p.y); }
  return h >>> 0;
}
