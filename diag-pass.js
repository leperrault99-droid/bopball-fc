// Verifies the three gameplay rebuilds against measurement rather than vibes:
//   1. a weighted pass goes WHERE AIMED and no longer feeds the enemy keeper
//   2. charge weight maps monotonically to range, for ground and chip
//   3. finesse bends around the keeper into the side netting
//   4. the keeper body-check fires, and a deke beats it
import { makeMatch, step, TUNE, practiceResetBall } from './sim.js';
import { DIFFICULTY, makeBrain, aiInputs } from './ai.js';

const T = (n, c, s2) => ({ name: n, color: 0, captain: { arche: c, traits: {} }, sidekick: { arche: s2, traits: {} } });
const TEAMS = [T('YOU', 'striker', 'playmaker'), T('CPU', 'enforcer', 'allround')];
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };
const R1 = v => Math.round(v * 10) / 10;

function arena(opts = {}) {
  const s = makeMatch({ seed: 5, teams: TEAMS, practice: opts.practice || { mates: 0, defs: 0 } });
  return s;
}

// ---------------------------------------------------------------------------
console.log('=== 1. weighted pass goes where aimed (was: into the enemy keeper) ===');
function passRep({ x, y = 0, aimX, aimY, hold, lob = false, mate = null }) {
  const s = arena({ practice: { mates: mate ? 1 : 0, defs: 0 } });
  const me = s.players[0];
  me.x = x; me.y = y; me.fx = 1; me.fy = 0;
  if (mate) { s.players[1].x = mate[0]; s.players[1].y = mate[1]; }
  practiceResetBall(s, 'feet');
  let land = null, toKeeper = false, restPos = null, caughtBy = -1;
  for (let t = 0; t < 300; t++) {
    const inputs = new Array(10).fill(null);
    inputs[0] = { mx: 0, my: 0, ax: aimX - me.x, ay: aimY - me.y, aHeld: t < hold, lobHeld: lob, human: true };
    step(s, inputs);
    for (const e of s.events) if (e.t === 'PASS') land = { x: e.lx, y: e.ly, aimed: e.aimed };
    const o = s.ball.owner;
    if (o >= 0 && o !== 0) { caughtBy = o; if (s.players[o].keeper && s.players[o].team === 1) toKeeper = true; break; }
    if (land && !s.ball.flight && Math.hypot(s.ball.vx, s.ball.vy) < 1.5) { restPos = { x: s.ball.x, y: s.ball.y }; break; }
  }
  return { land, toKeeper, restPos, caughtBy };
}
// Solve for the hold that puts the ball ON the runner. This is the skill the
// player is being asked to learn, so the test has to demonstrate it is solvable
// from the published constants rather than by feel.
function holdFor(dist, pas = 8) {
  const w = clamp01((dist - TUNE.aimPassRangeMin - pas * TUNE.aimPassStatRange)
    / (TUNE.aimPassRangeMax - TUNE.aimPassRangeMin));
  const frac = w * (1 - TUNE.aimPassAt) + TUNE.aimPassAt;
  return Math.max(7, Math.round(frac * TUNE.passChargeMax));
}
const clamp01 = v => Math.max(0, Math.min(1, v));

