// ============================================================================
// BOPBALL FC — team AI. Pure: reads state, emits PlayerInput per AI slot.
// Layers: team brain (roles, single chaser) → per-player utility → steering.
// AI only produces the same inputs a human can; never exceeds human caps.
// ============================================================================
import { TUNE, TICK_RATE, rnd, gauss, maxSpeed, passLandingSpot } from './sim.js';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const len = (x, y) => Math.sqrt(x * x + y * y);
function norm(x, y) { const l = len(x, y) || 1; return [x / l, y / l]; }

// ------------------------------------------------------- difficulty tiers ---
export const DIFFICULTY = {
  rookie:    { label: 'Rookie',    interval: 34, react: 32, sigma: 0.24, temp: 1.6, aggr: 0.28, tackleP: 0.20, hitP: 0.10, otP: 0.12, keeperReflex: 22, dekeP: 0.1, standoff: 2.4, commitP: 0.040 },
  pro:       { label: 'Pro',       interval: 16, react: 18, sigma: 0.14, temp: 0.85, aggr: 0.55, tackleP: 0.45, hitP: 0.30, otP: 0.40, keeperReflex: 15, dekeP: 0.35, standoff: 1.7, commitP: 0.090 },
  superstar: { label: 'Superstar', interval: 9,  react: 11, sigma: 0.07, temp: 0.45, aggr: 0.75, tackleP: 0.65, hitP: 0.45, otP: 0.65, keeperReflex: 10, dekeP: 0.6, standoff: 1.45, commitP: 0.140 },
  legend:    { label: 'Legend',    interval: 6,  react: 7,  sigma: 0.035, temp: 0.18, aggr: 0.9,  tackleP: 0.82, hitP: 0.6,  otP: 0.85, keeperReflex: 7,  dekeP: 0.8, standoff: 1.25, commitP: 0.200 },
};
export const TIER_ORDER = ['rookie', 'pro', 'superstar', 'legend'];

// Momentum: losing team's AI gets a partial bump toward next tier (offline nicety)
export function effectiveProfile(base, state, team, momentumOn) {
  if (!momentumOn) return base;
  const diff = state.score[1 - team] - state.score[team];
  if (diff < 2) return base;
  const idx = TIER_ORDER.findIndex(k => DIFFICULTY[k] === base);
  const next = DIFFICULTY[TIER_ORDER[Math.min(idx < 0 ? 1 : idx + 1, 3)]];
  const mix = Math.min(0.5 + (diff - 2) * 0.25, 1);
  const out = {};
  for (const k in base) out[k] = typeof base[k] === 'number' ? base[k] + (next[k] - base[k]) * mix : base[k];
  return out;
}

// ------------------------------------------------------------- brains -------
export function makeBrain(team) {
  return {
    team, chaser: -1, roles: {}, assignT: 0,
    mem: {}, // per slot index: {decT, action, data}
  };
}

function ballPos(s) {
  const b = s.ball;
  if (b.owner >= 0) { const o = s.players[b.owner]; return [o.x, o.y]; }
  return [b.x, b.y];
}

function timeToBall(s, p) {
  const [bx, by] = ballPos(s);
  return len(bx - p.x, by - p.y) / maxSpeed(p);
}

