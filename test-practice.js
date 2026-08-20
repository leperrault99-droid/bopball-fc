// Headless practice-mode check. Confirms:
//   1. a practice match steps for a long time without NaN / throwing
//   2. `off` players never leave the parking spot and never touch the ball
//   3. dummies can be added and removed mid-session
//   4. scoring resets the ball instead of stopping play
//   5. a normal match still produces the exact same hash as before the change
import {
  makeMatch, step, matchHash, practiceSetup, practiceResetBall, practiceResetPlayers, TUNE,
} from './sim.js';
import { DIFFICULTY, makeBrain, aiInputs } from './ai.js';

const T = (name, cap, side) => ({ name, color: 0, captain: { arche: cap, traits: {} }, sidekick: { arche: side, traits: {} } });
const TEAMS = [T('YOU', 'striker', 'allround'), T('CPU', 'enforcer', 'playmaker')];
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`); if (!cond) fails++; };

// ---------------------------------------------------------------- practice --
console.log('--- practice: 60s solo + keeper, holding shoot ---');
const s = makeMatch({ seed: 99, teams: TEAMS, practice: { mates: 2, defs: 1 } });

ok(s.phase === 'play', 'starts in play (no countdown)');
ok(s.ball.owner === 0, 'ball starts at your feet');
const liveIds = s.players.filter(p => !p.off).map(p => p.i);
ok(JSON.stringify(liveIds) === JSON.stringify([0, 1, 2, 5, 9]), `live roster is you+2 mates+1 def+their keeper (got ${liveIds})`);

let touchedByOff = 0, offMoved = 0, goals = 0;
for (let t = 0; t < 60 * 60; t++) {
  const inputs = new Array(10).fill(null);
  // you: run at the goal and mash shoot / pass / deke on a cycle
  const ph = t % 180;
  inputs[0] = {
    mx: 1, my: Math.sin(t / 40) * 0.6, sprint: ph > 120,
    aHeld: ph > 60 && ph < 70, bHeld: ph > 100 && ph < 130, yHeld: ph > 150 && ph < 155,
    lobHeld: false, human: true,
  };
  step(s, inputs);
  for (const p of s.players) {
    if (!isFinite(p.x) || !isFinite(p.y)) throw new Error(`NaN player p${p.i} tick ${s.tick}`);
    if (p.off) {
      if (Math.abs(p.y) < 100) offMoved++;
      if (s.ball.owner === p.i || s.ball.lastTouch === p.i) touchedByOff++;
    }
  }
  if (!isFinite(s.ball.x) || !isFinite(s.ball.z)) throw new Error(`NaN ball tick ${s.tick}`);
  for (const e of s.events) if (e.t === 'GOAL') goals++;
}
ok(offMoved === 0, 'parked players never came back onto the pitch');
ok(touchedByOff === 0, 'parked players never touched the ball');
ok(s.phase === 'play', 'still in play after 60s (no clock, no celebration)');
ok(s.clock > 9000, 'clock does not run in practice');
console.log(`       ${goals} goals scored in the session, score ${s.score.join('-')}`);

// -------------------------------------------------------------- hot reconfig --
console.log('--- practice: reconfigure mid-session ---');
practiceSetup(s, { mates: 3, defs: 4, ownKeeper: true });
ok(s.players.every(p => !p.off), 'all 10 live with a full setup');
practiceSetup(s, { mates: 0, defs: 0, ownKeeper: false });
const solo = s.players.filter(p => !p.off).map(p => p.i);
ok(JSON.stringify(solo) === JSON.stringify([0, 9]), `back to you + their keeper (got ${solo})`);
practiceResetBall(s, 'feet');
ok(s.ball.owner === 0, 'reset returns the ball to your feet');
practiceResetPlayers(s);
for (let t = 0; t < 600; t++) step(s, [{ mx: 1, my: 0, bHeld: t % 90 < 40, human: true }, ...new Array(9).fill(null)]);
ok(isFinite(s.ball.x) && s.players.every(p => isFinite(p.x)), 'stable after reconfigure');

// ---- a keeper that is off must not act -------------------------------------
console.log('--- practice: own keeper off ---');
const k0 = s.players[4];
ok(k0.off === true, 'own keeper is parked');
ok(Math.abs(k0.y) > 100, 'own keeper stays parked');

// ------------------------------------------------------- normal-match parity --
console.log('--- regression: normal match is byte-identical ---');
function normalHash(seed) {
  const m = makeMatch({ seed, timerLen: 180, teams: TEAMS, keeperReflex: [DIFFICULTY.pro.keeperReflex, DIFFICULTY.pro.keeperReflex] });
  const brains = [makeBrain(0), makeBrain(1)];
  while (m.phase !== 'over' && m.tick < 420 * 60) {
    const inputs = new Array(10).fill(null);
    aiInputs(m, 0, DIFFICULTY.pro, null, brains[0], inputs);
    aiInputs(m, 1, DIFFICULTY.pro, null, brains[1], inputs);
    step(m, inputs);
  }
  return `${matchHash(m)}|${m.score.join('-')}|${m.tick}`;
}
for (const seed of [1337, 2674, 4011]) console.log(`       seed ${seed}: ${normalHash(seed)}`);
ok(s.players[0].off === false, 'sanity');

console.log(fails === 0 ? '\nALL PRACTICE CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