// The exact situation reported: driving the box, charged pass across the face of
// goal to a runner. A cross should reach the runner, not the opposing keeper.
for (const x of [12, 18, 22, 25]) {
  const mate = [Math.min(x + 5, 27), 9];
  const r = passRep({ x, y: -6, aimX: mate[0], aimY: mate[1], hold: holdFor(Math.hypot(mate[0] - x, mate[1] + 6)), mate });
  ok(!r.toKeeper && r.caughtBy === 1,
    `charged cross from x=${x} -> runner at ${mate}: caught by ${r.caughtBy} (keeper-stole=${r.toKeeper})`);
}
for (const x of [18, 25]) {
  const mate = [Math.min(x + 5, 27), 9];
  const r = passRep({ x, y: -6, aimX: mate[0], aimY: mate[1], hold: holdFor(Math.hypot(mate[0] - x, mate[1] + 6)), lob: true, mate });
  ok(!r.toKeeper && r.caughtBy === 1,
    `CHIP cross from x=${x} -> runner at ${mate}: caught by ${r.caughtBy} (keeper-stole=${r.toKeeper})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. charge weight -> range (must be monotonic and learnable) ===');
for (const lob of [false, true]) {
  const ds = [];
  for (const hold of [8, 14, 20, 26, 32]) {
    const r = passRep({ x: -18, y: 0, aimX: 20, aimY: 0, hold, lob });
    ds.push(r.land ? R1(Math.hypot(r.land.x + 18, r.land.y)) : null);
  }
  const mono = ds.every((d, i) => i === 0 || d === null || ds[i - 1] === null || d >= ds[i - 1] - 0.2);
  ok(mono, `${lob ? 'chip ' : 'ground'} range by hold [8,14,20,26,32] = ${ds.join(' -> ')} m`);
}

// ---------------------------------------------------------------------------
// The shot being reproduced: top corner of the box, keeper covering the near
// angle, ball bends around him into the far corner. So the things that matter
// are (a) does it ARRIVE where you aimed, (b) does its path go around the keeper
// rather than at him, and (c) does holding it make it more accurate rather than
// more powerful.
console.log('\n=== 3. finesse: bend around the keeper into the far corner ===');
function finesseRep({ x, y, aimY, stage, seed = 5, keeperY = null }) {
  const s = makeMatch({ seed, teams: TEAMS, practice: { mates: 0, defs: 0 } });
  const me = s.players[0];
  me.x = x; me.y = y; me.fx = 1; me.fy = 0;
  const gk = s.players[9];
  if (keeperY !== null) gk.y = keeperY;
  practiceResetBall(s, 'feet');
  const holdT = [10, 20, 45, 70][stage];
  let res = null, launched = null, arrivedY = null, power = 0, nearestGk = 99, widest = -99;
  for (let t = 0; t < 300 && !res; t++) {
    const inputs = new Array(10).fill(null);
    inputs[0] = { mx: 0, my: 0, agy: aimY, az: 1.0, bHeld: t < holdT, finesse: true, human: true };
    step(s, inputs);
    for (const e of s.events) {
      if (e.t === 'SHOT' && !launched) {
        // Swing = arrival vs where the ball WOULD have crossed the line on the
        // line it left on. Raw lateral travel just measures the shooting angle.
        const gx = TUNE.pitchW / 2;
        launched = { straightY: s.ball.y + (gx - s.ball.x) * (s.ball.vy / (s.ball.vx || 1)) };
        power = s.ball.flight ? s.ball.flight.power : 0;
      }
      if (e.t === 'GOAL') res = 'GOAL';
      if (e.t === 'SAVE_CATCH' || e.t === 'SAVE_PARRY') res = 'saved';
      if (e.t === 'KEEPER_STUN') res = 'through the keeper';
      if (e.t === 'WOODWORK') res = 'woodwork';
    }
    if (launched && s.ball.flight) {
      nearestGk = Math.min(nearestGk, Math.hypot(s.ball.x - gk.x, s.ball.y - gk.y));
    }
    if (launched && arrivedY === null && s.ball.x >= TUNE.pitchW / 2 - 0.35) {
      arrivedY = s.ball.y;
      if (!res) {
        if (Math.abs(s.ball.y) > TUNE.goalW / 2) res = 'wide';
        else if (s.ball.z > TUNE.goalH) res = 'over the bar';
      }
    }
  }
  return { res, straightY: launched ? launched.straightY : null, arrivedY, power, nearestGk, widest };
}
const SEEDS = 40;
const rows = [];
for (const stage of [0, 1, 2, 3]) {
  let err = 0, errN = 0, goals = 0, on = 0, pw = 0, swing = 0, swN = 0, gkGap = 0, wide = 0;
  const out = {};
  for (let k = 0; k < SEEDS; k++) {
    const r = finesseRep({ x: 22, y: -11, aimY: 2.4, stage, seed: 100 + k * 37 });
    if (r.arrivedY !== null) { err += Math.abs(r.arrivedY - 2.4); errN++; }
    if (r.straightY !== null && r.arrivedY !== null) { swing += Math.abs(r.arrivedY - r.straightY); swN++; }
    if (r.res === 'GOAL') goals++;
    if (r.res === 'GOAL' || r.res === 'saved' || r.res === 'through the keeper') on++;
    out[r.res || 'missed'] = (out[r.res || 'missed'] || 0) + 1;
    pw += r.power; gkGap += r.nearestGk;
    // "Looks like it's missing": how far OUTSIDE the post the ball was travelling
    // before the curl brought it back. This is the line the keeper reads.
    if (r.straightY !== null) wide += r.straightY - TUNE.goalW / 2;
  }
  rows.push({ stage, err: err / Math.max(errN, 1), swing: swing / Math.max(swN, 1), pw: pw / SEEDS,
    acc: goals / SEEDS, on: on / SEEDS, gap: gkGap / SEEDS, wide: wide / SEEDS });
  const R = rows[rows.length - 1];
  R.out = out;
  console.log(`       charge ${stage}: swing ${R1(R.swing)}m · lands ${R1(R.err)}m from where aimed · pace ${R1(R.pw)} · heading ${R1(R.wide)}m wide of the post before it turns in · passed ${R1(R.gap)}m from the keeper · on target ${Math.round(R.on * 100)}% · scored ${Math.round(R.acc * 100)}%`);
  console.log(`                  outcomes: ${Object.entries(out).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
ok(rows.every((r, i) => i === 0 || r.swing >= rows[i - 1].swing - 0.05),
  `swing grows with the hold: ${rows.map(r => R1(r.swing)).join(' -> ')} m`);
ok(rows[3].wide > 1.0,
  `a full-weight finesse is genuinely heading WIDE of the post before it tucks in: ${R1(rows[3].wide)} m outside`);
ok(rows.every((r, i) => i === 0 || r.wide >= rows[i - 1].wide - 0.05),
  `the arc widens with the hold: ${rows.map(r => R1(r.wide)).join(' -> ')} m outside the post`);

ok(rows[3].err < rows[0].err * 0.7,
  `weighting it properly is what makes it accurate: ${rows.map(r => R1(r.err)).join(' -> ')} m from target`);
ok(rows[3].pw < rows[0].pw * 1.15,
  `holding it does NOT turn it into a power shot: pace ${R1(rows[0].pw)} -> ${R1(rows[3].pw)}`);
ok(rows[3].acc > rows[0].acc,
  `a placed finesse beats a scuffed one: scored ${Math.round(rows[0].acc * 100)}% -> ${Math.round(rows[3].acc * 100)}%`);
ok(rows[3].acc > rows[0].acc * 2.5,
  `a properly struck finesse is worth several scuffed ones: ${Math.round(rows[0].acc * 100)}% -> ${Math.round(rows[3].acc * 100)}% scored`);
// and the shooting stat has to matter, not just the hold
const shooters = [['striker', 'a good finisher'], ['enforcer', 'a poor finisher']];
for (const [arche, label] of shooters) {
  const TT = [{ name: 'Y', color: 0, captain: { arche, traits: {} }, sidekick: { arche: 'allround', traits: {} } }, TEAMS[1]];
  let goals = 0, off = 0, n = 0;
  for (let k = 0; k < SEEDS; k++) {
    const st = makeMatch({ seed: 100 + k * 37, teams: TT, practice: { mates: 0, defs: 0 } });
    const m2 = st.players[0]; m2.x = 22; m2.y = -11; m2.fx = 1; m2.fy = 0;
    practiceResetBall(st, 'feet');
    let res = null, arrived = null;
    for (let t = 0; t < 300 && !res; t++) {
      const inp = new Array(10).fill(null);
      inp[0] = { mx: 0, my: 0, agy: 2.4, az: 1.0, bHeld: t < 70, finesse: true, human: true };
      step(st, inp);
      for (const e of st.events) {
        if (e.t === 'GOAL') res = 'GOAL';
        if (e.t === 'SAVE_CATCH' || e.t === 'SAVE_PARRY' || e.t === 'KEEPER_STUN') res = 'saved';
        if (e.t === 'WOODWORK') res = 'woodwork';
      }
      if (arrived === null && st.ball.x >= TUNE.pitchW / 2 - 0.35) arrived = st.ball.y;
    }
    if (res === 'GOAL') goals++;
    if (arrived !== null) { off += Math.abs(arrived - 2.4); n++; }
  }
  console.log(`       ${label} (${arche}): scored ${Math.round(goals / SEEDS * 100)}% · lands ${n ? R1(off / n) : '?'}m from where aimed`);
  rows.push({ tag: arche, acc: goals / SEEDS, err: n ? off / n : 99 });
}
const good = rows.find(r => r.tag === 'striker'), poor = rows.find(r => r.tag === 'enforcer');
ok(good.acc > poor.acc, `the better finisher converts more: ${Math.round(good.acc * 100)}% vs ${Math.round(poor.acc * 100)}%`);
ok(good.err < poor.err, `...and puts it closer to where he aimed: ${R1(good.err)}m vs ${R1(poor.err)}m`);

// ---------------------------------------------------------------------------
console.log('\n=== 4. keeper body-check ===');
function boxRush({ deke = false }) {
  const s = arena();
  const me = s.players[0];
  me.x = TUNE.pitchW / 2 - TUNE.boxW - 3; me.y = 0; me.fx = 1; me.fy = 0;
  practiceResetBall(s, 'feet');
  let started = -1, hit = false, whiff = false;
  for (let t = 0; t < 400; t++) {
    const inputs = new Array(10).fill(null);
    // deke a few ticks after the wind-up begins — i.e. reading the telegraph
    const dodgeNow = deke && started >= 0 && (t - started) === TUNE.kCheckWindup - 3;
    inputs[0] = { mx: 1, my: 0, yHeld: dodgeNow, human: true };
    step(s, inputs);
    for (const e of s.events) {
      if (e.t === 'KEEPER_CHECK_START' && started < 0) started = t;
      if (e.t === 'KEEPER_CHECK') hit = true;
      if (e.t === 'KEEPER_CHECK_WHIFF') whiff = true;
    }
    if (hit || whiff) break;
  }
  return { started, hit, whiff };
}
const walkIn = boxRush({ deke: false });
ok(walkIn.started >= 0, `keeper starts a check when you carry the ball in (tick ${walkIn.started})`);
ok(walkIn.hit, 'walking in and doing nothing gets you flattened');
const dodged = boxRush({ deke: true });
ok(dodged.whiff && !dodged.hit, `a deke on the telegraph beats it (whiff=${dodged.whiff} hit=${dodged.hit})`);
ok(TUNE.kCheckWindup >= 14, `wind-up is ${TUNE.kCheckWindup} ticks (${R1(TUNE.kCheckWindup / 60 * 1000)} ms) — long enough to read`);



// ---------------------------------------------------------------------------
// The complaint: on a BENT pass, team-mates don't run onto the ball. The old
// receiver logic chased the ball's instantaneous heading, which on a curling
// ball points somewhere the ball is never going to be.
console.log('\n=== 5. do team-mates actually run onto a bent pass? ===');
function bentPassRun({ bend, aimAt }) {
  const s = makeMatch({ seed: 11, teams: TEAMS, practice: { mates: 1, defs: 0 } });
  const me = s.players[0], mate = s.players[1];
  me.x = -2; me.y = -8; me.fx = 1; me.fy = 0;
  mate.x = 6; mate.y = 6;                       // off to one side, must travel
  practiceResetBall(s, 'feet');
  const brain = makeBrain(0);
  const hold = holdFor(Math.hypot(aimAt[0] - me.x, aimAt[1] - me.y));
  let caught = -1, closest = 99;
  for (let t = 0; t < 260 && caught < 0; t++) {
    const inputs = new Array(10).fill(null);
    inputs[0] = {
      mx: bend, my: 0,                          // push across the line = bend it
      ax: aimAt[0] - me.x, ay: aimAt[1] - me.y,
      aHeld: t < hold, human: true,
    };
    aiInputs(s, 0, DIFFICULTY.pro, new Set([0]), brain, inputs);
    step(s, inputs);
    if (s.ball.flight) closest = Math.min(closest, Math.hypot(mate.x - s.ball.x, mate.y - s.ball.y));
    const o = s.ball.owner;
    if (o >= 0 && o !== 0) caught = o;
  }
  return { caught, closest: R1(closest) };
}
for (const bend of [0, 0.7, -0.7]) {
  const r = bentPassRun({ bend, aimAt: [14, 8] });
  ok(r.caught === 1,
    `bend ${bend >= 0 ? ' ' : ''}${bend}: receiver ${r.caught === 1 ? 'ran onto it' : `did NOT get it (owner ${r.caught})`}, closest approach ${r.closest} m`);
}

// ---------------------------------------------------------------------------
// 1-on-1: he should come OUT to meet you and stand tall, and that is exactly when
// a chip should beat him.
console.log('\n=== 6. keeper comes out 1-on-1, and the chip goes over him ===');
function oneOnOne({ chip, startX = 4, hold = 0 }) {
  const s = makeMatch({ seed: 21, teams: TEAMS, practice: { mates: 0, defs: 0 } });
  const me = s.players[0];
  me.x = startX; me.y = 0; me.fx = 1; me.fy = 0;
  practiceResetBall(s, 'feet');
  const gk = s.players[9];
  const lineX = TUNE.pitchW / 2 - TUNE.keeperLine;
  let cameOut = 0, res = null, shotAt = -1, peakZ = 0, zOverGk = null, jumped = false;
  for (let t = 0; t < 320 && !res; t++) {
    const inputs = new Array(10).fill(null);
    const shootNow = shotAt < 0 && me.x > TUNE.pitchW / 2 - 15;
    if (shootNow) shotAt = t;
    inputs[0] = { mx: 1, my: 0, agy: 0, az: chip ? undefined : 1.2,
      bHeld: shotAt >= 0 && t < shotAt + hold + 2, lobHeld: chip, human: true };
    step(s, inputs);
    cameOut = Math.max(cameOut, lineX - gk.x);
    for (const e of s.events) {
      if (e.t === 'KEEPER_JUMP') jumped = true;
      if (e.t === 'GOAL') res = 'GOAL';
      if (e.t === 'SAVE_CATCH') res = e.air ? 'caught in the air' : 'saved';
      if (e.t === 'SAVE_PARRY') res = 'parried';
      if (e.t === 'KEEPER_CLAIM') res = 'keeper claimed';
      if (e.t === 'WOODWORK') res = 'woodwork';
    }
    if (shotAt >= 0 && s.ball.flight) {
      peakZ = Math.max(peakZ, s.ball.z);
      if (zOverGk === null && s.ball.x >= gk.x) zOverGk = s.ball.z;
    }
  }
  return { cameOut: R1(cameOut), res, peakZ: R1(peakZ), zOverGk: zOverGk === null ? null : R1(zOverGk), jumped };
}
const drive = oneOnOne({ chip: false, hold: 30 });
ok(drive.cameOut > 3.5, `keeper leaves his line to challenge: came out ${drive.cameOut} m (was capped near 2.5)`);
console.log(`       driven shot 1-on-1: ${drive.res}`);
const chipped = oneOnOne({ chip: true, hold: 0 });
console.log(`       chip 1-on-1: keeper out ${chipped.cameOut}m · ball peaked ${chipped.peakZ}m · was ${chipped.zOverGk}m up crossing him · jumped=${chipped.jumped} -> ${chipped.res}`);
ok(chipped.peakZ > TUNE.keeperJumpZ,
  `a chip actually gets up: peaked ${chipped.peakZ} m vs a keeper reaching ${TUNE.keeperJumpZ} m`);
ok(chipped.zOverGk === null || chipped.zOverGk > TUNE.keeperReach,
  `and it is above his standing reach as it passes him (${chipped.zOverGk} m)`);

console.log(fails === 0 ? '\nALL GAMEPLAY CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