// role assignment ~ every 12 ticks
function assignRoles(s, brain) {
  const team = brain.team;
  const [, byNow] = ballPos(s);
  if (Math.abs(byNow) > 3) brain.sideBias = byNow >= 0 ? -1 : 1;
  else if (brain.sideBias === undefined) brain.sideBias = 1;
  const field = s.players.filter(p => p.team === team && !p.keeper);
  const weOwn = s.ball.owner >= 0 && s.players[s.ball.owner].team === team;
  // chaser: fastest arrival with hysteresis
  let best = -1, bestT = Infinity;
  for (const p of field) {
    if (s.ball.owner === p.i) { best = p.i; bestT = 0; break; }
    let t = timeToBall(s, p);
    if (p.i === brain.chaser) t *= 0.82;               // hysteresis
    if (p.st !== 'norm') t += 1.5;
    if (t < bestT) { bestT = t; best = p.i; }
  }
  brain.chaser = best;
  const others = field.filter(p => p.i !== best);
  const d = team === 0 ? 1 : -1;
  const roles = {};
  roles[best] = weOwn ? 'carry' : 'chase';
  if (weOwn) {
    // deepest bean is the safety; of the two runners, whoever is already closest
    // to the far-side lane becomes the far winger (no lane-swapping dance)
    others.sort((a, b) => (a.x * d) - (b.x * d));       // deepest first
    const safety = others[0];
    if (safety) roles[safety.i] = 'safety';
    const runners = others.slice(1);
    if (runners.length === 2) {
      const farY = (brain.sideBias ?? 1) * (TUNE.pitchH / 2 - 3);
      runners.sort((a, b) => Math.abs(a.y - farY) - Math.abs(b.y - farY));
      roles[runners[0].i] = 'support1';
      roles[runners[1].i] = 'support2';
    } else if (runners.length === 1) roles[runners[0].i] = 'support1';
  } else {
    // nearest marks most dangerous attacker, deepest defends, other covers mid
    // The marker must NEVER take the carrier — that's the chaser's job, and having
    // both converge is what made the defence feel like a horde you can't shake.
    // Mark the most dangerous OTHER attacker instead.
    const opps = s.players.filter(p => p.team !== team && !p.keeper && p.i !== s.ball.owner);
    opps.sort((a, b) => (a.x * d) - (b.x * d));         // deepest into our half first
    others.sort((a, b) => timeToBall(s, a) - timeToBall(s, b));
    if (others[0]) { roles[others[0].i] = 'mark'; brain.markTarget = opps[0] ? opps[0].i : -1; }
    if (others[1]) roles[others[1].i] = 'cover';
    if (others[2]) roles[others[2].i] = 'safety';
  }
  brain.roles = roles;
}

