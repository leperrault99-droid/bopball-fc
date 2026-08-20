// Headless AI-vs-AI harness: scorelines, difficulty ladder, determinism, sanity.
import { makeMatch, step, matchHash, ARCHETYPES, assertPortable } from './sim.js';
import { DIFFICULTY, makeBrain, aiInputs, effectiveProfile } from './ai.js';

function team(name, cap, side) {
  return { name, color: 0, captain: { arche: cap, traits: {} }, sidekick: { arche: side, traits: {} } };
}

function runMatch(seed, diffA, diffB, timerLen = 180, collect = false) {
  const s = makeMatch({
    seed, timerLen,
    teams: [team('A', 'striker', 'allround'), team('B', 'enforcer', 'playmaker')],
    keeperReflex: [DIFFICULTY[diffA].keeperReflex, DIFFICULTY[diffB].keeperReflex],
  });
  const brains = [makeBrain(0), makeBrain(1)];
  const evCount = {};
  const maxTicks = (timerLen + 240) * 60; // + OT cap
  let hashes = [];
  while (s.phase !== 'over' && s.tick < maxTicks) {
    const inputs = new Array(10).fill(null);
    aiInputs(s, 0, DIFFICULTY[diffA], null, brains[0], inputs);
    aiInputs(s, 1, DIFFICULTY[diffB], null, brains[1], inputs);
    step(s, inputs);
    for (const e of s.events) evCount[e.t] = (evCount[e.t] || 0) + 1;
    for (const p of s.players) {
      if (!isFinite(p.x) || !isFinite(p.y)) throw new Error(`NaN player pos tick ${s.tick} p${p.i}`);
    }
    if (!isFinite(s.ball.x) || !isFinite(s.ball.z)) throw new Error(`NaN ball tick ${s.tick}`);
    if (collect && s.tick % 1000 === 0) hashes.push(matchHash(s));
  }
  return { score: s.score.slice(), ticks: s.tick, ot: s.overtime, evCount, hashes };
}

const mode = process.argv[2] || 'all';

if (mode === 'all' || mode === 'score') {
  console.log('--- pro vs pro, 3:00, 6 seeds ---');
  let tot = 0, res = [];
  for (let seed = 1; seed <= 6; seed++) {
    const r = runMatch(seed * 1337, 'pro', 'pro');
    tot += r.score[0] + r.score[1];
    res.push(`${r.score[0]}-${r.score[1]}${r.ot ? ' OT' : ''}`);
  }
  console.log(res.join('  '), '| avg combined goals:', (tot / 6).toFixed(1), '(target ~2.4-4.2 for 3:00)');

  console.log('--- superstar vs superstar, 3:00, 4 seeds ---');
  res = []; tot = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const r = runMatch(seed * 777, 'superstar', 'superstar');
    tot += r.score[0] + r.score[1];
    res.push(`${r.score[0]}-${r.score[1]}${r.ot ? ' OT' : ''}`);
  }
  console.log(res.join('  '), '| avg:', (tot / 4).toFixed(1));
}

if (mode === 'all' || mode === 'ladder') {
  console.log('--- legend (A) vs rookie (B), 3:00, 6 seeds ---');
  let wins = 0; const res = [];
  for (let seed = 1; seed <= 6; seed++) {
    const r = runMatch(seed * 31 + 7, 'legend', 'rookie');
    if (r.score[0] > r.score[1]) wins++;
    res.push(`${r.score[0]}-${r.score[1]}`);
  }
  console.log(res.join('  '), `| legend wins ${wins}/6 (target 6/6 or 5/6)`);
}

if (mode === 'all' || mode === 'det') {
  console.log('--- determinism: same seed twice ---');
  const a = runMatch(4242, 'pro', 'pro', 120, true);
  const b = runMatch(4242, 'pro', 'pro', 120, true);
  const same = JSON.stringify(a.hashes) === JSON.stringify(b.hashes) &&
    a.score[0] === b.score[0] && a.score[1] === b.score[1];
  console.log(same ? 'DETERMINISTIC ✓' : 'DESYNC ✗', a.score, b.score);
  if (!same) process.exit(1);
  // Same seed twice in one engine only proves the sim is repeatable. Rollback
  // also needs it to be repeatable across ENGINES, which means no exp/sin/cos/
  // atan2 in the shared path and the frozen constants matching the tuning.
  const drift = assertPortable();
  console.log(drift.length ? 'PORTABLE ✗ ' + drift.join(' | ') : 'PORTABLE ✓ (frozen constants match tuning)');
  if (drift.length) process.exit(1);
}

if (mode === 'all' || mode === 'events') {
  const r = runMatch(9001, 'pro', 'pro');
  console.log('--- event counts (pro/pro 3:00) ---');
  console.log(r.evCount);
  const hits = r.evCount.BIG_HIT || 0;
  console.log('shots:', r.evCount.SHOT || 0, 'passes:', r.evCount.PASS || 0, 'bigHits:', hits,
    'perfectPasses:', r.evCount.PERFECT_PASS || 0, 'oneTimers:', r.evCount.ONE_TIMER || 0,
    'saves:', (r.evCount.SAVE_CATCH || 0) + (r.evCount.SAVE_PARRY || 0), 'zaps:', r.evCount.ZAP || 0);
}
console.log('done');