// support spot: simple candidate scan
function supportSpot(s, p, brain, which) {
  const team = p.team, d = team === 0 ? 1 : -1;
  const [bx, by] = ballPos(s);
  const hw = TUNE.pitchW / 2, hh = TUNE.pitchH / 2;
  const sideBias = brain.sideBias ?? (by >= 0 ? -1 : 1);   // sticky: no oscillating through the middle
  // "show for the ball": when the carrier is swarmed (or ball loose in a crowd),
  // supports sprint to WIDE outlet spots — the escape pass.
  let pressN = 0;
  for (const o of s.players) if (o.team !== team && !o.keeper && len(o.x - bx, o.y - by) < 2.6) pressN++;
  const contested = pressN >= 2 || s.ball.owner < 0;
  // candidates: [xAhead (attack dir, relative to ball), yAbsolute (world width)]
  // ---- ATTACKING THIRD: get into a shooting slot, not out on the touchline.
  // Every other candidate list here is built from (hh - 3) etc, i.e. y = +-12 on a
  // 30-wide pitch, which is a terrible angle on a 6.3-wide goal. Driving the net,
  // supports should be finding the space in front of it and squaring up for a
  // one-timer.
  const gxA = d * hw;                                   // goal we're attacking
  if (!contested && bx * d > hw - TUNE.attackThirdD) {
    const slots = which === 1
      ? [[4.0, 2.6], [6.5, -1.2], [3.0, -3.4], [9.0, 1.0]]     // far post, slot, near post, top of D
      : [[3.2, -2.4], [7.0, 2.0], [5.0, 0.0], [10.0, -2.8]];
    let bestS = null, bestSc = -Infinity;
    for (const [back, oy] of slots) {
      const x = gxA - d * back;
      const y = clamp(oy, -(hh - 3), hh - 3);
      let nearOpp = 99, nearMate = 99;
      for (const o of s.players) {
        if (o.i === p.i) continue;
        const dd = len(o.x - x, o.y - y);
        if (o.team !== team) nearOpp = Math.min(nearOpp, dd);   // keepers count here
        else if (s.ball.owner !== o.i) nearMate = Math.min(nearMate, dd);
      }
      // angle on goal: how square you are to the mouth from this spot
      const angle = Math.abs(gxA - x) / (Math.abs(gxA - x) + Math.abs(y) * 1.9 + 0.01);
      // and a clean passing lane from the ball to here
      let lane = 9;
      const [lx, ly] = norm(x - bx, y - by), ld = len(x - bx, y - by);
      for (const o of s.players) {
        if (o.team === team || o.keeper) continue;
        const t = clamp((o.x - bx) * lx + (o.y - by) * ly, 0, ld);
        lane = Math.min(lane, len(bx + lx * t - o.x, by + ly * t - o.y));
      }
      const sc = angle * 3.2 + Math.min(nearOpp, 6) * 0.45 + Math.min(lane, 4) * 0.5
        + Math.min(nearMate, 6) * 0.2 - len(x - p.x, y - p.y) * 0.03;
      if (sc > bestSc) { bestSc = sc; bestS = [x, y]; }
    }
    if (bestS) return bestS;
  }

  let cands;
  if (contested) {
    cands = which === 1
      ? [[3, sideBias * (hh - 3)], [6, sideBias * (hh - 4)], [2, -sideBias * (hh - 3)], [8, sideBias * (hh - 6)]]
      : [[3, -sideBias * (hh - 3)], [6, -sideBias * (hh - 4)], [2, sideBias * (hh - 3)], [8, -sideBias * (hh - 6)]];
  } else if (which === 1) {
    // far-side winger: hug the far touchline, plus a far-post runner
    cands = [[6, sideBias * (hh - 3)], [10, sideBias * (hh - 3.5)], [13, sideBias * (hh - 6)], [8, sideBias * (hh - 8)]];
  } else {
    // second runner: near-side width or a central spearhead ahead of the ball
    cands = [[9, -sideBias * (hh - 3.5)], [12, -sideBias * (hh - 6)], [14, sideBias * 2.5], [7, -sideBias * (hh - 3)]];
  }
  let best = null, bestScore = -Infinity;
  for (const [ox, oy] of cands) {
    const rawX = Math.max(bx * d + ox, contested ? 0 : 5);
    const x = clamp(rawX, -(hw - 2), hw - 3) * d;
    const y = clamp(oy, -(hh - 2.5), hh - 2.5);      // ABSOLUTE width — spots stay wide
    let nearOpp = 99, nearMate = 99;
    for (const o of s.players) {
      if (o.keeper || o.i === p.i) continue;
      const dd = len(o.x - x, o.y - y);
      if (o.team !== team) nearOpp = Math.min(nearOpp, dd);
      else if (s.ball.owner !== o.i) nearMate = Math.min(nearMate, dd);
    }
    const score = Math.min(nearOpp, 9) * 0.55        // open space
      + Math.abs(y - by) * 0.05                      // stretch away from the ball
      + Math.min(nearMate, 8) * 0.12                 // don't stack with a teammate
      + (x * d) * 0.015                              // slight forward preference
      - len(x - p.x, y - p.y) * 0.02;                // travel cost
    if (score > bestScore) { bestScore = score; best = [x, y]; }
  }
  return best || [bx + 6 * d, sideBias * (hh - 4)];
}

// --------------------------------------------------------- main entry -------
// Fills inputs[] for every non-human, non-keeper slot on `team`.
export function aiInputs(s, team, profile, humanSlots, brain, inputs) {
  if ((s.tick - brain.assignT) > 12 || brain.chaser < 0) { assignRoles(s, brain); brain.assignT = s.tick; }
  for (const p of s.players) {
    if (p.team !== team || p.keeper) continue;
    if (humanSlots && humanSlots.has(p.i)) continue;
    inputs[p.i] = think(s, p, profile, brain);
    applySpacing(s, p, inputs[p.i], brain);
  }
}

// Anti-mosh-pit steering: teammates keep personal space, and everyone who is
// NOT the designated contester steers OUT of the scrum around the ball.
function applySpacing(s, p, inp, brain) {
  if (!inp) return;
  const b = s.ball;
  if (b.owner === p.i) return;                                     // carrier is exempt
  if (b.flight && (b.flight.type === 'pass' || b.flight.type === 'lobpass') && b.flight.tgt === p.i) return;  // receiving
  let ax = inp.mx, ay = inp.my;
  const weOwnSp = b.owner >= 0 && s.players[b.owner].team === p.team;
  const sepR = weOwnSp ? 4.0 : 2.5;                  // attackers demand real spacing
  // teammate separation (boids)
  for (const q of s.players) {
    if (q.team !== p.team || q.i === p.i || q.keeper) continue;
    const dx = p.x - q.x, dy = p.y - q.y, d = len(dx, dy);
    if (d < sepR && d > 0.01) {
      const w = (sepR - d) / sepR * 0.7;
      ax += (dx / d) * w; ay += (dy / d) * w;
    }
  }
  // attackers give the carrier room to work
  if (weOwnSp && b.owner !== p.i) {
    const dcx = p.x - s.players[b.owner].x, dcy = p.y - s.players[b.owner].y, dc = len(dcx, dcy);
    if (dc < 4.5 && dc > 0.01) {
      const w = (4.5 - dc) / 4.5 * 0.6;
      ax += (dcx / dc) * w; ay += (dcy / dc) * w;
    }
  }
  // one contester per team: everyone else stays out of the scrum radius
  if (brain.chaser !== p.i) {
    const dbx = p.x - b.x, dby = p.y - b.y, db = len(dbx, dby);
    if (db < 3.5) {
      let crowd = 0;
      for (const q of s.players) if (!q.keeper && len(q.x - b.x, q.y - b.y) < 2.2) crowd++;
      if (b.owner < 0 || crowd >= 2) {
        const w = (3.5 - db) / 3.5 * 0.9;
        ax += (dbx / (db || 1)) * w; ay += (dby / (db || 1)) * w;
      }
    }
  }
  const l = len(ax, ay);
  if (l > 1) { ax /= l; ay /= l; }
  inp.mx = ax; inp.my = ay;
}

function think(s, p, prof, brain) {
  // commitT MUST be initialised: `undefined <= 0` is false in JS, so leaving it
  // out silently disables the commit entirely (this exact trap already cost us the
  // keeper dive once).
  const mem = brain.mem[p.i] || (brain.mem[p.i] = { decT: 0, action: null, aim: 0, spot: null, releaseAt: 0, otPressed: false, commitT: 0 });
  const inp = { mx: 0, my: 0, sprint: false, aHeld: false, bHeld: false, yHeld: false, lobHeld: false };
  const b = s.ball, team = p.team, d = team === 0 ? 1 : -1;
  const hasBall = b.owner === p.i;
  const role = brain.roles[p.i] || 'safety';
  const gx = d * TUNE.pitchW / 2;

  // keeper-hold distribution nudge (any AI teammate may trigger throw)
  if (b.owner === team * 5 + 4 && s.players[b.owner].holdT > 45 && p.slot === 0) inp.distA = true;

  mem.decT--;

  // ---------- carrying the ball ----------
  if (hasBall) {
    if (!mem.hadBall) { mem.hadBall = true; mem.gotBallAt = s.tick; mem.action = null; mem.decT = 0; }
    if (mem.action && mem.action.type === 'shoot') {
      // keep charging until planned release
      inp.bHeld = s.tick < mem.releaseAt;
      inp.lobHeld = !!mem.action.chip;
      inp.mx = mem.action.mx; inp.my = mem.action.my;
      if (s.tick >= mem.releaseAt + 2) mem.action = null;
      return inp;
    }
    if (mem.decT <= 0 || !mem.action || mem.action.type === 'moveto') {
      mem.decT = prof.interval + Math.floor(rnd(s) * prof.interval * 0.5);
      mem.action = decideWithBall(s, p, prof, brain, mem);
    }
    const a = mem.action;
    if (a.type === 'pass') {
      const r = s.players[a.tgt];
      const [nx, ny] = norm(r.x - p.x, r.y - p.y);
      inp.mx = nx; inp.my = ny; inp.aHeld = true; inp.lobHeld = !!a.lob;
      mem.action = null; mem.decT = Math.max(mem.decT, 8);
      mem.runFwdUntil = s.tick + 55;                    // give-and-go: burst forward after the pass
      return inp;
    }
    if (a.type === 'shoot') {
      const stageT = a.stage > 0 ? TUNE.chargeStageT[a.stage - 1] + 4 : 2;
      mem.releaseAt = s.tick + stageT;
      const aimY = a.aimY + gauss(s) * prof.sigma * 6;
      const [nx, ny] = norm(gx - p.x, aimY - p.y);
      a.mx = nx; a.my = clamp(aimY / 3.0, -1, 1);
      inp.bHeld = true; inp.mx = a.mx; inp.my = a.my; inp.lobHeld = !!a.chip;
      return inp;
    }
    // dribble
    let tx = gx, ty = p.y * 0.5;
    let press = null, pressD = 99;
    for (const o of s.players) {
      if (o.team === team || o.keeper) continue;
      const dd = len(o.x - p.x, o.y - p.y);
      if (dd < pressD) { pressD = dd; press = o; }
    }
    if (press && pressD < 3.2) {
      // weave away laterally from the presser
      const side = Math.sign((p.y - press.y) || (rnd(s) - 0.5));
      ty = clamp(p.y + side * 5, -(TUNE.pitchH / 2 - 4), TUNE.pitchH / 2 - 4);
      tx = p.x + d * 4;
      // deke if presser committed (esp. if they're sliding — deke beats slides)
      const sliding = press.st === 'slide';
      if (pressD < 2.1 && p.cdDeke <= 0 && rnd(s) < prof.dekeP * (sliding ? 0.8 : 0.3)) inp.yHeld = true;
    }
    const [nx, ny] = norm(tx - p.x, ty - p.y);
    inp.mx = nx; inp.my = ny; inp.sprint = true;
    return inp;
  }

  if (mem.hadBall && !hasBall) mem.hadBall = false;

  // ---------- off ball ----------
  // one-timer: incoming pass to me + decent shot position
  if (b.flight && (b.flight.type === 'pass' || b.flight.type === 'lobpass') && b.flight.tgt === p.i) {
    const goalD = len(gx - p.x, p.y);
    if (mem.otFlightFrom !== b.flight.from + ':' + b.flight.t0) { /* new flight → decide once */ }
    if (!mem.otDecided) {
      mem.otDecided = true;
      mem.otWant = goalD < 18 && rnd(s) < prof.otP;
      mem.otPressed = false;
      if (globalThis.__AIDBG) console.log('OTDECIDE p', p.i, 'goalD', goalD.toFixed(1), 'otP', prof.otP, 'want', mem.otWant);
    }
    if (mem.otWant && !mem.otPressed) {
      // good AI presses late (lands in the perfect window); weak AI presses early
      const dToBall = len(b.x - p.x, b.y - p.y);
      const ballSpd = len(b.vx, b.vy) || 1;
      const remaining = Math.round(dToBall / ballSpd * TICK_RATE);
      const pressAt = prof.react <= 9 ? 6 : 18;
      if (globalThis.__AIDBG) console.log('OTTICK p', p.i, 'rem', remaining, 'pressAt', pressAt);
      if (remaining <= pressAt) { inp.bHeld = true; mem.otPressed = true; if (globalThis.__AIDBG) console.log('OTPRESS p', p.i); }
    }
    // Meeting the pass is our job. Aim at WHERE IT WILL ARRIVE, not at where its
    // velocity happens to point right now — on a bent ball those are different
    // places, and the gap is the entire swing. Chasing the instantaneous heading
    // meant a curled pass was never run onto: the receiver drifted toward the
    // straight-line projection, the ball curved off it, and the ball just rolled
    // through where nobody was.
    const land = passLandingSpot(s) || { x: b.x + b.vx * 0.3, y: b.y + b.vy * 0.3 };
    const dLand = len(land.x - p.x, land.y - p.y);
    if (dLand < TUNE.catchR * 0.9) {
      // already standing where it's going to be: settle, don't wander off the spot
      const [nx, ny] = norm(land.x - p.x, land.y - p.y);
      inp.mx = nx * 0.35; inp.my = ny * 0.35;
    } else {
      // Run onto it. Full commitment — a ball played into space is only a chance
      // if somebody actually attacks the space.
      const [nx, ny] = norm(land.x - p.x, land.y - p.y);
      inp.mx = nx; inp.my = ny;
      const myV = Math.max(maxSpeed(p), 1);
      const ballT = (Math.max((b.flight.eta || 0) - b.flight.t, 0)) / TICK_RATE;
      // sprint if we would otherwise be late to our own ball
      if (dLand / myV > ballT * 0.85 || dLand > TUNE.catchR * 2) inp.sprint = true;
    }
    return inp;
  }
  mem.otDecided = false; mem.otPressed = false;

  // give-and-go run: just passed → sprint into space ahead
  if (mem.runFwdUntil && s.tick < mem.runFwdUntil) {
    const weOwnGG = b.owner >= 0 && s.players[b.owner].team === team;
    if (weOwnGG || b.flight) {
      const tx = clamp(p.x + 8 * d, -(TUNE.pitchW / 2 - 3), TUNE.pitchW / 2 - 3);
      const ty = clamp(p.y * 1.25 + Math.sign(p.y || 1) * 2, -(TUNE.pitchH / 2 - 3), TUNE.pitchH / 2 - 3);
      const [nx, ny] = norm(tx - p.x, ty - p.y);
      inp.mx = nx; inp.my = ny; inp.sprint = true;
      return inp;
    }
    mem.runFwdUntil = 0;
  }

  if (mem.decT <= 0) {
    mem.decT = prof.interval + Math.floor(rnd(s) * prof.interval * 0.5);
    mem.spot = null;
  }

  const weOwn = b.owner >= 0 && s.players[b.owner].team === team;
  if (role === 'chase' && !weOwn) {
    // pursue carrier / loose ball with prediction noise
    let tx, ty, carrier = null;
    if (b.owner >= 0) { carrier = s.players[b.owner]; const lead = clamp(len(carrier.x - p.x, carrier.y - p.y) * 0.12, 0, 1.2); tx = carrier.x + carrier.vx * lead; ty = carrier.y + carrier.vy * lead; }
    else { tx = b.x + b.vx * 0.15; ty = b.y + b.vy * 0.15; }
    tx += gauss(s) * prof.sigma * 3; ty += gauss(s) * prof.sigma * 3;
    const [nx, ny] = norm(tx - p.x, ty - p.y);
    const ddc = carrier ? len(carrier.x - p.x, carrier.y - p.y) : 99;
    // Jockey, then dive in. Containing at the stand-off gives the carrier room to
    // play, but pure containment is toothless: the stand-off (2.1) is bigger than
    // tackle reach (~0.9), so a permanently-containing chaser never challenges at
    // all and scoring doubled. So it periodically COMMITS — jockey, jockey, lunge.
    if (mem.commitT > 0) mem.commitT--;
    if (ddc <= prof.standoff + 1.4 && mem.commitT <= 0 && rnd(s) < prof.commitP) {
      mem.commitT = 32;
    }
    const so = mem.commitT > 0 ? 0 : prof.standoff;
    inp.mx = nx; inp.my = ny; inp.sprint = ddc > so + 1.4;
    if (ddc < so + 1.4 && ddc > so) { inp.mx = nx * 0.5; inp.my = ny * 0.5; }
    else if (ddc <= so) { inp.mx = nx * 0.14; inp.my = ny * 0.14; }   // hold the line
    if (carrier) {
      const dd = ddc;
      const tackleReach = TUNE.tackleBaseR + p.stats.tkl * TUNE.tackleRangePerStat + 0.9;
      const facingThem = (nx * p.fx + ny * p.fy) > 0.3;
      const nearWall = Math.abs(carrier.y) > TUNE.pitchH / 2 - 3.5 || Math.abs(carrier.x) > TUNE.pitchW / 2 - 4;
      if (dd < tackleReach && facingThem && carrier.st !== 'deke' && p.cdSlide <= 0 && rnd(s) < prof.tackleP * 0.16) inp.bHeld = true;   // slide
      else if (dd < 1.7 && p.cdBigHit <= 0 && rnd(s) < prof.hitP * (nearWall ? 0.25 : 0.10)) inp.yHeld = true;     // big hit (carrier = cheap)
      // punish chargers
      if (carrier.charging && dd < 2.4 && p.cdBigHit <= 0 && rnd(s) < prof.aggr * 0.4) inp.yHeld = true;
    }
    return inp;
  }
  if (role === 'carry') { /* shouldn't happen (handled above) */ }
  if (role === 'support1' || role === 'support2') {
    if (!mem.spot) mem.spot = supportSpot(s, p, brain, role === 'support1' ? 1 : 2);
    const [tx, ty] = mem.spot;
    const dd = len(tx - p.x, ty - p.y);
    const [nx, ny] = norm(tx - p.x, ty - p.y);
    if (dd > 0.8) { inp.mx = nx; inp.my = ny; inp.sprint = dd > 2.5; }   // hustle into space
    return inp;
  }
  if (role === 'mark') {
    const t = s.players[brain.markTarget >= 0 ? brain.markTarget : (1 - team) * 5];
    const tx = t.x - d * 2.6, ty = t.y + (0 - t.y) * 0.1;
    const [nx, ny] = norm(tx - p.x, ty - p.y);
    if (len(tx - p.x, ty - p.y) > 1.2) { inp.mx = nx; inp.my = ny; inp.sprint = true; }
    return inp;
  }
  if (role === 'cover') {
    const [bx, by] = ballPos(s);
    const tx = clamp(bx - d * 8, -(TUNE.pitchW / 2 - 4), TUNE.pitchW / 2 - 4), ty = by * 0.5;
    const [nx, ny] = norm(tx - p.x, ty - p.y);
    if (len(tx - p.x, ty - p.y) > 0.8) { inp.mx = nx; inp.my = ny; inp.sprint = len(tx - p.x, ty - p.y) > 5; }
    return inp;
  }
  // safety: hold a deep line between ball and own goal
  {
    const [bx, by] = ballPos(s);
    const ownGoalX = -d * TUNE.pitchW / 2;
    const tx = clamp((bx + ownGoalX) / 2 + d * 2, Math.min(-d * 4, d * 18), Math.max(-d * 18, d * 4));
    const ty = by * 0.25 - Math.sign(by || 1) * 2.5;
    const [nx, ny] = norm(tx - p.x, ty - p.y);
    if (len(tx - p.x, ty - p.y) > 0.8) { inp.mx = nx; inp.my = ny; }
    return inp;
  }
}

function decideWithBall(s, p, prof, brain, mem) {
  const team = p.team, d = team === 0 ? 1 : -1, gx = d * TUNE.pitchW / 2;
  const goalD = len(gx - p.x, p.y);
  let pressD = 99;
  for (const o of s.players) { if (o.team !== team && !o.keeper) pressD = Math.min(pressD, len(o.x - p.x, o.y - p.y)); }
  const justGot = (s.tick - (mem.gotBallAt || 0)) < 22;   // carry a beat before recycling

  const opts = [];
  // shoot
  if (goalD < 19.5) {
    const central = 1 - Math.abs(p.y) / (TUNE.pitchH / 2) * 0.55;
    let sc = (2.0 - goalD / 9.5) * central + p.stats.sho * 0.025;
    if (pressD < 1.8) sc -= 0.3;
    if (goalD < 10) sc += 0.35;
    if (justGot && goalD < 13 && pressD > 2.2) sc += 0.5;      // catch-and-shoot
    const stage = pressD > 5 ? 3 : pressD > 3 ? 2 : pressD > 1.8 ? 1 : 0;
    if (stage >= 2 && goalD > 9) sc += 0.45;                    // open space → rip a charged one
    const keeper = s.players[(1 - team) * 5 + 4];
    const keeperOff = Math.abs(keeper.x - gx) > 3.5;
    opts.push({ type: 'shoot', stage, chip: keeperOff && goalD > 8 && goalD < 16, aimY: (rnd(s) - 0.5) * 3.2, score: sc });
  }
  // passes
  for (const q of s.players) {
    if (q.team !== team || q.keeper || q.i === p.i) continue;
    if (q.st === 'down' || q.st === 'zap') continue;
    const dd = len(q.x - p.x, q.y - p.y);
    if (dd < 2.5 || dd > 19) continue;
    // lane check
    let blocked = false, blockN = 0;
    const [lx, ly] = norm(q.x - p.x, q.y - p.y);
    for (const o of s.players) {
      if (o.team === team || o.keeper) continue;
      const px = o.x - p.x, py = o.y - p.y;
      const along = px * lx + py * ly;
      if (along < 0.5 || along > dd) continue;
      const perp = Math.abs(px * ly - py * lx);
      if (perp < 1.2) { blocked = true; blockN++; }
    }
    let qOpen = 99;
    for (const o of s.players) if (o.team !== team && !o.keeper) qOpen = Math.min(qOpen, len(o.x - q.x, o.y - q.y));
    const fwd = (q.x - p.x) * d;
    let sc = 0.30 + fwd * 0.04 + Math.min(qOpen, 6) * 0.08 - (blocked ? 0.5 : 0);
    const qGoalD = len(gx - q.x, q.y);
    if (qGoalD < 14 && qOpen > 2.5) sc += 0.6;          // one-timer service bonus
    if (pressD < 2.0) sc += 0.5;                        // under pressure: move it
    if (pressD < 2.2 && fwd < 0 && qOpen > 3.5) sc += 0.4;   // back-pass to reset beats dying on the ball
    if (justGot && pressD > 2.0) sc -= 0.55;            // don't hot-potato
    opts.push({ type: 'pass', tgt: q.i, lob: blocked && blockN < 3, score: sc });
  }
  // clear it: swarmed deep in our own third → boot it long to the most advanced mate
  if (pressD < 1.7 && p.x * d < -3) {
    let fwdMate = -1, fwdX = -99;
    for (const q of s.players) {
      if (q.team !== team || q.keeper || q.i === p.i || q.st === 'down' || q.st === 'zap') continue;
      if (q.x * d > fwdX) { fwdX = q.x * d; fwdMate = q.i; }
    }
    if (fwdMate >= 0) opts.push({ type: 'pass', tgt: fwdMate, lob: true, score: 1.0 + (1.7 - pressD) * 0.5 });
  }

  // dribble: reward open grass ahead, taper off deep in attacking third
  let aheadOpen = 99;
  for (const o of s.players) {
    if (o.team === team || o.keeper) continue;
    const fx2 = (o.x - p.x) * d;
    if (fx2 > 0 && fx2 < 8 && Math.abs(o.y - p.y) < 4) aheadOpen = Math.min(aheadOpen, fx2);
  }
  opts.push({ type: 'dribble', score: 0.72 + (aheadOpen > 5 ? 0.4 : 0) + (pressD > 3.5 ? 0.15 : 0) - Math.max(0, (12 - goalD)) * 0.05 });

  // softmax-ish pick with temperature
  let pick = opts[0];
  if (prof.temp <= 0.2) {
    for (const o of opts) if (o.score > pick.score) pick = o;
  } else {
    let tot = 0; const ws = opts.map(o => { const w = Math.exp(o.score / prof.temp); tot += w; return w; });
    let r = rnd(s) * tot;
    for (let i2 = 0; i2 < opts.length; i2++) { r -= ws[i2]; if (r <= 0) { pick = opts[i2]; break; } }
  }
  return pick;
}
