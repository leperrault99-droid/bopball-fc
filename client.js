// ============================================================================
// BOPBALL FC — client: Three.js renderer, playful bean style, menus, input,
// local (1P vs AI) game loop, and online (WebSocket) play.
// ============================================================================
import * as THREE from './mini3d.js';
import { TUNE, DT, TICK_RATE, ARCHETYPES, STAT_KEYS, TRAIT_POINTS, statsFrom, makeMatch, step, livePassThreat, moveStep, cloneState, decodeInput, matchHash, restoreState, practiceSetup, practiceResetBall, practiceResetPlayers } from './sim.js';
import { DIFFICULTY, makeBrain, aiInputs, effectiveProfile } from './ai.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------ palette -------
const TEAM_COLORS = [
  { name: 'Bubblegum', hex: 0xff7eb0, css: '#ff7eb0' },
  { name: 'Sky',       hex: 0x6ec6ff, css: '#6ec6ff' },
  { name: 'Lemon',     hex: 0xffd93b, css: '#ffd93b' },
  { name: 'Grape',     hex: 0x9b8cff, css: '#9b8cff' },
  { name: 'Mint',      hex: 0x7be3a8, css: '#7be3a8' },
  { name: 'Tangerine', hex: 0xff9d5c, css: '#ff9d5c' },
];
const OPP_NAMES = ['WOBBLE ROVERS', 'JELLY CITY', 'GLOOP ATHLETIC', 'BONK BONK FC', 'SQUISH UNITED', 'THE NAPPERS'];

// ============================================================================
// AUDIO (tiny synth — no assets)
// ============================================================================
const Vol = {
  master: 1, crowd: 0.6, crowdLast: 0,
  load() {
    try {
      const j = JSON.parse(localStorage.getItem('bopball.vol') || '{}');
      if (typeof j.master === 'number') this.master = Math.max(0, Math.min(1, j.master));
      if (typeof j.crowd === 'number') this.crowd = Math.max(0, Math.min(1, j.crowd));
    } catch {}
  },
  save() {
    try { localStorage.setItem('bopball.vol', JSON.stringify({ master: this.master, crowd: this.crowd })); } catch {}
  },
};
Vol.load();

const Audio2 = (() => {
  let ctx = null, crowdGain = null, master = null;
  function ensure() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.5 * Vol.master; master.connect(ctx.destination);
      // Crowd bed: a steady murmur. It used to be 2s of noise amplitude-swept by
      // sin(i/8000) — a ~1s swell that read as ocean surf on loop. Now it's a long
      // loop of low-passed noise with no swell at all.
      const len = ctx.sampleRate * 6, buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.045;     // brown-ish: murmur, not hiss
        d[i] = lp * 0.8;
      }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 0.3;
      crowdGain = ctx.createGain(); crowdGain.gain.value = 0.0;
      src.connect(bp); bp.connect(crowdGain); crowdGain.connect(master); src.start();
      return true;
    } catch (e) { return false; }
  }
  function blip(freq, dur = 0.1, type = 'sine', vol = 0.25, slide = 0) {
    if (!ensure()) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur + 0.02);
  }
  function thud(vol = 0.5) { blip(90, 0.16, 'sine', vol, -50); noise(0.08, vol * 0.5, 900); }
  function noise(dur = 0.1, vol = 0.2, freq = 2000) {
    if (!ensure()) return;
    const len = ctx.sampleRate * dur, buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(master); src.start();
  }
  function arp(freqs, step2 = 0.07, type = 'square', vol = 0.15) {
    if (!ensure()) return;
    freqs.forEach((f, i) => setTimeout(() => blip(f, 0.12, type, vol), i * step2 * 1000));
  }
  // Net swish: filtered noise with the band sweeping down fast — the sound of
  // cord rushing past the ball rather than a generic hit.
  function swish() {
    if (!ensure()) return;
    const dur = 0.34;
    const len2 = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len2; i++) {
      const k = i / len2;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 1.7);   // sharp attack, quick tail
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(5200, ctx.currentTime);
    bp.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(bp); bp.connect(g); g.connect(master); src.start();
  }
  function crowd(v) {
    Vol.crowdLast = v;
    if (ensure() && crowdGain) crowdGain.gain.linearRampToValueAtTime(v * Vol.crowd * 0.5, ctx.currentTime + 0.5);
  }
  function applyVolume() {
    if (!ctx) return;
    if (master) master.gain.value = 0.5 * Vol.master;
    if (crowdGain) crowdGain.gain.linearRampToValueAtTime(Vol.crowdLast * Vol.crowd * 0.5, ctx.currentTime + 0.2);
  }
  return { ensure, blip, thud, noise, arp, crowd, swish, applyVolume };
})();

function sfx(ev) {
  switch (ev.t) {
    case 'WHISTLE': Audio2.blip(1750, 0.28, 'square', 0.14); setTimeout(() => Audio2.blip(1750, 0.14, 'square', 0.12), 320); break;
    case 'PASS': Audio2.blip(500, 0.05, 'triangle', 0.12); break;
    case 'SHOT': {
      const st3 = ev.stage || 0;
      Audio2.thud(0.35 + st3 * 0.15);
      if (st3 >= 2) Audio2.noise(0.18, 0.22, 3500);
      if (st3 >= 3) { Audio2.blip(70, 0.3, 'sine', 0.4, -35); Audio2.blip(900, 0.22, 'sawtooth', 0.12, -700); }
      break;
    }
    case 'GOAL':
      Audio2.swish();                                   // the net first, then the crowd
      setTimeout(() => Audio2.arp([523, 659, 784, 1047], 0.09, 'square', 0.2), 60);
      Audio2.crowd(0.30); setTimeout(() => Audio2.crowd(0.10), 2500); break;
    case 'WOODWORK':
      // a hard, woody knock — bar rings higher than the post
      Audio2.blip(ev.part === 'bar' ? 320 : 210, 0.16, 'triangle', 0.34, -110);
      Audio2.noise(0.05, 0.22, 2600);
      break;
    case 'SAVE_CATCH': Audio2.blip(330, 0.1, 'triangle', 0.2); break;
    case 'SAVE_PARRY': Audio2.blip(220, 0.14, 'sawtooth', 0.2, 120); break;
    case 'BIG_HIT': Audio2.thud(0.65); break;
    // The wind-up needs a sound of its own — this is the cue you dodge on, and
    // half the time the keeper is off the side of your screen when it starts.
    case 'KEEPER_CHECK_START': Audio2.blip(150, 0.20, 'sawtooth', 0.20, 90); break;
    case 'KEEPER_CHECK': Audio2.thud(0.85); Audio2.noise(0.12, 0.24, 1800); break;
    case 'KEEPER_CHECK_WHIFF': Audio2.noise(0.16, 0.14, 900); break;
    case 'ZAP': Audio2.blip(140, 0.3, 'sawtooth', 0.3, 500); Audio2.noise(0.2, 0.2, 4000); break;
    case 'DEKE': Audio2.noise(0.07, 0.12, 3000); break;
    case 'PERFECT_PASS': Audio2.arp([880, 1320], 0.06, 'sine', 0.16); break;
    case 'ONE_TIMER': Audio2.noise(0.1, 0.2, 2500); Audio2.thud(0.5); break;
    case 'VOLLEY': Audio2.thud(0.75); Audio2.blip(520, 0.1, 'square', 0.16, -240); break;
    case 'LEAP': Audio2.noise(0.05, 0.07, 2200); break;
    case 'BLOCK': Audio2.thud(0.45); break;
    case 'SHOT_FLATTEN': Audio2.thud(0.85); Audio2.noise(0.09, 0.2, 1400); break;
    case 'TRAP': Audio2.blip(240, 0.07, 'sine', 0.13, -60); break;
    case 'PERFECT_OT': Audio2.arp([660, 990, 1320], 0.05, 'sine', 0.2); break;
    case 'KEEPER_STUN': Audio2.arp([700, 560, 440, 350], 0.08, 'triangle', 0.18); break;
    case 'STEAL': case 'TACKLE_FOULISH': Audio2.noise(0.08, 0.18, 1200); break;
    case 'OVERTIME': Audio2.arp([392, 494, 587], 0.12, 'square', 0.2); break;
    case 'FULLTIME': Audio2.blip(1750, 0.5, 'square', 0.16); setTimeout(() => Audio2.blip(1600, 0.7, 'square', 0.16), 500); break;
    case 'KEEPER_PUNT': Audio2.thud(0.35); break;
    case 'KEEPER_DIVE': Audio2.noise(0.14, 0.16, 1600); break;
    case 'CHARGE_CANCEL': Audio2.blip(300, 0.06, 'triangle', 0.1, -120); break;
    case 'KEEPER_BUMP': Audio2.thud(0.5); Audio2.noise(0.06, 0.14, 800); break;
  }
}

// ============================================================================
// RENDERER
// ============================================================================
let renderer, scene, camera, pitchGroup, beans = [], ballMesh, ballShadow, controlRing, chargeRing, reticle, trail = [], trailBuf = [], recvArrow, ghosts = [];
let particles, crowdMesh, crowdPhases, railMats = [];
let shake = 0, camX = 0, camZoom = 0, camPunch = 0, camLook = new THREE.Vector3();
let cele = null;    // {slot, t, dur, hex} — goal celebration camera push-in

// ---- instant replay -------------------------------------------------------
// A rolling buffer of recent frames. On a goal we play the last few seconds back
// through a couple of cut camera angles before the kickoff.
// 3.2s of footage at 0.65x = ~4.9s on screen. goalCeleT must stay comfortably
// longer than this so the replay always finishes before the restart.
const REPLAY_SECONDS = 3.2, REPLAY_RATE = 0.65;
let replayBuf = [], replay = null;
// Online events arrive on the wire clock but must be spent on the render clock,
// which trails it. One value so the two can never drift apart again.
//
// This used to be a flat 80ms sized for the worst connection anyone might have,
// which meant a player on a clean link paid 80ms of lag for jitter they did not
// have. Now it tracks measured arrival jitter. It only ever eases (NET_INTERP_EASE
// ms per frame) — jumping it would shift the render clock and time-warp everyone
// on screen — and it climbs to a spike far faster than it relaxes back down,
// because arriving late costs a visible stutter and being early costs nothing.
// Floor is 80ms on purpose: that is the fixed value this ran on before today,
// and it is the last configuration with no jitter and no teleporting. Dropping
// the floor to 42 to save latency let the render clock run off the end of the
// buffer on a real connection, which reads as missed frames and beans jumping.
// Adaptivity is still there for BAD links — it can grow — it just cannot go
// below the value that was known to work.
// Every ms here is a ms of the pitch where opponents are drawn behind where they
// really are — at running speed 80ms is nearly a metre, which is why beating a
// defender on screen and being tripped anyway felt wrong. It was raised to 80 to
// chase teleporting that turned out to be the animation-rate bug and the control
// handover instead. With 60Hz snapshots the gap between samples halves, so the
// floor can come down: measured jitter on a real tunnel is ~5.5ms.
const NET_INTERP_MIN = 40, NET_INTERP_MAX = 160, NET_INTERP_EASE = 0.8;   // ms per snapshot
let NET_INTERP_MS = 80, netInterpTarget = 80;
let pendingEv = [];
// ---- net telemetry ---------------------------------------------------------
// Every netcode symptom reports as "it felt bad", which is unfalsifiable. These
// are the numbers that make it arguable.
const NS = {
  rtt: 0, rttMin: 999, jitter: 0, gapAvg: 33.3, age: 0, kbs: 0, hashOk: 0, desync: 0, resyncs: 0, hashOk: 0, desync: 0, resyncs: 0,
  bytes: 0, bytesT: 0, snaps: 0, snapRate: 0, lastArr: 0, stalls: 0,
};
if (typeof window !== 'undefined') window.__ns = NS;   // headless verification hook
function netStatSnap(bytes) {
  const now = performance.now();
  NS.bytes += bytes; NS.snaps++;
  if (NS.lastArr) {
    const gap = now - NS.lastArr;
    // Deviation from the running mean gap, not from a nominal 33.3 — a server
    // running slightly off-rate is steady, and steady is what we care about.
    NS.jitter += (Math.abs(gap - NS.gapAvg) - NS.jitter) * 0.12;
    NS.gapAvg += (gap - NS.gapAvg) * 0.06;
    if (gap > 250) NS.stalls++;
  }
  NS.lastArr = now;
  // Buffer has to cover one whole inter-arrival gap plus room for the jitter on
  // top, or the render clock walks off the end of the buffer and everything
  // freezes for a frame.
  netInterpTarget = clamp(NS.gapAvg + NS.jitter * 2.5 + 12, NET_INTERP_MIN, NET_INTERP_MAX);
  // Ease on the SNAPSHOT clock, not the frame clock. Per-frame easing would have
  // adapted four times faster on a 144Hz monitor than a 36fps one, which makes
  // the buffer a function of the player's GPU. Up fast, down slow: arriving late
  // costs a visible stutter, carrying a few spare ms costs nothing.
  const d = netInterpTarget - NET_INTERP_MS;
  NET_INTERP_MS += clamp(d, -NET_INTERP_EASE, NET_INTERP_EASE * 4);
  NS.target = netInterpTarget; NS.cur = NET_INTERP_MS;
}
function netStatTick(dtReal) {
  NS.bytesT += dtReal;
  if (NS.bytesT >= 1) {
    NS.kbs = NS.bytes / 1024 / NS.bytesT; NS.snapRate = NS.snaps / NS.bytesT;
    NS.bytes = 0; NS.snaps = 0; NS.bytesT = 0;
  }
}
// Colour by whether the number is actually a problem, not by taste: green fine,
// yellow worth watching, pink is what you are feeling.
function netGraphDraw() {
  const el = $('netgraph');
  if (!App.netGraph || App.mode !== 'online') { if (el.style.display !== 'none') el.style.display = 'none'; return; }
  el.style.display = 'block';
  const tag = (v, warn, bad, txt) => `<${v >= bad ? 'u' : v >= warn ? 'i' : 'b'}>${txt}</${v >= bad ? 'u' : v >= warn ? 'i' : 'b'}>`;
  const budget = NS.rtt / 2 + NET_INTERP_MS + 1000 / Math.max(NS.snapRate, 1) / 2;
  el.innerHTML = [
    `rtt    ${tag(NS.rtt, 90, 160, NS.rtt.toFixed(0) + 'ms')}  (min ${NS.rttMin === 999 ? '--' : NS.rttMin.toFixed(0)})`,
    `jitter ${tag(NS.jitter, 8, 18, NS.jitter.toFixed(1) + 'ms')}`,
    `buffer ${tag(NET_INTERP_MS, 90, 120, NET_INTERP_MS.toFixed(0) + 'ms')}  -> ${netInterpTarget.toFixed(0)}`,
    `age    ${tag(-NS.age, 0, 12, NS.age.toFixed(0) + 'ms')}`,
    `snaps  ${NS.snapRate.toFixed(0)}/s  ${NS.kbs.toFixed(1)}KB/s`,
    `stalls ${tag(NS.stalls, 1, 3, String(NS.stalls))}`,
    `perr   ${App.predict === false ? 'off' : tag(NS.perr || 0, 0.35, 0.9, (NS.perr || 0).toFixed(2) + 'u')}`,
    App.net && App.net.rb
      ? `sync   ${tag(NS.desync, 1, 3, NS.desync + ' bad')} / ${NS.hashOk} ok  resync ${NS.resyncs}`
      : 'sync   (rollback off)',
    App.net && App.net.rb
      ? `offset ${tag(NS.offset || 0, 70, 100, (NS.offset || 0).toFixed(0) + 'ms')}  lead ${NS.lead || 0}t`
      : '',
    `-- felt lag ${tag(budget, 110, 170, budget.toFixed(0) + 'ms')}`,
  ].join('\n');
}
function flushPendingEv() {
  if (!pendingEv.length) return;
  const now = performance.now();
  while (pendingEv.length && pendingEv[0].at <= now) handleEvents(pendingEv.shift().ev, null);
}

function recordReplay(v, tSec) {
  if (!v || !v.players) return;
  replayBuf.push({
    t: tSec,
    ball: { x: v.ball.x, y: v.ball.y, z: v.ball.z, owner: v.ball.owner, shot: v.ball.shot, passTgt: -1 },
    players: v.players.map(p => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, fx: p.fx, fy: p.fy, st: p.st, stT: p.stT })),
  });
  while (replayBuf.length && tSec - replayBuf[0].t > REPLAY_SECONDS + 0.5) replayBuf.shift();
}

function startReplay(scorer, gx, tSec) {
  const frames = replayBuf.filter(f => tSec - f.t <= REPLAY_SECONDS);
  if (frames.length < 20) return false;            // not enough footage yet
  replay = { frames, t0: frames[0].t, span: frames[frames.length - 1].t - frames[0].t, e: 0, scorer, gx };
  $('replaytag').style.display = 'block';
  return true;
}
function endReplay() { replay = null; $('replaytag').style.display = 'none'; }

// Tear the whole goal presentation down at once and hand the camera back to play.
let presentSawCele = false, presentT = 0, camBlend = 0, camBlendFrom = null;
const PRESENT_MAX = 9;              // hard ceiling; the orbit's own deadline is ~7.7s
function endPresentation() {
  if (replay || cele) {
    camBlendFrom = [camera.position.x, camera.position.y, camera.position.z,
      camLook.x, camLook.y, camLook.z];
    camBlend = CAM_BLEND_T;
  }
  endReplay(); cele = null; presentSawCele = false; presentT = 0;
}
const CAM_BLEND_T = 0.42;

// Build a renderable view from the replay buffer at the current playback time.
function replayView(dtReal, liveView) {
  replay.e += dtReal * REPLAY_RATE;
  if (replay.e >= replay.span) { endReplay(); return null; }
  const want = replay.t0 + replay.e, fr = replay.frames;
  let i = 0;
  while (i < fr.length - 2 && fr[i + 1].t <= want) i++;
  const a = fr[i], b = fr[Math.min(i + 1, fr.length - 1)];
  const f = clamp((want - a.t) / Math.max(b.t - a.t, 1e-4), 0, 1);
  const players = a.players.map((pa, j) => {
    const pb = b.players[j] || pa;
    return {
      i: j, x: lerp(pa.x, pb.x, f), y: lerp(pa.y, pb.y, f),
      vx: pb.vx, vy: pb.vy, fx: lerp(pa.fx, pb.fx, f), fy: lerp(pa.fy, pb.fy, f),
      st: pb.st, stT: pb.stT, charging: false, chargeT: 0, buff: false, bhCharge: 0, passCharge: 0, cele: 0,
    };
  });
  return {
    players,
    ball: { x: lerp(a.ball.x, b.ball.x, f), y: lerp(a.ball.y, b.ball.y, f), z: lerp(a.ball.z, b.ball.z, f),
      owner: b.ball.owner, shot: b.ball.shot, passTgt: -1 },
    score: liveView ? liveView.score : [0, 0],
    clock: liveView ? liveView.clock : 0,
    overtime: liveView ? liveView.overtime : false,
    phase: 'play', phaseT: 0, ctlSlot: -1, isReplay: true,
  };
}

// Two cuts: in behind the goal for the finish, then a low side-on tracking shot.
function replayCamera(v) {
  const prog = replay.e / Math.max(replay.span, 0.01);
  const b = v.ball, dir = Math.sign(replay.gx) || 1;
  // Keep the camera INSIDE the arena — put it outside and it just films the back
  // of the perimeter wall.
  const HW = TUNE.pitchW / 2 - 2, HH = TUNE.pitchH / 2 - 2;
  const cl = (val, m) => clamp(val, -m, m);
  const look = [b.x, Math.max(b.z, 0.8), b.y];
  if (prog < 0.55) {
    // from the goal mouth, looking back out at the play
    const swing = (prog / 0.55) * 5 - 2.5;
    return { pos: [cl(replay.gx - dir * 1.6, HW), 2.9, cl(b.y * 0.35 + swing, HH)], look };
  }
  // low and side-on, tracking the ball
  const side = b.y >= 0 ? -1 : 1;
  return { pos: [cl(b.x - dir * 4, HW), 2.5, cl(b.y + side * 10, HH)], look };
}

// ============================================================================
// WEATHER — purely cosmetic. The sim never sees it, so determinism and netcode
// sync are untouched; the host just tells everyone which preset to draw.
// ============================================================================
const WEATHER = {
  clear: {
    label: 'Clear', sky: 0xbfe7ff, fog: [58, 135],
    hemi: [0xffffff, 0xa8e6b8, 1.15], dir: [0xfff2df, 0.95, [-12, 24, 14]],
    fill: [0xbfe7ff, 0.18], grass: 0xffffff, wall: 0xfff2df, bulb: 0.0, precip: null,
  },
  golden: {
    label: 'Golden hour', sky: 0xffb877, fog: [40, 115],
    hemi: [0xffd7a8, 0xc09a6a, 1.0], dir: [0xffb066, 1.25, [-26, 9, 8]],
    fill: [0xff9a5c, 0.3], grass: 0xffd9b0, wall: 0xffe2c2, bulb: 0.25, precip: null,
  },
  overcast: {
    label: 'Overcast', sky: 0xc6ccd6, fog: [42, 110],
    hemi: [0xdfe6ee, 0x9aa9a0, 1.05], dir: [0xdfe6ee, 0.42, [-8, 26, 10]],
    fill: [0xc6ccd6, 0.25], grass: 0xd2dcd6, wall: 0xe8e6e2, bulb: 0.15, precip: null,
  },
  rain: {
    label: 'Rain', sky: 0x8e9aa8, fog: [26, 82],
    hemi: [0xd2dde8, 0x8b9892, 1.12], dir: [0xd6e2ee, 0.52, [-6, 26, 8]],
    fill: [0x9aa6b4, 0.34], grass: 0xcedbd6, wall: 0xe2e6e7, bulb: 0.35,
    precip: { kind: 'rain', n: 1100, speed: 48, size: 0.11, color: 0xeaf6ff, drift: 3.2 },
  },
  snow: {
    label: 'Snow', sky: 0xdfe9f5, fog: [24, 78],
    hemi: [0xffffff, 0xdfe9f5, 1.2], dir: [0xf2f8ff, 0.5, [-10, 24, 12]],
    fill: [0xdfe9f5, 0.3], grass: 0xeef6f7, wall: 0xffffff, bulb: 0.2,
    precip: { kind: 'snow', n: 900, speed: 5.5, size: 0.12, color: 0xffffff, drift: 1.8 },
  },
  night: {
    label: 'Night game', sky: 0x121a33, fog: [34, 100],
    hemi: [0x6b7dae, 0x263254, 0.78], dir: [0xe4eeff, 1.05, [-10, 30, 12]],
    fill: [0x3d4f80, 0.42], grass: 0xc2d2ea, wall: 0xdfe6f5, bulb: 1.0, precip: null,
  },
};
const WEATHER_KEYS = Object.keys(WEATHER);
// channel-wise multiply of two hex colours (mini3d's Color has no arithmetic)
function tintHex(a, b) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (((ar * br / 255) | 0) << 16) | (((ag * bg / 255) | 0) << 8) | ((ab * bb / 255) | 0);
}
function resolveWeather(w) {
  if (w && w !== 'random' && WEATHER[w]) return w;
  return WEATHER_KEYS[(Math.random() * WEATHER_KEYS.length) | 0];
}

let precip = null, weatherKey = 'clear';

function makePrecip(cfg) {
  const n = cfg.n;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const c = new THREE.Color(cfg.color);
  // Ceiling sits below the play camera (y~17): point size attenuates with depth
  // and the shader clamps it, so a flake beside the lens draws as a huge disc.
  const spanX = TUNE.pitchW + 40, spanZ = TUNE.pitchH + 40, top = 14;
  const state = [];
  for (let i = 0; i < n; i++) {
    const x = (Math.random() - 0.5) * spanX, z = (Math.random() - 0.5) * spanZ, y = Math.random() * top;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    state.push({ ph: Math.random() * 7 });
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: cfg.size, vertexColors: true, transparent: true,
    opacity: cfg.kind === 'rain' ? 0.55 : 0.9 });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
  return { pts, pos, state, cfg, spanX, spanZ, top, geo };
}

function updatePrecip(dtReal, t) {
  if (!precip) return;
  const { pos, state, cfg, spanX, spanZ, top, geo } = precip;
  const n = state.length, snow = cfg.kind === 'snow';
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    pos[j + 1] -= cfg.speed * dtReal;
    if (snow) {
      pos[j] += Math.sin(t * 0.8 + state[i].ph) * cfg.drift * dtReal;
      pos[j + 2] += Math.cos(t * 0.6 + state[i].ph) * cfg.drift * 0.6 * dtReal;
    } else {
      pos[j] += cfg.drift * dtReal;
    }
    if (pos[j + 1] < 0) {                     // recycle from the top
      pos[j] = (Math.random() - 0.5) * spanX;
      pos[j + 1] = top;
      pos[j + 2] = (Math.random() - 0.5) * spanZ;
    }
  }
  geo.attributes.position.needsUpdate = true;
}

function texCanvas(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
}

function makePitchTexture() {
  const M = 26; // px per metre
  const W = TUNE.pitchW * M, H = TUNE.pitchH * M;
  return texCanvas(W, H, g => {
    // mown stripes, cross-cut so the turf has some direction to it
    g.fillStyle = '#5fbf78'; g.fillRect(0, 0, W, H);
    const bands = 14, bw = W / bands;
    for (let i = 0; i < bands; i++) {
      g.fillStyle = i % 2 ? '#69c983' : '#5fbf78';
      g.fillRect(i * bw, 0, bw, H);
    }
    // faint cross-cut and a bit of wear so it isn't a flat colour
    g.globalAlpha = 0.05; g.fillStyle = '#ffffff';
    for (let i = 0; i < H; i += M * 1.6) g.fillRect(0, i, W, M * 0.8);
    g.globalAlpha = 0.045; g.fillStyle = '#2f7d4a';
    for (let i = 0; i < 900; i++) {
      const rx = Math.random() * W, ry = Math.random() * H;
      g.fillRect(rx, ry, Math.random() * 26 + 6, Math.random() * 3 + 1);
    }
    // darker apron ring at the very edge, like worn touchline turf
    g.globalAlpha = 0.10; g.fillStyle = '#2f7d4a';
    g.fillRect(0, 0, W, M * 0.9); g.fillRect(0, H - M * 0.9, W, M * 0.9);
    g.fillRect(0, 0, M * 0.9, H); g.fillRect(W - M * 0.9, 0, M * 0.9, H);
    g.globalAlpha = 1;

    // ---- markings, scaled from real football dimensions (105 x 68 m) onto this
    // pitch, so the proportions are the ones your eye already knows.
    const sx = TUNE.pitchW / 105, sy = TUNE.pitchH / 68;   // metres -> our units
    const mx = v => v * sx * M, my = v => v * sy * M;      // real metres -> pixels
    const pad = 0.55 * M;
    const PW = W - pad * 2, PH = H - pad * 2;
    const cy = H / 2;

    g.strokeStyle = '#ffffff'; g.globalAlpha = 0.94;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.lineWidth = 4.5;
    g.strokeRect(pad, pad, PW, PH);                                  // touch + goal lines
    g.beginPath(); g.moveTo(W / 2, pad); g.lineTo(W / 2, H - pad); g.stroke();   // halfway

    // centre circle 9.15 m, centre spot
    g.beginPath(); g.arc(W / 2, cy, mx(9.15), 0, 7); g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(W / 2, cy, 0.2 * M, 0, 7); g.fill();

    // The penalty area is painted from TUNE.boxW/boxH, not from real-football
    // proportions, because it is now a *mechanical* boundary: it is where the
    // keeper will body-check you. A painted line that doesn't match the rule is
    // worse than no line at all.
    const penD = TUNE.boxW * M, penW = TUNE.boxH * M;
    const sixD = mx(5.5), sixW = my(18.32);       // goal area 5.5 x 18.32
    const spotD = mx(11);                         // penalty spot 11 m out
    const arcR = mx(9.15);                        // penalty arc

    for (const right of [0, 1]) {
      const line = right ? W - pad : pad;         // the goal line on this end
      const dir = right ? -1 : 1;                 // into the pitch
      g.strokeRect(right ? line - penD : line, cy - penW / 2, penD, penW);
      g.strokeRect(right ? line - sixD : line, cy - sixW / 2, sixD, sixW);
      const spotX = line + dir * spotD;
      g.beginPath(); g.arc(spotX, cy, 0.17 * M, 0, 7); g.fill();
      // the D: only the part of the arc that sits outside the penalty area
      const boxEdge = line + dir * penD;
      const cosA = Math.min(1, Math.abs(boxEdge - spotX) / arcR);
      const a = Math.acos(cosA);
      g.beginPath();
      if (right) g.arc(spotX, cy, arcR, Math.PI - a, Math.PI + a);
      else g.arc(spotX, cy, arcR, -a, a);
      g.stroke();
    }

    // corner arcs, 1 m radius
    g.lineWidth = 4;
    const cr = mx(1);
    g.beginPath(); g.arc(pad, pad, cr, 0, Math.PI / 2); g.stroke();
    g.beginPath(); g.arc(pad, H - pad, cr, -Math.PI / 2, 0); g.stroke();
    g.beginPath(); g.arc(W - pad, pad, cr, Math.PI / 2, Math.PI); g.stroke();
    g.beginPath(); g.arc(W - pad, H - pad, cr, Math.PI, Math.PI * 1.5); g.stroke();
    g.globalAlpha = 1;
  });
}

// ---- reacting net ---------------------------------------------------------
// mini3d's PlaneGeometry is a single quad, so a net that deforms needs its own
// subdivided grid. Each panel keeps a rest pose plus a per-vertex offset that is
// kicked by the ball and springs back, so the mesh actually billows where it's hit.
const netPanels = [];

function makeNetPanel(w, h, segW, segH) {
  const pos = new Float32Array((segW + 1) * (segH + 1) * 3);
  const nrm = new Float32Array((segW + 1) * (segH + 1) * 3);
  const uv = new Float32Array((segW + 1) * (segH + 1) * 2);
  const idx = [];
  let k = 0;
  for (let y = 0; y <= segH; y++) {
    for (let x = 0; x <= segW; x++) {
      const u = x / segW, v = y / segH;
      pos[k * 3] = (u - 0.5) * w; pos[k * 3 + 1] = (0.5 - v) * h; pos[k * 3 + 2] = 0;
      nrm[k * 3] = 0; nrm[k * 3 + 1] = 0; nrm[k * 3 + 2] = 1;
      uv[k * 2] = u; uv[k * 2 + 1] = 1 - v;
      if (x < segW && y < segH) {
        const a = y * (segW + 1) + x, b2 = a + 1, c = a + segW + 1, d = c + 1;
        idx.push(a, c, b2, b2, c, d);
      }
      k++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.index = new Uint16Array(idx);
  return { geo, rest: Float32Array.from(pos), off: new Float32Array(pos.length), n: k };
}

// Kick the net at a world point. `depth` is how far the mesh is pushed along its
// own inward axis; the falloff makes a cone of displacement, not a single spike.
function netKick(worldX, worldY, worldZ, power) {
  for (const p of netPanels) {
    const { mesh, panel, axis } = p;
    const px = mesh.position.x, py = mesh.position.y, pz = mesh.position.z;
    if (Math.abs(worldX - px) > 4 || Math.abs(worldZ - py) > 4.5) continue;
    const pos = panel.geo.attributes.position.array;
    for (let i = 0; i < panel.n; i++) {
      // rest vertex -> world (panels are axis-aligned; rotation is a quarter turn)
      const rx = panel.rest[i * 3], ry = panel.rest[i * 3 + 1];
      const wx = axis === 'back' ? px : px + rx;
      const wy = py + ry;
      const wz = axis === 'back' ? pz + rx : pz;
      const d = Math.hypot(wx - worldX, wy - worldZ, wz - worldY);
      const f = Math.max(0, 1 - d / 2.4);
      if (f > 0) panel.off[i * 3 + 2] += f * f * power;
    }
    void pos;
  }
}

function updateNets(dtReal) {
  for (const p of netPanels) {
    const panel = p.panel;
    const pos = panel.geo.attributes.position.array;
    let moving = false;
    const decay = Math.exp(-6.5 * dtReal);
    for (let i = 0; i < panel.n; i++) {
      const j = i * 3 + 2;
      if (Math.abs(panel.off[j]) > 1e-4) {
        panel.off[j] *= decay;
        moving = true;
      } else panel.off[j] = 0;
      pos[j] = panel.rest[j] + panel.off[j];
    }
    if (moving || p.dirty) {
      panel.geo.attributes.position.needsUpdate = true;
      p.dirty = moving;
    }
  }
}

// Goal netting: a real box of mesh (back, two sides, roof) rather than one flat
// plane floating behind the posts.
function makeNetTexture(scale = 1) {
  return texCanvas(256, 256, g => {
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 2.2;
    const step = 16 * scale;
    for (let i = 0; i <= 256; i += step) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
    }
    // a touch of sag shading towards the bottom
    g.globalAlpha = 0.12; g.fillStyle = '#3a3153';
    g.fillRect(0, 190, 256, 66);
    g.globalAlpha = 1;
  });
}

function makeBallTexture() {
  return texCanvas(256, 128, g => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 128);
    const cols = ['#ff7eb0', '#6ec6ff', '#ffd93b', '#9b8cff'];
    for (let i = 0; i < 14; i++) {
      g.fillStyle = cols[i % 4];
      g.beginPath(); g.arc((i * 53) % 256, (i * 37) % 128, 13, 0, 7); g.fill();
    }
  });
}

const MAT = {};
function m(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!MAT[key]) MAT[key] = new THREE.MeshLambertMaterial({ color, ...opts });
  return MAT[key];
}

// Nameplate texture. `human` draws a filled pill behind the text so a player-driven
// bean is obvious at a glance; bots get plain outlined text.
function nameTagTexture(label, cssColor, human) {
  return texCanvas(256, 64, g => {
    g.clearRect(0, 0, 256, 64);
    if (human) {
      const w = Math.min(248, 30 + label.length * 20), x0 = (256 - w) / 2;
      g.fillStyle = 'rgba(30,25,45,0.62)';
      g.beginPath(); g.roundRect(x0, 8, w, 48, 24); g.fill();
      g.lineWidth = 4; g.strokeStyle = cssColor;
      g.beginPath(); g.roundRect(x0, 8, w, 48, 24); g.stroke();
    }
    g.font = `bold ${human ? 32 : 30}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (!human) {
      g.lineWidth = 8; g.strokeStyle = 'rgba(58,49,83,0.85)';
      g.strokeText(label, 128, 32);
    }
    g.fillStyle = cssColor;
    g.fillText(label, 128, 32);
  });
}

// you / team-mate / opponent — the thing that was actually missing in play
const TAG_YOU = '#ffd93b', TAG_MATE = '#57e39b', TAG_FOE = '#ff6b7d', TAG_BOT = '#ffffff';

function updateNameTags(ctlSlot) {
  const map = App.ctlMap;
  if (!beans.length || !App.rosterMeta) return;
  const myTeam = ctlSlot >= 0 ? (ctlSlot < 5 ? 0 : 1) : -1;
  for (let i = 0; i < beans.length; i++) {
    const tag = beans[i].userData && beans[i].userData.nameTag;
    if (!tag) continue;
    const meta = App.rosterMeta[i];
    const driver = map ? map[i] : (i === ctlSlot ? 'YOU' : null);
    const human = !!driver;
    let label = driver || (meta ? meta.name : '');
    let col = TAG_BOT;
    if (i === ctlSlot) { col = TAG_YOU; label = driver ? `${driver} (you)` : 'YOU'; }
    else if (human) col = (meta && meta.team === myTeam) ? TAG_MATE : TAG_FOE;
    const key = `${label}|${col}|${human ? 1 : 0}`;
    if (tag._key === key) continue;                  // only rebuild when it changes
    tag._key = key;
    tag.material.map = nameTagTexture(label, col, human);
    tag.material.needsUpdate = true;
  }
}

function makeBean(colorHex, arche, isCaptain, isKeeper, size, accentHex = 0xfff7ee, label = '') {
  const gp = new THREE.Group();
  const s = (isKeeper ? 1.18 : 1) * (0.9 + size * 0.18);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 0.52, 4, 14), m(colorHex));
  body.position.y = 0.72; body.scale.setScalar(s);
  gp.add(body);
  const inner = new THREE.Group(); body.add(inner);
  // belly
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), m(0xfff7ee));
  belly.position.set(0, -0.12, 0.26); belly.scale.set(0.9, 1.0, 0.55); inner.add(belly);
  // visor + eyes
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), m(0x2b2440));
  visor.position.set(0, 0.28, 0.28); visor.scale.set(1.15, 0.75, 0.5); inner.add(visor);
  const eyeGeo = new THREE.SphereGeometry(0.055, 8, 6);
  const eyeL = new THREE.Mesh(eyeGeo, m(0xffffff)); eyeL.position.set(-0.1, 0.3, 0.48); inner.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, m(0xffffff)); eyeR.position.set(0.1, 0.3, 0.48); inner.add(eyeR);
  // stub arms
  const armGeo = new THREE.CapsuleGeometry(0.09, 0.22, 3, 8);
  const armL = new THREE.Mesh(armGeo, m(colorHex)); armL.position.set(-0.5, -0.05, 0); armL.rotation.z = 0.5; body.add(armL);
  const armR = new THREE.Mesh(armGeo, m(colorHex)); armR.position.set(0.5, -0.05, 0); armR.rotation.z = -0.5; body.add(armR);
  // feet
  const footGeo = new THREE.SphereGeometry(0.14, 8, 6);
  const footMat = m(0x3a3153);
  const footL = new THREE.Mesh(footGeo, footMat); footL.position.set(-0.18, 0.12, 0.05); gp.add(footL);
  const footR = new THREE.Mesh(footGeo, footMat); footR.position.set(0.18, 0.12, 0.05); gp.add(footR);
  // accessories — tinted with this bean's accent so teammates aren't identical
  const acc = new THREE.Group(); body.add(acc);
  const accCol = isKeeper ? 0xfff7ee : accentHex;
  if (!isKeeper) {
    // accent sash across the belly: readable even when the hat is off-camera
    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.055, 6, 14), m(accentHex));
    sash.position.set(0, -0.02, 0.1); sash.rotation.set(1.35, 0, 0.5); acc.add(sash);
  }
  if (isKeeper) {
    const gl = new THREE.SphereGeometry(0.17, 8, 6);
    const g1 = new THREE.Mesh(gl, m(0xffd93b)); g1.position.set(-0.58, -0.1, 0.1); acc.add(g1);
    const g2 = new THREE.Mesh(gl, m(0xffd93b)); g2.position.set(0.58, -0.1, 0.1); acc.add(g2);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.16, 12), m(0x3a3153));
    cap.position.y = 0.62; acc.add(cap);
  } else if (arche === 'striker') {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 8), m(accCol));
    fin.position.set(0, 0.66, -0.05); fin.rotation.x = -0.35; acc.add(fin);
  } else if (arche === 'enforcer') {
    const pad = new THREE.SphereGeometry(0.16, 8, 6);
    const p1 = new THREE.Mesh(pad, m(0x3a3153)); p1.position.set(-0.42, 0.3, 0); acc.add(p1);
    const p2 = new THREE.Mesh(pad, m(0x3a3153)); p2.position.set(0.42, 0.3, 0); acc.add(p2);
  } else if (arche === 'playmaker') {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 8, 16), m(accCol));
    band.position.y = 0.5; band.rotation.x = Math.PI / 2.3; acc.add(band);
  } else if (arche === 'speedster') {
    const f1 = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 6), m(accCol));
    f1.position.set(-0.14, 0.55, -0.25); f1.rotation.x = 0.9; acc.add(f1);
    const f2 = f1.clone(); f2.position.x = 0.14; acc.add(f2);
  } else if (arche === 'tank') {
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), m(0x3a3153));
    helm.position.y = 0.28; acc.add(helm);
  } else { // allround
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.14, 12), m(accCol));
    cap.position.y = 0.6; acc.add(cap);
  }
  if (isCaptain) {
    const crown = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.12, 10, 1, true), m(0xffc933, { side: THREE.DoubleSide }));
    crown.add(ring);
    for (let i = 0; i < 4; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 4), m(0xffc933));
      spike.position.set(Math.cos(i * Math.PI / 2) * 0.18, 0.1, Math.sin(i * Math.PI / 2) * 0.18);
      crown.add(spike);
    }
    crown.position.y = 0.78; acc.add(crown);
  }
  // blob shadow
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55 * s, 16),
    new THREE.MeshBasicMaterial({ color: 0x2b6e46, transparent: true, opacity: 0.28 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; gp.add(shadow);
  // perfect-pass buff: a bright green ring plus a soft green shell, so a buffed
  // receiver is unmistakable from across the pitch
  const aura = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.09, 8, 22),
    new THREE.MeshBasicMaterial({ color: 0x3ce07f, transparent: true, opacity: 0 }));
  aura.rotation.x = Math.PI / 2; aura.position.y = 0.1; gp.add(aura);
  const auraGlow = new THREE.Mesh(new THREE.SphereGeometry(0.86, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0x3ce07f, transparent: true, opacity: 0 }));
  auraGlow.position.y = 0.72; gp.add(auraGlow);
  // charge glow — visible to EVERYONE (defenders read "he's at stage 3, tackle now")
  const chargeGlow = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.08, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0xffd93b, transparent: true, opacity: 0 }));
  chargeGlow.rotation.x = Math.PI / 2; chargeGlow.position.y = 0.12; gp.add(chargeGlow);
  // Floating nameplate. The text is rebuilt at runtime because control moves
  // between beans — it has to name whoever is DRIVING this one right now.
  let nameTag = null;
  if (label) {
    // depthTest stays ON: with it off, tags punched through the arena walls
    nameTag = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48),
      new THREE.MeshBasicMaterial({ map: nameTagTexture(label, '#ffffff', false), transparent: true, opacity: 0.94 }));
    nameTag.position.y = 1.85; nameTag.renderOrder = 20;
    nameTag._key = `${label}|#ffffff|0`;
    gp.add(nameTag);
  }
  gp.userData = { body, inner, armL, armR, footL, footR, shadow, aura, auraGlow, chargeGlow, baseScale: s, visor, eyeL, eyeR, nameTag };
  return gp;
}

// simple particle pool
function makeParticles(n = 600) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, opacity: 0.95 });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
  const vel = new Float32Array(n * 3), life = new Float32Array(n); let head = 0;
  function spawn(x, y, z, count, colorHex, speed = 5, up = 4, lifeS = 0.7) {
    const c = new THREE.Color(colorHex);
    for (let i = 0; i < count; i++) {
      const j = head = (head + 1) % n;
      pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2, sp = speed * (0.3 + Math.random() * 0.7);
      vel[j * 3] = Math.cos(a) * sp; vel[j * 3 + 1] = Math.random() * up; vel[j * 3 + 2] = Math.sin(a) * sp;
      col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
      life[j] = lifeS * (0.5 + Math.random() * 0.5);
    }
    geo.attributes.color.needsUpdate = true;
  }
  function update(dt) {
    for (let j = 0; j < n; j++) {
      if (life[j] <= 0) { pos[j * 3 + 1] = -99; continue; }
      life[j] -= dt;
      vel[j * 3 + 1] -= 9 * dt;
      pos[j * 3] += vel[j * 3] * dt; pos[j * 3 + 1] += vel[j * 3 + 1] * dt; pos[j * 3 + 2] += vel[j * 3 + 2] * dt;
      if (pos[j * 3 + 1] < 0.05) { pos[j * 3 + 1] = 0.05; vel[j * 3 + 1] *= -0.4; }
    }
    geo.attributes.position.needsUpdate = true;
  }
  return { pts, spawn, update };
}

function buildScene(rosterMeta) {
  const wx = WEATHER[weatherKey] || WEATHER.clear;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(wx.sky);
  scene.fog = new THREE.Fog(wx.sky, wx.fog[0], wx.fog[1]);
  camera = new THREE.PerspectiveCamera(44, innerWidth / innerHeight, 0.5, 220);
  camera.position.set(0, 18, 23);

  const hemi = new THREE.HemisphereLight(wx.hemi[0], wx.hemi[1], wx.hemi[2]); scene.add(hemi);
  const dir = new THREE.DirectionalLight(wx.dir[0], wx.dir[1]);
  dir.position.set(wx.dir[2][0], wx.dir[2][1], wx.dir[2][2]); scene.add(dir);
  // opposing fill so the shaded side of everything doesn't go flat black
  const fill = new THREE.DirectionalLight(wx.fill[0], wx.fill[1]);
  fill.position.set(14, 12, -16); scene.add(fill);

  pitchGroup = new THREE.Group(); scene.add(pitchGroup);
  netPanels.length = 0;                      // rebuilt with the scene
  const W = TUNE.pitchW, H = TUNE.pitchH;

  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
    new THREE.MeshLambertMaterial({ map: makePitchTexture(), color: wx.grass }));
  pitch.rotation.x = -Math.PI / 2; pitchGroup.add(pitch);
  // apron — tinted with the weather so it doesn't stay summer-green at night
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(W + 100, H + 90),
    new THREE.MeshLambertMaterial({ color: tintHex(0x79c98f, wx.grass) }));
  apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02; pitchGroup.add(apron);
  // end-line bleachers so the corners never show void
  for (const sx of [-1, 1]) {
    const endStand = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, H + 10), m(sx < 0 ? 0xbcd9ff : 0xffc6da));
    endStand.position.set(sx * (W / 2 + 5), 1.6, 0); endStand.rotation.z = sx * 0.1; pitchGroup.add(endStand);
  }

  // walls + glowing rails
  railMats = [];
  const wallH = 1.05, wallT = 0.5;
  const mkWall = (w, d2, x, z) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d2), m(wx.wall));
    wall.position.set(x, wallH / 2, z); pitchGroup.add(wall);
    const railMat = new THREE.MeshBasicMaterial({ color: 0xff8a70 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, 0.12, d2 + 0.05), railMat);
    rail.position.set(x, wallH + 0.06, z); pitchGroup.add(rail);
    railMats.push(railMat);
  };
  mkWall(W + 1, wallT, 0, -H / 2 - wallT / 2);
  mkWall(W + 1, wallT, 0, H / 2 + wallT / 2);
  const sideLen = (H - TUNE.goalW) / 2 - 0.2;
  for (const sx of [-1, 1]) {
    mkWall(wallT, sideLen, sx * (W / 2 + wallT / 2), -(TUNE.goalW / 2 + sideLen / 2));
    mkWall(wallT, sideLen, sx * (W / 2 + wallT / 2), (TUNE.goalW / 2 + sideLen / 2));
  }
  // corner floodlight pylons — they actually light up as the weather darkens
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, 2.1 + wx.bulb * 5.2, 10), m(0x3a3153));
    const py = (2.1 + wx.bulb * 5.2) / 2;
    post.position.set(sx * (W / 2 + 0.25), py, sz * (H / 2 + 0.25)); pitchGroup.add(post);
    const headY = 2.1 + wx.bulb * 5.2;
    if (wx.bulb > 0.05) {
      // lamp bank on top, plus a soft glow disc so it reads as emitting
      const bank = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.9),
        new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
      bank.position.set(post.position.x, headY + 0.2, post.position.z);
      bank.rotation.y = Math.atan2(-post.position.x, -post.position.z);
      pitchGroup.add(bank);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1.15, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffeeae, transparent: true, opacity: 0.16 + wx.bulb * 0.3 }));
      glow.position.copy(bank.position); pitchGroup.add(glow);
      const beam = new THREE.DirectionalLight(0xfff0c8, wx.bulb * 0.42);
      beam.position.set(post.position.x, headY, post.position.z); scene.add(beam);
    } else {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd93b }));
      bulb.position.set(post.position.x, headY + 0.2, post.position.z); pitchGroup.add(bulb);
    }
  }

  // goals — posts, bar, and a proper box of netting with real depth
  const GW = TUNE.goalW, GH = TUNE.goalH, DEPTH = 2.1;
  const netTex = makeNetTexture(1);
  const netTexSide = makeNetTexture(0.8);
  for (const sx of [-1, 1]) {
    const gx = sx * W / 2;
    const frame = m(0xffffff);
    const postGeo = new THREE.CylinderGeometry(0.15, 0.15, GH, 12);
    for (const gy of [-GW / 2, GW / 2]) {
      const p = new THREE.Mesh(postGeo, frame); p.position.set(gx, GH / 2, gy); pitchGroup.add(p);
      // rounded cap so the post doesn't end in a hard disc
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), frame);
      cap.position.set(gx, GH, gy); pitchGroup.add(cap);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, GW, 12), frame);
    bar.rotation.x = Math.PI / 2; bar.position.set(gx, GH, 0); pitchGroup.add(bar);
    // back stanchions, leaning away from the pitch
    for (const gy of [-GW / 2, GW / 2]) {
      const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, GH * 1.18, 8), frame);
      stay.position.set(gx + sx * DEPTH * 0.5, GH * 0.5, gy);
      stay.rotation.z = sx * -0.42;
      pitchGroup.add(stay);
    }
    const netMat = (tex, op) => new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false,
    });
    // back panel — subdivided so it can billow when the ball hits it
    const backPanel = makeNetPanel(GW, GH * 1.12, 14, 10);
    const back = new THREE.Mesh(backPanel.geo, netMat(netTex, 0.62));
    back.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
    back.position.set(gx + sx * DEPTH, GH * 0.52, 0);
    pitchGroup.add(back);
    netPanels.push({ mesh: back, panel: backPanel, axis: 'back', sx, dirty: false });
    // roof
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(DEPTH, GW), netMat(netTex, 0.5));
    roof.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    roof.position.set(gx + sx * DEPTH / 2, GH - 0.02, 0);
    pitchGroup.add(roof);
    // side panels
    for (const gy of [-GW / 2, GW / 2]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(DEPTH, GH), netMat(netTexSide, 0.5));
      side.rotation.y = 0;
      side.position.set(gx + sx * DEPTH / 2, GH / 2, gy);
      pitchGroup.add(side);
    }
    // goal-line shading inside the mouth, so the net reads as a volume
    const floorNet = new THREE.Mesh(new THREE.PlaneGeometry(DEPTH, GW),
      new THREE.MeshBasicMaterial({ color: 0x2f4a3c, transparent: true, opacity: 0.14 }));
    floorNet.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    floorNet.position.set(gx + sx * DEPTH / 2, 0.03, 0);
    pitchGroup.add(floorNet);
  }

  // stands + crowd
  {
    const stand = new THREE.Mesh(new THREE.BoxGeometry(W + 14, 4.6, 7), m(0xffc6da));
    stand.position.set(0, 2.0, -(H / 2 + 7)); stand.rotation.x = 0.14; pitchGroup.add(stand);
    const stand2 = new THREE.Mesh(new THREE.BoxGeometry(W + 20, 6.5, 5), m(0xbcd9ff));
    stand2.position.set(0, 2.6, -(H / 2 + 12)); stand2.rotation.x = 0.2; pitchGroup.add(stand2);
  }
  const crowdN = 220;
  crowdMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 6, 5),
    new THREE.MeshLambertMaterial(), crowdN);
  crowdPhases = [];
  const dummy = new THREE.Object3D(); const cc = new THREE.Color();
  for (let i = 0; i < crowdN; i++) {
    const x = -W / 2 - 5 + Math.random() * (W + 10);
    const z = -(H / 2 + 4.2 + Math.random() * 8);
    const y = 2.6 + (Math.abs(z) - H / 2 - 4.2) * 0.55;
    dummy.position.set(x, y, z); dummy.updateMatrix();
    crowdMesh.setMatrixAt(i, dummy.matrix);
    cc.setHex(TEAM_COLORS[i % 6].hex); crowdMesh.setColorAt(i, cc);
    crowdPhases.push({ x, y, z, ph: Math.random() * 7 });
  }
  pitchGroup.add(crowdMesh);

  // ball
  ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12),
    new THREE.MeshLambertMaterial({ map: makeBallTexture() }));
  scene.add(ballMesh);
  ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.34, 14),
    new THREE.MeshBasicMaterial({ color: 0x2b6e46, transparent: true, opacity: 0.3 }));
  ballShadow.rotation.x = -Math.PI / 2; ballShadow.position.y = 0.03; scene.add(ballShadow);

  // control ring + charge ring
  controlRing = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.07, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  controlRing.rotation.x = Math.PI / 2; controlRing.position.y = 0.08; scene.add(controlRing);
  chargeRing = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.09, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd93b, transparent: true, opacity: 0 }));
  chargeRing.rotation.x = Math.PI / 2; chargeRing.position.y = 0.1; scene.add(chargeRing);
  reticle = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0x3a3153, transparent: true, opacity: 0.75 }));
  reticle.rotation.x = Math.PI / 2; reticle.position.y = 0.06; reticle.visible = false; scene.add(reticle);
  // shot tracer: chain of fading orbs behind the ball
  trail = []; trailBuf = [];
  for (let i = 0; i < 12; i++) {
    const tm = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
    tm.visible = false; scene.add(tm); trail.push(tm);
  }
  // receiver indicator: bouncing arrow over the pass target
  recvArrow = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.6, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  recvArrow.rotation.x = Math.PI; recvArrow.visible = false; scene.add(recvArrow);
  // deke afterimage ghosts
  ghosts = [];
  for (let i = 0; i < 6; i++) {
    const g2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 0.52, 3, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
    g2.visible = false; scene.add(g2);
    ghosts.push({ mesh: g2, life: 0 });
  }

  // beans
  beans = [];
  for (const meta of rosterMeta) {
    const bean = makeBean(meta.colorHex, meta.arche, meta.isCaptain, meta.keeper, meta.size,
      meta.accentHex, meta.keeper ? '' : (meta.name || ''));
    scene.add(bean); beans.push(bean);
  }
  if (new URLSearchParams(location.search).has('probe')) {
    const probe = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 2), m(0xff0000));
    probe.position.set(15, 3, 0); scene.add(probe);
  }
  particles = makeParticles(); scene.add(particles.pts);

  precip = wx.precip ? makePrecip(wx.precip) : null;
  if (precip) scene.add(precip.pts);
}

function disposeScene() {
  if (!scene) return;
  scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  scene = null; beans = [];
}

// per-frame bean pose from a view-player
function poseBean(bean, p, t, ctlIdx) {
  const u = bean.userData;
  bean.position.set(p.x, 0, p.y);
  const targetRot = Math.atan2(p.fx, p.fy);
  // shortest-arc lerp
  let dr = targetRot - bean.rotation.y;
  while (dr > Math.PI) dr -= Math.PI * 2; while (dr < -Math.PI) dr += Math.PI * 2;
  bean.rotation.y += dr * 0.3;
  if (u.nameTag) u.nameTag.rotation.y = -bean.rotation.y;   // billboard against the fixed camera
  const speed = Math.hypot(p.vx || 0, p.vy || 0);
  // deke smoke: puffs off the trailing foot for as long as the juke carries
  if (p.st === 'deke' && particles) {
    const back = speed > 0.5 ? { x: -p.vx / speed, y: -p.vy / speed } : { x: 0, y: 0 };
    particles.spawn(p.x + back.x * 0.35, 0.22, p.y + back.y * 0.35, 2, 0xf2ecff, 1.1, 1.0, 0.42);
  }
  // big-hit wind-up: embers gathering, faster as it loads
  if (p.bhCharge > 0 && particles) {
    const f = clamp(p.bhCharge / TUNE.bhChargeMax, 0, 1);
    if ((u.bhTick = (u.bhTick || 0) + 1) % Math.max(1, Math.round(5 - f * 3)) === 0) {
      particles.spawn(p.x, 0.5, p.y, 1, f >= 1 ? 0xff3b6e : 0x9b8cff, 1.6 + f * 2, 1.8, 0.35);
    }
  }
  const bob = Math.sin(t * 14 + p.i * 2) * clamp(speed / 9, 0, 1);
  const body = u.body;
  body.position.y = 0.72 + Math.abs(bob) * 0.09;
  body.rotation.x = clamp(speed / 9, 0, 1) * 0.18;
  // leap: rising to meet a dropping ball, before you know if it's a strike or a trap
  if (p.st === 'leap') {
    const k = clamp(1 - (p.stT || 0) / TUNE.leapDur, 0, 1);
    const arc = Math.sin(k * Math.PI);
    body.position.y = 0.72 + arc * 0.95;
    body.rotation.x = -arc * 0.3;
    if (u.footL) { u.footL.position.y = 0.12 + arc * 0.85; u.footR.position.y = 0.12 + arc * 0.85; }
  } else
  // volley: up off the deck to meet the ball, twisting into the strike
  if (p.st === 'volley') {
    const k = clamp(1 - (p.stT || 0) / TUNE.volleyDur, 0, 1);   // 0 -> 1 over the strike
    const arc = Math.sin(k * Math.PI);
    body.position.y = 0.72 + arc * 1.05;
    body.rotation.x = -arc * 0.55;
    body.rotation.z = arc * 0.5;
    if (u.footL) { u.footL.position.y = 0.12 + arc * 0.9; u.footR.position.y = 0.12 + arc * 1.15; }
  } else if (u.footL && u.footL.position.y !== 0.12) {
    u.footL.position.y = 0.12; u.footR.position.y = 0.12;
  }
  // keeper dive: lay out flat in the direction of the lunge
  if (p.st === 'kdive') {
    const lean = clamp((p.vy || 0) / 8, -1, 1);
    body.rotation.z = lean * 1.25;
    body.position.y = 0.5;
    body.rotation.x = 0;
  } else if (body.rotation.z) {
    body.rotation.z *= 0.82;                    // settle back upright
  }
  body.scale.set(u.baseScale * (1 - bob * 0.03), u.baseScale * (1 + bob * 0.04), u.baseScale * (1 - bob * 0.03));
  u.footL.position.z = Math.sin(t * 14 + p.i) * 0.16 * clamp(speed / 8, 0, 1);
  u.footR.position.z = -u.footL.position.z;
  u.armL.rotation.x = Math.sin(t * 14 + p.i) * 0.7 * clamp(speed / 8, 0, 1);
  u.armR.rotation.x = -u.armL.rotation.x;
  // Full stretch. The walk cycle above runs every frame, so a diving keeper was
  // swinging his arms like he was out for a jog — the pose has to be stamped after.
  if (p.st === 'kdive') {
    const th = clamp(1 - (p.stT || 0) / TUNE.keeperDiveDur, 0, 1);
    const fling = Math.sin(clamp(th * 2.2, 0, 1) * Math.PI * 0.5);   // snaps out, holds
    u.armL.rotation.x = -2.5 * fling; u.armR.rotation.x = -2.5 * fling;
    u.armL.rotation.z = -0.55 * fling; u.armR.rotation.z = 0.55 * fling;
    u.footL.position.z = 0.1 * fling; u.footR.position.z = -0.1 * fling;
  } else if (u.armL.rotation.z) {
    u.armL.rotation.z *= 0.8; u.armR.rotation.z *= 0.8;
  }
  // states
  if (p.st === 'down' || p.st === 'zap') {
    // Tumble: roll through the first part of the knockdown, then lie flat.
    // This never actually ran until stT started reaching the client — viewFromState
    // has omitted it since the initial commit, so `(p.stT || 0) - 40` was always
    // negative and beans simply lay flat. Switching stT on for the leap/volley
    // enabled it for the first time at its untuned 0.22, which is ~5.3 radians:
    // a full barrel roll. TUMBLE keeps the original flat landing; raise it for roll.
    const TUMBLE = 0;
    const tumble = Math.max(0, (p.stT || 0) - 40) * TUMBLE;
    body.rotation.x = -Math.PI / 2 * 0.92 - tumble;
    body.position.y = 0.4 + Math.min(0.25, tumble * 0.1);
    if (p.st === 'zap') { bean.position.x += (Math.random() - 0.5) * 0.06; bean.position.z += (Math.random() - 0.5) * 0.06; }
  } else if (p.st === 'trip') { body.rotation.x = -Math.PI / 3; body.position.y = 0.5; }
  else if (p.st === 'slide') { body.rotation.x = Math.PI / 2.6; body.position.y = 0.42; }
  else if (p.st === 'bighit') { body.rotation.x = 0.45; body.scale.multiplyScalar(1.06); }
  else if (p.st === 'deke') { body.rotation.z = 0.5; }
  else if (p.st === 'kstun') { body.rotation.z = Math.sin(t * 9) * 0.35; }
  else if (p.st === 'kcheck') {
    // The body-check has to be READ, so the wind-up is the loud part of the
    // animation: the keeper rears back and swells, then snaps forward into the
    // lunge. If a player can't tell these two apart there is no skill in dodging.
    const total = TUNE.kCheckWindup + TUNE.kCheckActive + TUNE.kCheckSettle;
    const el = total - (p.stT || 0);
    if (el < TUNE.kCheckWindup) {
      const w = clamp(el / TUNE.kCheckWindup, 0, 1);
      body.rotation.x = -0.42 * w;                       // rear back
      body.scale.multiplyScalar(1 + 0.13 * w);
      body.position.y = 0.5 + 0.10 * w;
      u.armL.rotation.x = 1.1 * w; u.armR.rotation.x = 1.1 * w;
      bean.position.x += (Math.random() - 0.5) * 0.05 * w;
      bean.position.z += (Math.random() - 0.5) * 0.05 * w;
    } else {
      const a = clamp((el - TUNE.kCheckWindup) / TUNE.kCheckActive, 0, 1);
      body.rotation.x = 0.60 - a * 0.30;                 // snap forward, then settle
      body.scale.multiplyScalar(1.10 - a * 0.10);
      u.armL.rotation.x = -1.5 + a * 0.9; u.armR.rotation.x = -1.5 + a * 0.9;
      u.armL.rotation.z = -0.5; u.armR.rotation.z = 0.5;
    }
  }
  if (p.charging) { bean.position.x += (Math.random() - 0.5) * 0.04; bean.position.z += (Math.random() - 0.5) * 0.04; }
  if (p.cele === 1) { body.position.y = 0.72 + Math.abs(Math.sin(t * 6 + p.i)) * 0.55; }         // scorer team hop
  if (p.cele === -1) { body.scale.y *= 0.88; body.rotation.x = 0.3; }                             // sad beans
  u.aura.material.opacity = p.buff ? (0.7 + Math.sin(t * 10) * 0.3) : 0;
  u.aura.rotation.z = t * 2;
  if (u.auraGlow) {
    u.auraGlow.material.opacity = p.buff ? (0.16 + Math.sin(t * 7) * 0.07) : 0;
    const gs = p.buff ? 1 + Math.sin(t * 7) * 0.05 : 1;
    u.auraGlow.scale.setScalar(gs);
  }
  // charge telegraph: color climbs with stage, pulse speeds up, stage-ups ping
  if (p.charging && p.chargeT > 0) {
    const stage = p.chargeT >= TUNE.chargeStageT[2] ? 3 : p.chargeT >= TUNE.chargeStageT[1] ? 2 : p.chargeT >= TUNE.chargeStageT[0] ? 1 : 0;
    if (stage > (u.prevStage || 0)) {
      Audio2.blip(360 + stage * 260, 0.09, 'square', 0.16);
      if (particles) particles.spawn(p.x, 0.6, p.y, 5 + stage * 3, stage >= 3 ? 0xff5b7e : 0xffd93b, 2.5, 2, 0.3);
      if (stage >= 3) padRumble(0.4, 0.6, 90);
    }
    u.prevStage = stage;
    u.chargeGlow.material.color.setHex(stage >= 3 ? 0xff5b7e : stage >= 2 ? 0xff9d5c : 0xffd93b);
    u.chargeGlow.material.opacity = 0.5 + Math.sin(t * (8 + stage * 5)) * 0.25 + stage * 0.08;
    const gs = 1 + stage * 0.15 + Math.sin(t * (8 + stage * 5)) * 0.05;
    u.chargeGlow.scale.set(gs, gs, gs);
  } else { u.chargeGlow.material.opacity = 0; u.prevStage = 0; }
}

// ============================================================================
// INPUT — schemes (mouse-aim / classic buttons), rebindable, gamepad polish
// ============================================================================
const keys = {};   // raw key state (also used by test hooks)

const ACTIONS = [
  { id: 'up',     label: 'Move up',                 def: ['KeyW', 'ArrowUp'] },
  { id: 'down',   label: 'Move down',               def: ['KeyS', 'ArrowDown'] },
  { id: 'left',   label: 'Move left',               def: ['KeyA', 'ArrowLeft'] },
  { id: 'right',  label: 'Move right',              def: ['KeyD', 'ArrowRight'] },
  { id: 'sprint', label: 'Sprint',                  def: ['ShiftLeft', 'ShiftRight'], gdef: [7, 5] },
  { id: 'actA',   label: 'Pass / Switch',           def: ['KeyJ'], gdef: [0] },
  { id: 'actB',   label: 'Shoot / Slide (hold=charge)', def: ['KeyK'], gdef: [2] },
  { id: 'actY',   label: 'Deke / Big Hit',          def: ['KeyL'], gdef: [1, 3] },
  { id: 'lob',    label: 'Lob modifier',            def: ['KeyU'], gdef: [4] },
  { id: 'finesse', label: 'Finesse modifier (placed, curled)', def: ['KeyE'], gdef: [6] },
];
const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];
function keyName(code) {
  return code.replace('Key', '').replace('Arrow', '') .replace('ShiftLeft', 'Shift').replace('ShiftRight', 'RShift')
    .replace('ControlLeft', 'Ctrl').replace('Space', 'Space');
}

const Input = {
  scheme: 'mouse',                 // 'mouse' | 'buttons'
  binds: {}, gbinds: {},
  deadzone: 0.15, vibration: true,
  lastDevice: 'kb',                // 'kb' | 'pad'
  mx: innerWidth / 2, my: innerHeight / 2,
  mouseL: false, mouseR: false, mouseM: false,
  cursorSim: null,                 // {x, y} cursor projected onto the pitch
  _prevPadButtons: [],
  defaults() {
    this.binds = {}; this.gbinds = {};
    for (const a of ACTIONS) { this.binds[a.id] = [...a.def]; this.gbinds[a.id] = a.gdef ? [...a.gdef] : []; }
  },
  load() {
    this.defaults();
    try {
      const raw = localStorage.getItem('bopball.controls.v2');
      if (raw) {
        const d = JSON.parse(raw);
        if (d.binds) for (const k in d.binds) if (this.binds[k]) this.binds[k] = d.binds[k];
        if (d.gbinds) for (const k in d.gbinds) if (this.gbinds[k]) this.gbinds[k] = d.gbinds[k];
        if (d.scheme === 'mouse' || d.scheme === 'buttons') this.scheme = d.scheme;
        if (typeof d.deadzone === 'number') this.deadzone = Math.min(0.35, Math.max(0.08, d.deadzone));
        if (typeof d.vibration === 'boolean') this.vibration = d.vibration;
      }
    } catch (e) { /* storage unavailable (private mode etc) — in-memory only */ }
  },
  save() {
    try {
      localStorage.setItem('bopball.controls.v2', JSON.stringify({
        binds: this.binds, gbinds: this.gbinds, scheme: this.scheme,
        deadzone: this.deadzone, vibration: this.vibration,
      }));
    } catch (e) { /* fine */ }
  },
  key(action) { const b = this.binds[action]; for (const code of b) if (keys[code]) return true; return false; },
};
Input.defaults();

addEventListener('keydown', e => {
  keys[e.code] = true;
  Input.lastDevice = 'kb'; updateHint();
  if (e.code === 'F3') { App.netGraph = !App.netGraph; e.preventDefault(); }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousemove', e => { Input.mx = e.clientX; Input.my = e.clientY; });
addEventListener('mousedown', e => {
  Input.lastDevice = 'kb'; updateHint();
  if (e.button === 0) Input.mouseL = true;
  if (e.button === 1) { Input.mouseM = true; e.preventDefault(); }
  if (e.button === 2) Input.mouseR = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0) Input.mouseL = false;
  if (e.button === 1) Input.mouseM = false;
  if (e.button === 2) Input.mouseR = false;
});
addEventListener('contextmenu', e => { if (App.mode !== 'menu') e.preventDefault(); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; Input.mouseL = Input.mouseR = Input.mouseM = false; });

function activePad() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) if (gp && gp.connected) return gp;
  return null;
}
function padRumble(strong, weak, ms) {
  if (!Input.vibration) return;
  const gp = activePad();
  const act = gp && (gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]));
  if (!act || !act.playEffect) return;
  try { act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }); } catch (e) {}
}
function readPad() {
  const gp = activePad();
  if (!gp) return null;
  // radial deadzone with rescale
  let ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
  const mag = Math.hypot(ax, ay), dz = Input.deadzone;
  if (mag < dz) { ax = 0; ay = 0; }
  else { const k = Math.min((mag - dz) / (1 - dz), 1) / mag; ax *= k; ay *= k; }
  // d-pad fallback
  if (!ax && !ay) {
    if (gp.buttons[12]?.pressed) ay = -1; if (gp.buttons[13]?.pressed) ay = 1;
    if (gp.buttons[14]?.pressed) ax = -1; if (gp.buttons[15]?.pressed) ax = 1;
  }
  const btn = id => { for (const i of Input.gbinds[id]) if (gp.buttons[i]?.pressed) return true; return false; };
  const anyPressed = gp.buttons.some(b => b && b.pressed);
  if (anyPressed || Math.abs(ax) > 0.2 || Math.abs(ay) > 0.2) {
    if (Input.lastDevice !== 'pad') { Input.lastDevice = 'pad'; updateHint(); }
  }
  return { mx: ax, my: ay, a: btn('actA'), b: btn('actB'), y: btn('actY'), lob: btn('lob'), sprint: btn('sprint'), pad: gp };
}

// project the mouse cursor onto the pitch plane (y=0) → sim coords {x, y}
// Camera ray through the cursor, in world space.
function cursorRay() {
  if (!camera) return null;
  const ndcX = (Input.mx / innerWidth) * 2 - 1;
  const ndcY = -((Input.my / innerHeight) * 2 - 1);
  let fx = camera._target.x - camera.position.x,
      fy = camera._target.y - camera.position.y,
      fz = camera._target.z - camera.position.z;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const t = Math.tan(camera.fov * Math.PI / 360);
  return {
    ox: camera.position.x, oy: camera.position.y, oz: camera.position.z,
    dx: fx + rx * ndcX * t * camera.aspect + ux * ndcY * t,
    dy: fy + ry * ndcX * t * camera.aspect + uy * ndcY * t,
    dz: fz + rz * ndcX * t * camera.aspect + uz * ndcY * t,
  };
}

// Where the cursor is pointing ON the goal face (the vertical plane at x = gx).
// This is what makes "aim at the net" literal: {y across, z height}.
function cursorToGoalPlane(gx) {
  const r = cursorRay();
  if (!r || Math.abs(r.dx) < 1e-5) return null;
  const k = (gx - r.ox) / r.dx;
  if (k <= 0) return null;                       // goal is behind the camera ray
  return { y: r.oz + r.dz * k, z: r.oy + r.dy * k };
}

function cursorToGround() {
  if (!camera) return null;
  const ndcX = (Input.mx / innerWidth) * 2 - 1;
  const ndcY = -((Input.my / innerHeight) * 2 - 1);
  let fx = camera._target.x - camera.position.x,
      fy = camera._target.y - camera.position.y,
      fz = camera._target.z - camera.position.z;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  // right = f × up(0,1,0);  up2 = right × f
  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const t = Math.tan(camera.fov * Math.PI / 360);
  const dx = fx + rx * ndcX * t * camera.aspect + ux * ndcY * t;
  const dy = fy + ry * ndcX * t * camera.aspect + uy * ndcY * t;
  const dz2 = fz + rz * ndcX * t * camera.aspect + uz * ndcY * t;
  if (dy >= -1e-4) return null;
  const k = -camera.position.y / dy;
  return { x: camera.position.x + dx * k, y: camera.position.z + dz2 * k };
}

// meX/meY: controlled bean's position (for the mouse aim vector)
function readHumanInput(meX, meY, gx) {
  const pad = readPad();
  let mx = 0, my = 0;
  if (Input.key('up')) my -= 1;
  if (Input.key('down')) my += 1;
  if (Input.key('left')) mx -= 1;
  if (Input.key('right')) mx += 1;
  const mouseMode = Input.scheme === 'mouse' && Input.lastDevice !== 'pad';
  const inp = {
    mx, my,
    sprint: Input.key('sprint'),
    aHeld: Input.key('actA') || (mouseMode && Input.mouseL),
    bHeld: Input.key('actB') || (mouseMode && Input.mouseR),
    yHeld: Input.key('actY') || (mouseMode && !!keys.Space),
    lobHeld: Input.key('lob') || (mouseMode && (Input.mouseM || !!keys.KeyQ)),
    finesse: Input.key('finesse'),
  };
  if (!mouseMode) inp.lobHeld = inp.lobHeld || !!keys.Space;    // classic: Space also lobs
  if (pad) {
    if (pad.mx || pad.my) { inp.mx = pad.mx; inp.my = pad.my; }
    inp.aHeld = inp.aHeld || pad.a; inp.bHeld = inp.bHeld || pad.b; inp.yHeld = inp.yHeld || pad.y;
    inp.lobHeld = inp.lobHeld || pad.lob; inp.sprint = inp.sprint || pad.sprint;
  }
  const l = Math.hypot(inp.mx, inp.my); if (l > 1) { inp.mx /= l; inp.my /= l; }
  // aim channel: cursor direction from the controlled bean
  Input.cursorSim = mouseMode ? cursorToGround() : null;
  if (mouseMode && Input.cursorSim && meX !== undefined) {
    const axv = Input.cursorSim.x - meX, ayv = Input.cursorSim.y - meY;
    if (Math.hypot(axv, ayv) > 0.4) { inp.ax = axv; inp.ay = ayv; }
  }
  // Point at the net and that's where it goes: the cursor's spot on the goal face.
  // Only when you're actually pointing at the mouth, else the ground ray is used.
  Input.goalAim = null;
  if (mouseMode && gx !== undefined) {
    const gp = cursorToGoalPlane(gx);
    if (gp && Math.abs(gp.y) < TUNE.goalW / 2 + 1.2 && gp.z > -0.4 && gp.z < TUNE.goalH + 1.2) {
      inp.agy = clamp(gp.y, -TUNE.goalW / 2, TUNE.goalW / 2);
      inp.az = clamp(gp.z, 0.12, TUNE.goalH - 0.2);
      Input.goalAim = { gx, y: inp.agy, z: inp.az };
    }
  }
  return inp;
}

// context-aware control hint
function updateHint() {
  const el = document.getElementById('ctrlhint');
  if (!el) return;
  if (Input.lastDevice === 'pad') {
    const n = id => (Input.gbinds[id] || []).map(i => PAD_NAMES[i] || i).join('/') || '?';
    el.textContent = `MOVE STICK · PASS/SWITCH ${n('actA')} · SHOOT/SLIDE ${n('actB')} · DEKE/BIG HIT ${n('actY')} · LOB ${n('lob')} · SPRINT ${n('sprint')}`;
  } else if (Input.scheme === 'mouse') {
    el.textContent = 'MOVE WASD · PASS LMB (HOLD=AIM IT) · SHOOT RMB (HOLD=CHARGE) · FINESSE E (bend it) · DEKE/BIG HIT SPACE · CHIP Q/MMB · SPRINT SHIFT';
  } else {
    const n = id => (Input.binds[id] || []).map(keyName).slice(0, 1).join('') || '?';
    el.textContent = `MOVE WASD · PASS ${n('actA')} (HOLD=AIM IT) · SHOOT/SLIDE ${n('actB')} · FINESSE ${n('finesse')} · DEKE/BIG HIT ${n('actY')} · CHIP ${n('lob')} · SPRINT SHIFT`;
  }
}

// world position → screen px (for popups)
function worldToScreen(x, y3, z) {
  if (!camera) return null;
  let fx = camera._target.x - camera.position.x,
      fy = camera._target.y - camera.position.y,
      fz = camera._target.z - camera.position.z;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const dx = x - camera.position.x, dy = y3 - camera.position.y, dz = z - camera.position.z;
  const cz = -(dx * fx + dy * fy + dz * fz);
  if (cz > -0.5) return null;
  const t = Math.tan(camera.fov * Math.PI / 360);
  const cx = (dx * rx + dz * rz) / (-cz * t * camera.aspect);
  const cy = (dx * ux + dy * uy + dz * uz) / (-cz * t);
  return { x: (cx * 0.5 + 0.5) * innerWidth, y: (1 - (cy * 0.5 + 0.5)) * innerHeight };
}

// floating world-anchored popup text ("PERFECT!")
const _popups = [];
function popup(text, wx, wy, color) {
  let el = _popups.find(p => p.life <= 0);
  if (!el) {
    if (_popups.length >= 6) return;
    el = { div: document.createElement('div'), life: 0 };
    el.div.style.cssText = 'position:fixed;font-weight:900;font-size:22px;pointer-events:none;z-index:8;' +
      'text-shadow:0 2px 0 rgba(58,49,83,.3);transition:none;';
    document.body.appendChild(el.div);
    _popups.push(el);
  }
  el.life = 1; el.wx = wx; el.wy = wy; el.rise = 0;
  el.div.textContent = text;
  el.div.style.color = color || '#fff';
  el.div.style.display = 'block';
}
function updatePopups(dt) {
  for (const p of _popups) {
    if (p.life <= 0) { p.div.style.display = 'none'; continue; }
    p.life -= dt * 0.8; p.rise += dt * 40;
    const sc = worldToScreen(p.wx, 2.2, p.wy);
    if (!sc) { p.div.style.display = 'none'; continue; }
    p.div.style.display = 'block';
    p.div.style.left = (sc.x - 40) + 'px';
    p.div.style.top = (sc.y - p.rise) + 'px';
    p.div.style.opacity = Math.max(0, Math.min(1, p.life * 1.4));
  }
}

// ============================================================================
// HUD
// ============================================================================
const HUD = {
  show(v) { $('hud').classList.toggle('hidden', !v); },
  score(sc, n0, n1) { $('s0').textContent = sc[0]; $('s1').textContent = sc[1]; $('n0').textContent = n0; $('n1').textContent = n1; },
  clock(sec, ot) {
    if (App.practice) { $('clock').textContent = 'PRACTICE'; return; }
    const s2 = Math.max(0, Math.ceil(sec));
    $('clock').textContent = ot ? 'GOLDEN' : `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
  },
  big(msg, sub = '', ms = 1400) {
    const b = $('bigmsg'), s2 = $('submsg');
    b.textContent = msg; s2.textContent = sub;
    b.style.opacity = 1; s2.style.opacity = 1;
    b.style.transform = 'translate(-50%,-50%) scale(1.06)';
    clearTimeout(HUD._t);
    if (ms > 0) HUD._t = setTimeout(() => { b.style.opacity = 0; s2.style.opacity = 0; }, ms);
  },
  hideBig() { $('bigmsg').style.opacity = 0; $('submsg').style.opacity = 0; },
  charge(frac, stage) {
    const w = $('chargewrap');
    w.style.opacity = frac > 0 ? 1 : 0;
    $('chargebar').style.width = `${Math.min(frac * 100, 100)}%`;
    $('chargebar').style.background = stage >= 3 ? '#ff5b7e' : stage >= 2 ? '#ff9d5c' : '#ffd93b';
  },
  net(msg) { const n = $('netstat'); n.style.display = msg ? 'block' : 'none'; n.textContent = msg || ''; },
};
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.style.opacity = 1;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.style.opacity = 0, ms);
}

// ============================================================================
// GAME CONTROLLER (local + online share the render loop through a "view")
// ============================================================================
const App = {
  mode: 'menu',         // menu | local | online
  raf: 0, lastT: 0,
  local: null, net: null,
  rosterMeta: null, teamNames: ['HOME', 'AWAY'], ctlMap: null,
  stats: null, cup: null,
  paused: false, menuOpen: false, over: false, practice: false,
  timeScale: 1, slowmoT: 0, pauseFrames: 0,
  autotest: new URLSearchParams(location.search).has('autotest'),
};

function rosterMetaFrom(cfgTeams, colorIdx) {
  const meta = [];
  for (let team = 0; team < 2; team++) {
    const tc = cfgTeams[team];
    const colorHex = TEAM_COLORS[tc.color % 6].hex;
    for (let slot = 0; slot < 5; slot++) {
      const isK = slot === 4;
      const src = isK ? null : ((tc.lineup && tc.lineup[slot]) || (slot === 0 ? tc.captain : tc.sidekick));
      const arche = isK ? 'keeper' : (src?.arche || 'allround');
      const size = isK ? 1.1 : (ARCHETYPES[arche]?.size ?? 1);
      const accentHex = ACCENT_COLORS[((src?.accent ?? slot) | 0) % ACCENT_COLORS.length].hex;
      const name = isK ? 'KEEPER' : (src?.name || `${tc.name} ${slot + 1}`);
      meta.push({ team, slot, keeper: isK, arche, isCaptain: slot === 0, colorHex, size, accentHex, name, human: !!src?.human });
    }
  }
  return meta;
}

function startLocal(cfg) {
  // cfg: {teams, diff, timerLen, weakGoalies, momentum, seed, cupStage}
  const prof = DIFFICULTY[cfg.diff];
  const state = makeMatch({
    seed: cfg.seed ?? ((Math.random() * 1e9) | 0),
    timerLen: cfg.timerLen, teams: cfg.teams,
    weakGoalies: cfg.weakGoalies,
    keeperReflex: [prof.keeperReflex, prof.keeperReflex],
  });
  App.local = {
    state, cfg,
    brains: [makeBrain(0), makeBrain(1)],
    humanSlot: App.autotest ? -1 : (Setup.startSlot || 0),
    acc: 0, prevBallOwner: -1,
  };
  weatherKey = resolveWeather(cfg.weather);
  App.teamNames = [cfg.teams[0].name, cfg.teams[1].name];
  App.rosterMeta = rosterMetaFrom(cfg.teams);
  App.stats = { shots: [0, 0], hits: [0, 0], perfect: [0, 0], oneTimers: [0, 0], saves: [0, 0], zaps: [0, 0] };
  beginMatchUI();
  App.mode = 'local';
  App.practice = false;
  practiceHUD(false);
  if (window) window.__gs = state;
}

// ---------------------------------------------------------------- practice --
// A tuning arena: you, their keeper, and however many inert dummies you want.
// Nothing has a brain and nothing has a clock, so a rep is repeatable and the
// only thing that changes between two attempts is what you did.
const Practice = {
  mates: 0, defs: 0, ownKeeper: false,
  lastShot: null,      // {speed, charge, curve, result}
  shots: 0, goals: 0, saves: 0, wide: 0,
  passes: 0, connected: 0, lastPass: null,
  checks: 0, dodged: 0,
  log: [],             // recent lines for the overlay
};

function startPractice() {
  const t0 = playerTeamCfg();
  const opp = randomOppCfg(t0.color, 'pro');
  const state = makeMatch({
    seed: 1,                                    // fixed: same arena every time
    timerLen: 9999, teams: [t0, opp],
    keeperReflex: [DIFFICULTY.pro.keeperReflex, DIFFICULTY.pro.keeperReflex],
    practice: { mates: Practice.mates, defs: Practice.defs, ownKeeper: Practice.ownKeeper },
  });
  App.local = {
    state, cfg: { teams: [t0, opp], diff: 'pro', timerLen: 9999, momentum: false },
    brains: [makeBrain(0), makeBrain(1)],
    humanSlot: 0, acc: 0, prevBallOwner: -1,
  };
  weatherKey = resolveWeather('clear');
  App.teamNames = [t0.name, opp.name];
  App.rosterMeta = rosterMetaFrom([t0, opp]);
  App.stats = { shots: [0, 0], hits: [0, 0], perfect: [0, 0], oneTimers: [0, 0], saves: [0, 0], zaps: [0, 0] };
  Practice.shots = Practice.goals = Practice.saves = Practice.wide = 0;
  Practice.passes = Practice.connected = Practice.checks = Practice.dodged = 0;
  Practice.lastShot = null; Practice.lastPass = null; Practice.log = [];
  beginMatchUI();
  App.mode = 'local';
  App.practice = true;
  practiceHUD(true);
  practiceRefresh();
  if (window) window.__gs = state;
}

function practiceRefresh() {
  const st = App.local?.state;
  if (!st || !st.practice) return;
  practiceSetup(st, { mates: Practice.mates, defs: Practice.defs, ownKeeper: Practice.ownKeeper });
  practiceResetBall(st, 'feet');
  buildScene(App.rosterMeta);          // rebuild so parked beans aren't drawn mid-pitch
  practiceHUD();
}

function practiceLog(line) {
  Practice.log.unshift(line);
  if (Practice.log.length > 6) Practice.log.pop();
  practiceHUD();
}

function practiceHUD(show) {
  let el = document.getElementById('practicepanel');
  if (show === false) { if (el) el.style.display = 'none'; return; }
  if (!App.practice) { if (el) el.style.display = 'none'; return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'practicepanel';
    el.style.cssText = 'position:fixed;left:14px;top:96px;z-index:40;pointer-events:none;' +
      'font:700 12px/1.5 ui-monospace,Consolas,monospace;color:#fff;text-shadow:0 2px 6px #000;' +
      'background:rgba(12,10,24,.62);border:1px solid rgba(255,255,255,.14);border-radius:10px;' +
      'padding:10px 12px;min-width:214px;';
    document.body.appendChild(el);
  }
  el.style.display = 'block';
  const P = Practice;
  const acc = P.shots ? Math.round(P.goals / P.shots * 100) : 0;
  const pacc = P.passes ? Math.round(P.connected / P.passes * 100) : 0;
  const ls = P.lastShot, lp = P.lastPass;
  el.innerHTML =
    `<div style="font-weight:900;letter-spacing:1.5px;color:#ff2d9a;margin-bottom:6px;">PRACTICE ARENA</div>` +
    `<div>mates <b>${P.mates}</b>/3 &nbsp; defenders <b>${P.defs}</b>/4 &nbsp; own GK <b>${P.ownKeeper ? 'on' : 'off'}</b></div>` +
    `<div style="margin-top:5px;">shots <b>${P.shots}</b> &nbsp; goals <b style="color:#7cf">${P.goals}</b> &nbsp; saved <b>${P.saves}</b> &nbsp; wide <b>${P.wide}</b> &nbsp; <b>${acc}%</b></div>` +
    (ls ? `<div style="color:#ffd93b;">shot: ${ls.speed} u/s · charge ${ls.charge}${ls.finesse ? ' · FINESSE' : ''} · bend ${ls.curve}</div>` : '') +
    `<div style="margin-top:5px;">passes <b>${P.passes}</b> &nbsp; connected <b style="color:#7be3a8">${P.connected}</b> &nbsp; <b>${pacc}%</b></div>` +
    (lp ? `<div style="color:#7be3a8;">pass: ${lp.aimed ? `AIMED ${lp.range}m` : 'auto-target'}${lp.lob ? ' · chip' : ''} · charge ${lp.power}</div>` : '') +
    (P.checks || P.dodged ? `<div style="margin-top:5px;">keeper checks <b>${P.checks}</b> &nbsp; dodged <b style="color:#7be3a8">${P.dodged}</b></div>` : '') +
    (P.log.length ? `<div style="margin-top:6px;opacity:.72;font-size:11px;">${P.log.join('<br>')}</div>` : '') +
    `<div style="margin-top:8px;opacity:.55;font-size:10.5px;line-height:1.6;">` +
    `<b>R</b> ball to feet &nbsp; <b>T</b> loose ball<br>` +
    `<b>1/2</b> mates −/+ &nbsp; <b>3/4</b> defenders −/+<br>` +
    `<b>5</b> own keeper &nbsp; <b>G</b> reset dummies<br>` +
    `<b>0</b> clear stats &nbsp; <b>Esc</b> menu` +
    `<div style="margin-top:6px;color:#ffd93b;opacity:.9;">HOLD pass to aim it — charge<br>sets how far it goes.<br>` +
    `FINESSE = placement. Hold it to bend<br>further around the keeper.<br>` +
    `Carry into the box and he WILL hit you.</div></div>`;
}

function wirePracticeKeys() {
  addEventListener('keydown', e => {
    if (!App.practice || App.mode !== 'local' || App.paused) return;
    const st = App.local?.state; if (!st) return;
    let handled = true;
    switch (e.code) {
      case 'KeyR': practiceResetBall(st, 'feet'); practiceLog('ball → your feet'); break;
      case 'KeyT': practiceResetBall(st, 'far'); practiceLog('loose ball at halfway'); break;
      case 'KeyG': practiceResetPlayers(st); practiceLog('dummies reset'); break;
      case 'Digit1': Practice.mates = Math.max(0, Practice.mates - 1); practiceRefresh(); break;
      case 'Digit2': Practice.mates = Math.min(3, Practice.mates + 1); practiceRefresh(); break;
      case 'Digit3': Practice.defs = Math.max(0, Practice.defs - 1); practiceRefresh(); break;
      case 'Digit4': Practice.defs = Math.min(4, Practice.defs + 1); practiceRefresh(); break;
      case 'Digit5': Practice.ownKeeper = !Practice.ownKeeper; practiceRefresh(); break;
      case 'Digit0':
        Practice.shots = Practice.goals = Practice.saves = Practice.wide = 0;
        Practice.passes = Practice.connected = Practice.checks = Practice.dodged = 0;
        Practice.log = []; Practice.lastShot = null; Practice.lastPass = null;
        st.score[0] = st.score[1] = 0;
        practiceHUD(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });
}

function beginMatchUI() {
  showScreen(null);
  disposeScene();
  cele = null; endReplay(); replayBuf = []; pendingEv = []; ballSpinReset();
  presentSawCele = false; camBlend = 0; camBlendFrom = null;
  buildScene(App.rosterMeta);
  HUD.show(true);
  HUD.score([0, 0], App.teamNames[0], App.teamNames[1]);
  App.paused = false; App.menuOpen = false; App.over = false; App.timeScale = 1; App.pauseFrames = 0;
  Audio2.ensure(); Audio2.crowd(0.08);
  if (!App.raf) { App.lastT = performance.now(); App.raf = requestAnimationFrame(frame); }
}

function localHumanInputs(state) {
  const L = App.local;
  const inputs = new Array(10).fill(null);
  const humanSlots = new Set();
  if (L.humanSlot >= 0) {
    const me = state.players[L.humanSlot];
    const inp = readHumanInput(me.x, me.y, me.team === 0 ? TUNE.pitchW / 2 : -TUNE.pitchW / 2);
    inp.human = true;                     // only humans may skip a goal celebration
    // auto-follow the ball on own team; pass-button switches when defending
    const b = state.ball;
    if (state.practice) {
      // never hand control to a dummy — you stay on slot 0 the whole session
      L.humanSlot = 0;
    } else if (b.owner >= 0 && state.players[b.owner].team === 0 && !state.players[b.owner].keeper) {
      L.humanSlot = b.owner;
    } else if (inp.aHeld && !L.prevSwitchHeld && (b.owner < 0 || state.players[b.owner].team !== 0)) {
      // switch target: cursor position in mouse scheme (click near a bean), else the ball
      const tgt = (Input.scheme === 'mouse' && Input.lastDevice !== 'pad' && Input.cursorSim) ? Input.cursorSim : b;
      let best = -1, bd = 1e9;
      for (const p of state.players) {
        if (p.team !== 0 || p.keeper) continue;
        const dd = Math.hypot(p.x - tgt.x, p.y - tgt.y);
        if (dd < bd) { bd = dd; best = p.i; }
      }
      if (best >= 0) L.humanSlot = best;
    }
    L.prevSwitchHeld = inp.aHeld;
    // keeper distribution
    if (b.owner === 4) { inp.distA = inp.aHeld; inp.distB = inp.bHeld; }
    inputs[L.humanSlot] = inp;
    humanSlots.add(L.humanSlot);
  }
  // Practice: nobody else thinks. Dummies are inert on purpose — a target that
  // reacts is a target you can't measure against, and the whole point of this
  // mode is that the same input twice gives the same result twice.
  if (state.practice) return inputs;
  const profOpp = DIFFICULTY[L.cfg.diff];
  const profMate = effectiveProfile(profOpp, state, 0, L.cfg.momentum);
  aiInputs(state, 0, profMate, humanSlots, L.brains[0], inputs);
  aiInputs(state, 1, profOpp, null, L.brains[1], inputs);
  return inputs;
}

function viewPlayer(state, i) {
  if (i === undefined || i < 0) return null;
  if (state) return state.players[i];
  return App.net?.view?.players?.[i] || null;
}
function handleEvents(evts, state) {
  for (const e of evts) {
    sfx(e);
    const teamOf = i => (i >= 0 && i < 10) ? (i < 5 ? 0 : 1) : -1;
    switch (e.t) {
      case 'GOAL': {
        if (App.practice) {
          // No replay, no celebration camera, no kickoff. Practice never stops:
          // a 6-second presentation between every rep is the thing that makes a
          // tuning session unbearable.
          if (Practice.pending) { Practice.pending = false; Practice.goals++; }
          HUD.big('GOAL', Practice.lastShot ? `${Practice.lastShot.speed} u/s` : '', 900);
          practiceLog(`GOAL · ${Practice.lastShot?.speed ?? '?'} u/s · charge ${Practice.lastShot?.charge ?? 0}`);
          shake = Math.max(shake, 0.3);
          padRumble(0.5, 0.5, 140);
          break;
        }
        const who = e.scorer >= 0 ? App.rosterMeta?.[e.scorer] : null;
        HUD.big('GOAL!!!', who ? `${who.name} — ${App.teamNames[e.team]}` : `${App.teamNames[e.team]} scores!`, 2600);
        shake = 0.5;
        padRumble(0.7, 0.7, 220); setTimeout(() => padRumble(0.5, 0.5, 160), 320);
        for (let i = 0; i < 5; i++) particles.spawn((Math.random() - 0.5) * 20, 6 + Math.random() * 3, (Math.random() - 0.5) * 10, 30, TEAM_COLORS[(Math.random() * 6) | 0].hex, 4, 2, 1.6);
        // roll the replay first; the celebration camera picks up after it
        const gxScored = e.team === 0 ? TUNE.pitchW / 2 : -TUNE.pitchW / 2;
        // Fresh clock per presentation. A previous one that expired on its own
        // timers rather than through endPresentation would otherwise leave this
        // already past PRESENT_MAX, and the new replay would die on frame one.
        presentSawCele = false; presentT = 0;
        const rolled = startReplay(e.scorer, gxScored, performance.now() / 1000);
        if (e.scorer >= 0) {
          // absolute deadline, not a duration: the replay eats part of the window,
          // so the orbit has to ease out against the real restart time
          cele = { slot: e.scorer, t: 0, endAt: performance.now() / 1000 + TUNE.goalCeleT / 60,
            hex: who?.accentHex ?? 0xffffff, hold: rolled };
        }
        break;
      }
      case 'VOLLEY': {
        const v2 = viewPlayer(state, e.p);
        shake = Math.max(shake, e.perfect ? 0.6 : 0.4);
        camPunch = Math.max(camPunch, e.perfect ? 1.1 : 0.7);
        App.pauseFrames = Math.max(App.pauseFrames, e.perfect ? 6 : 3);
        if (v2) {
          popup(e.perfect ? 'VOLLEY!!' : 'VOLLEY', v2.x, v2.y, e.perfect ? '#ff2d9a' : '#ffd93b');
          if (particles) particles.spawn(v2.x, (e.z || 1) + 0.3, v2.y, 14,
            e.perfect ? 0xff2d9a : 0xffffff, 4.5, 3, 0.5);
        }
        break;
      }
      case 'WOODWORK': {
        // hitting the frame should land like an event, not a nudge
        shake = Math.max(shake, 0.55); camPunch = Math.max(camPunch, 0.9);
        App.pauseFrames = Math.max(App.pauseFrames, 4);
        padRumble(0.8, 0.5, 140);
        if (particles) particles.spawn(e.x, e.z + 0.2, e.y, 14, 0xffffff, 5, 2.5, 0.45);
        popup(e.part === 'bar' ? 'CROSSBAR!' : 'POST!', e.x, e.y, '#ffd93b');
        if (App.practice && Practice.pending) {
          Practice.pending = false; Practice.wide++;
          practiceLog(`${e.part === 'bar' ? 'crossbar' : 'post'} · ${Practice.lastShot?.speed} u/s`);
        }
        break;
      }
      case 'PASS': {
        if (App.practice && e.from === 0 && state) {
          Practice.passes++;
          const me = state.players[0];
          Practice.lastPass = {
            aimed: !!e.aimed, lob: !!e.lob,
            power: Math.round((e.power || 0) * 100) / 100,
            range: e.aimed ? Math.round(Math.hypot((e.lx ?? me.x) - me.x, (e.ly ?? me.y) - me.y)) : 0,
            tgt: e.to,
          };
          Practice.passPending = true;
          practiceHUD();
        }
        break;
      }
      case 'KEEPER_CHECK_START': {
        const vk = viewPlayer(state, e.k);
        if (vk) popup('KEEPER!', vk.x, vk.y, '#ff9d5c');
        padRumble(0.25, 0.25, 180);
        break;
      }
      case 'KEEPER_CHECK': {
        App.pauseFrames = Math.max(App.pauseFrames, 9);
        shake = Math.max(shake, 0.85); camPunch = Math.max(camPunch, 1.3);
        App.slowmoT = 0.13; App.timeScale = 0.42;
        padRumble(0.95, 0.55, 150);
        const vv = viewPlayer(state, e.v);
        if (vv) {
          popup(e.hadBall ? 'ROBBED!' : 'FLATTENED', vv.x, vv.y, '#ff2d9a');
          if (particles) particles.spawn(vv.x, 0.9, vv.y, 16, 0xffffff, 5, 3, 0.5);
        }
        if (App.practice) { Practice.checks++; practiceLog('keeper body-checked you'); }
        break;
      }
      case 'KEEPER_CHECK_WHIFF': {
        const vk2 = viewPlayer(state, e.k);
        if (vk2) popup('DODGED!', vk2.x, vk2.y, '#7be3a8');
        if (App.practice) { Practice.dodged++; practiceLog('DODGED the keeper — he is out of position'); }
        break;
      }
      case 'KEEPER_BUMP': {
        shake = Math.max(shake, 0.4); camPunch = Math.max(camPunch, 0.7);
        padRumble(0.6, 0.4, 110);
        const vb = viewPlayer(state, e.v);
        if (vb && particles) particles.spawn(vb.x, 0.9, vb.y, 12, 0xffffff, 4, 3, 0.5);
        break;
      }
      case 'BIG_HIT': {
        const ch = clamp(e.charge || 0, 0, 1);          // fully-loaded hits hit harder on screen too
        App.pauseFrames = Math.round(10 + ch * 8); shake = Math.max(shake, 0.75 + ch * 0.6);
        App.slowmoT = 0.11 + ch * 0.09; App.timeScale = 0.45 - ch * 0.12;
        camPunch = 1.5 + ch * 1.1;
        padRumble(0.9, 0.5, 130);
        const v = viewPlayer(state, e.v);
        if (v) particles.spawn(v.x, 1, v.y, 16, 0xffffff, 5, 3.5, 0.55);
        if (App.stats) App.stats.hits[teamOf(e.p)]++;
        break;
      }
      // took one off the body. Scales with how hard it was struck.
      case 'BLOCK': {
        shake = Math.max(shake, 0.18);
        particles.spawn(e.x, 1, e.y, 8, 0xffffff, 3.5, 2.6, 0.35);
        break;
      }
      case 'SHOT_FLATTEN': {
        const f = clamp((e.speed - 30) / 25, 0, 1);
        App.pauseFrames = Math.round(7 + f * 7); shake = Math.max(shake, 0.6 + f * 0.5);
        App.slowmoT = 0.09 + f * 0.08; App.timeScale = 0.5 - f * 0.12;
        camPunch = 1.1 + f * 0.9;
        padRumble(0.85, 0.45, 120);
        particles.spawn(e.x, 1, e.y, 14 + Math.round(f * 8), 0xffffff, 4.5, 3.2, 0.5);
        break;
      }
      case 'ZAP': {
        shake = Math.max(shake, 0.3);
        padRumble(1.0, 0.8, 260);
        const v = viewPlayer(state, e.p);
        if (v) {
          particles.spawn(v.x, 1, v.y, 26, 0xffd93b, 7, 5.5, 0.6);
          particles.spawn(v.x, 1.6, v.y, 10, 0xffffff, 4, 3, 0.35);
          // arc lightning along the nearest rail segment
          const hw3 = TUNE.pitchW / 2, hh3 = TUNE.pitchH / 2;
          const dxw = Math.min(hw3 - Math.abs(v.x), hh3 - Math.abs(v.y));
          const onSide = (hw3 - Math.abs(v.x)) < (hh3 - Math.abs(v.y));
          for (let k = -3; k <= 3; k++) {
            const px2 = onSide ? Math.sign(v.x) * hw3 : v.x + k * 1.1;
            const pz2 = onSide ? v.y + k * 1.1 : Math.sign(v.y) * hh3;
            particles.spawn(px2, 1.15, pz2, 3, k % 2 ? 0xffe94d : 0xffffff, 1.5, 2.5, 0.4);
          }
        }
        railFlash = 1;
        if (App.stats) App.stats.zaps[teamOf(e.p)]++;
        break;
      }
      case 'DEKE': {
        const v = viewPlayer(state, e.p);
        if (v) {
          for (let k = 0; k < 2; k++) {
            const g2 = ghosts.find(g3 => g3.life <= 0);
            if (!g2) break;
            g2.life = 1 - k * 0.3;
            g2.mesh.visible = true;
            g2.mesh.position.set(v.x - (v.fx || 0) * k * 0.4, 0.72, v.y - (v.fy || 0) * k * 0.4);
            g2.mesh.material.opacity = 0.35;
            const tc = TEAM_COLORS[App.rosterMeta?.[e.p]?.team === 1 ? 1 : 0];
            g2.mesh.material.color.setHex(App.rosterMeta?.[e.p]?.colorHex ?? 0xffffff);
          }
          // kick-off puff at the plant foot — the trail itself comes from poseBean
          if (particles) particles.spawn(v.x, 0.24, v.y, 12, 0xf2ecff, 2.4, 1.5, 0.5);
        }
        break;
      }
      case 'SHOT': {
        if (App.stats) App.stats.shots[teamOf(e.p)]++;
        if (App.practice && e.p === 0 && state) {
          Practice.shots++;
          const bb = state.ball;
          Practice.lastShot = {
            speed: Math.round(Math.hypot(bb.vx, bb.vy) * 10) / 10,
            charge: e.stage || 0,
            curve: Math.round((bb.flight?.curve || 0) * 100) / 100,
            finesse: !!bb.flight?.finesse,
          };
          Practice.pending = true;         // resolved by GOAL / SAVE / WOODWORK / wall
          practiceHUD();
        }
        const st2 = e.stage || 0;
        padRumble(0.25 + st2 * 0.2, 0.4, 60 + st2 * 45);
        if (st2 >= 2) { Audio2.crowd(0.22); setTimeout(() => Audio2.crowd(0.1), 1200); }
        if (st2 >= 2) {
          App.pauseFrames = Math.max(App.pauseFrames, st2 >= 3 ? 7 : 3);
          shake = Math.max(shake, 0.2 * st2);
          camPunch = Math.max(camPunch, st2 >= 3 ? 1.1 : 0.5);
        }
        // muzzle flash at the shooter's boot
        const shooter = viewPlayer(state, e.p);
        if (shooter && st2 >= 1) {
          const col = st2 >= 3 ? 0xff5b7e : st2 >= 2 ? 0xff9d5c : 0xffd93b;
          particles.spawn(shooter.x + (shooter.fx || 0), 0.5, shooter.y + (shooter.fy || 0), 8 + st2 * 6, col, 3 + st2 * 2, 2.5, 0.4);
        }
        break;
      }
      case 'PERFECT_PASS': {
        if (App.stats) App.stats.perfect[teamOf(e.p)]++;
        const v = viewPlayer(state, e.p);
        if (v) popup('PERFECT!', v.x, v.y, '#7be3a8');
        break;
      }
      case 'ONE_TIMER': if (App.stats) App.stats.oneTimers[teamOf(e.p)]++; break;
      case 'SAVE_CATCH': case 'SAVE_PARRY':
        if (App.stats) App.stats.saves[teamOf(e.k)]++;
        if (App.practice && Practice.pending) {
          Practice.pending = false; Practice.saves++;
          practiceLog(`saved (${e.t === 'SAVE_PARRY' ? 'parried' : 'caught'}) · ${Practice.lastShot?.speed} u/s`);
        }
        break;
      case 'PERFECT_OT': {
        App.slowmoT = 0.32; App.timeScale = 0.35;
        const v = viewPlayer(state, e.p);
        if (v) popup('PERFECT VOLLEY!', v.x, v.y, '#ff5b7e');
        break;
      }
      case 'KEEPER_STUN': {
        HUD.big('KEEPER DOWN!', '', 900);
        const v = viewPlayer(state, e.k);
        if (v) popup('STUNNED!', v.x, v.y, '#ffd93b');
        break;
      }
      case 'OVERTIME': HUD.big('GOLDEN GOAL', 'next goal wins!', 2000); Audio2.crowd(0.2); break;
      case 'WHISTLE': HUD.big('GO!', '', 600); break;
      case 'FULLTIME': endMatch(state); break;
    }
  }
}

let railFlash = 0;

function endMatch(state) {
  App.over = true;
  const sc = state ? state.score : App.net?.lastSnap?.sc || [0, 0];
  setTimeout(() => {
    HUD.show(false);
    const you = sc[0], them = sc[1];
    let title = 'FULL TIME';
    if (App.mode === 'local') title = you > them ? 'YOU WIN! 🏆' : you < them ? 'DEFEAT…' : 'DRAW';
    $('endTitle').textContent = title;
    $('endScore').textContent = `${App.teamNames[0]} ${you} — ${them} ${App.teamNames[1]}`;
    const st = App.stats;
    $('endStats').innerHTML = st ? `Shots ${st.shots[0]}–${st.shots[1]} · Big hits ${st.hits[0]}–${st.hits[1]} · Fence zaps ${st.zaps[0]}–${st.zaps[1]}<br>Perfect passes ${st.perfect[0]}–${st.perfect[1]} · One-timers ${st.oneTimers[0]}–${st.oneTimers[1]} · Saves forced ${st.saves[1]}–${st.saves[0]}` : '';
    // cup flow
    if (App.cup && App.mode === 'local') {
      if (you > them) {
        App.cup.stage++;
        if (App.cup.stage >= App.cup.stages.length) {
          $('endTitle').textContent = '🏆 CUP CHAMPION! 🏆';
          $('bRematch').textContent = 'MENU';
          App.cup = null;
        } else {
          $('bRematch').textContent = `NEXT: ${App.cup.stages[App.cup.stage].name}`;
        }
      } else {
        $('bRematch').textContent = 'RETRY';
      }
    } else {
      $('bRematch').textContent = 'REMATCH';
    }
    showScreen('screen-end');
  }, 1600);
}

// ------------------------------------------------------------ frame loop ----
const FPS_CAP = Math.max(24, Math.min(240, parseInt(new URLSearchParams(location.search).get('fps') || '60')));
let _lastRenderT = 0;
function frame(now) {
  if (!App.harness) App.raf = requestAnimationFrame(frame);
  // Under the harness the page is neither visible nor compositing, so rAF never
  // fires and document.hidden is true — which is exactly why every netcode bug
  // today lived here, unreachable by any test I could run. ?harness=1 lets a
  // driver step this loop on a synthetic clock instead.
  if (document.hidden && !App.harness) { App.lastT = now; return; }
  if (now - _lastRenderT < 1000 / FPS_CAP - 2) return;              // FPS cap (override with ?fps=)
  _lastRenderT = now;
  const dtReal = Math.min((now - App.lastT) / 1000, 0.1);
  App.lastT = now;
  if (App.mode === 'menu') return;
  if (App.paused) return;

  // slow-mo decay
  if (App.slowmoT > 0) { App.slowmoT -= dtReal; if (App.slowmoT <= 0) App.timeScale = 1; }

  let view = null;
  if (App.mode === 'local' && App.local) {
    const L = App.local;
    if (App.pauseFrames > 0) { App.pauseFrames--; }
    else {
      L.acc += dtReal * App.timeScale;
      let steps = 0;
      while (L.acc >= DT && steps < 4) {
        const inputs = App.autotest ? autotestInputs(L) : localHumanInputs(L.state);
        step(L.state, inputs);
        handleEvents(L.state.events, L.state);
        // A shot that hits nothing resolves against the back wall and fires no
        // event, so it would sit "pending" forever and eat the next result.
        if (App.practice && Practice.passPending) {
          const o = L.state.ball.owner;
          if (o > 0 && o < 5 && !L.state.players[o].keeper) {
            Practice.passPending = false; Practice.connected++;
            practiceLog(`pass connected${Practice.lastPass?.aimed ? ` (aimed, ${Practice.lastPass.range}m)` : ''}`);
          } else if (o >= 5 || (o === 0 && !L.state.ball.flight)) {
            Practice.passPending = false;
            practiceLog(o >= 5 ? 'pass lost to the other team' : 'pass went nowhere');
          }
        }
        if (App.practice && Practice.pending) {
          if (!L.state.ball.flight) {
            Practice.pending = false; Practice.wide++;
            practiceLog(`off target · ${Practice.lastShot?.speed} u/s`);
          }
        }
        L.acc -= DT; steps++;
      }
    }
    view = viewFromState(L.state, L.humanSlot);
  } else if (App.mode === 'online' && App.net) {
    netStatTick(dtReal);
    netSend(dtReal);                 // both paths: input must always reach the server
    if (App.net.rb) {
      // Fixed timestep, interpolated render: the sim runs at 60Hz and the screen
      // draws between the last two ticks, so every bean moves at display rate off
      // one shared state. No interpolation buffer, no second clock.
      const ctl = typeof App.net.ctl === 'number' ? App.net.ctl : App.net.slot;
      const li = rbLocalInput(ctl);
      const R = rbFrame(dtReal, ctl, li);
      if (R) view = rbView(R, ctl, clamp(R.acc / DT, 0, 1), li);
      // netSend reads this for the mouse-aim origin, and the HUD reads it too.
      if (view) App.net.view = view;
    } else {
      netFrame(dtReal);
      view = App.net.view;
    }
  }
  // Record first, then spend events: a goal's replay is sliced out of the buffer
  // the moment its event fires, so this frame's footage has to already be in it.
  if (view) recordReplay(view, now / 1000);
  flushPendingEv();
  netGraphDraw();
  // The presentation is a guest in the celebration window. The instant the match
  // leaves it — whistle, or someone mashing skip — the replay AND the celebration
  // orbit are torn down together and the camera blends back to the play angle.
  // cele used to run on a wall-clock deadline, so a skipped celebration left the
  // camera orbiting a player for seconds after play had already restarted.
  if (replay || cele) {
    presentT += dtReal;
    // Teardown used to require having SEEN phase 'goalcele'. Offline that is
    // guaranteed — the sim runs here. Online it is not: if the snapshot stream
    // stalls across the whole celebration, or view is null while it does, the
    // phase is never observed and the presentation is orphaned, leaving one
    // player watching a replay with the camera pinned while everyone else plays.
    // The grace cap means it always ends, observed or not.
    if (view && view.phase === 'goalcele') presentSawCele = true;
    else if (presentSawCele || presentT > PRESENT_MAX) endPresentation();
  }
  if (replay) {
    const rv = replayView(dtReal, view);
    if (rv) view = rv;
  }
  if (view) renderView(view, now / 1000, dtReal);
}

function autotestInputs(L) {
  const inputs = new Array(10).fill(null);
  aiInputs(L.state, 0, DIFFICULTY.pro, null, L.brains[0], inputs);
  aiInputs(L.state, 1, DIFFICULTY.pro, null, L.brains[1], inputs);
  return inputs;
}

function viewFromState(s, ctlSlot) {
  const celeTeam = s.phase === 'goalcele' ? (s.events, s.score) : null;
  return {
    players: s.players.map(p => ({
      i: p.i, x: p.x, y: p.y, vx: p.vx, vy: p.vy, fx: p.fx, fy: p.fy, off: !!p.off,
      st: p.st, stT: p.stT, charging: p.charging, chargeT: p.chargeT, buff: p.buffT > 0,
      bhCharge: p.bhChargeT || 0, passCharge: p.passChargeT || 0,
      cele: s.phase === 'goalcele' ? (p.team === (s.kickoffTeam === 0 ? 1 : 0) ? 1 : -1) : 0,
    })),
    ball: { x: s.ball.x, y: s.ball.y, z: s.ball.z, owner: s.ball.owner,
      shot: s.ball.flight && s.ball.flight.type === 'shot' ? (s.ball.flight.perfectOt ? 4 : s.ball.flight.stage) : -1,
      curve: s.ball.flight ? (s.ball.flight.curve || 0) : 0,
      backspin: s.ball.flight ? (s.ball.flight.backspin || 0) : 0,
      passTgt: s.ball.flight && (s.ball.flight.type === 'pass' || s.ball.flight.type === 'lobpass') ? s.ball.flight.tgt : -1,
      threat: livePassThreat(s) },
    score: s.score, clock: s.clock, overtime: s.overtime,
    phase: s.phase, phaseT: s.phaseT, ctlSlot,
  };
}

// ---- ball orientation ------------------------------------------------------
// Real rotation, not accumulated Euler angles. Euler accumulation composes badly
// the moment the ball changes direction — the axes interfere and it tumbles
// wrongly. We keep an actual 3x3 orientation plus an angular velocity: on the
// deck the rolling constraint sets w from the velocity, in the air the spin it
// left the ground with just carries on.
const BALL_R = 0.24;
const BALL_SPIN_SCALE = 0.55;   // true rate strobes badly at 60fps with no motion blur
const BALL_SPIN_DECAY = 0.35;   // per second, while airborne
const BALL_SIDESPIN = 0.55;     // how visibly a curling ball spins about its vertical axis
const BALL_BACKSPIN = 0.42;     // ...and how hard a chip comes off with backspin
let ballSpinCurve = 0, ballSpinBack = 0;
let ballM = [1, 0, 0, 0, 1, 0, 0, 0, 1];   // row-major orientation
let ballW = [0, 0, 0];                      // angular velocity, world space
let ballPrevPos = null;

function ballSpinReset() { ballM = [1, 0, 0, 0, 1, 0, 0, 0, 1]; ballW = [0, 0, 0]; ballPrevPos = null; ballSpinCurve = 0; ballSpinBack = 0; }

function updateBallSpin(bx, by, bz, dtReal) {
  const dt = Math.max(dtReal, 1e-4);
  if (ballPrevPos) {
    const vx = (bx - ballPrevPos.x) / dt, vz = (by - ballPrevPos.y) / dt;
    if (bz <= 0.16) {
      // rolling without slipping: w = (contact normal x velocity) / radius
      const k = BALL_SPIN_SCALE / BALL_R;
      ballW[0] = vz * k; ballW[1] = 0; ballW[2] = -vx * k;
    } else {
      const d = Math.exp(-BALL_SPIN_DECAY * dt);
      ballW[0] *= d; ballW[1] *= d; ballW[2] *= d;
      // A bending ball has to LOOK like it is bending. Sidespin about the vertical
      // axis, signed by the curl, plus real backspin on a chip — otherwise a
      // curling shot is just a ball travelling along a curved line, and the player
      // never sees the thing they did.
      if (ballSpinCurve) ballW[1] += ballSpinCurve * BALL_SIDESPIN * dt * 60;
      if (ballSpinBack) {
        const sp = Math.hypot(vx, vz) || 1;
        ballW[0] += (-vz / sp) * ballSpinBack * BALL_BACKSPIN * dt * 60;
        ballW[2] += (vx / sp) * ballSpinBack * BALL_BACKSPIN * dt * 60;
      }
    }
  }
  ballPrevPos = { x: bx, y: by };

  const wl = Math.hypot(ballW[0], ballW[1], ballW[2]);
  if (wl > 1e-5) {
    // Rodrigues: M = dR * M, about the angular-velocity axis
    const ax = ballW[0] / wl, ay = ballW[1] / wl, az = ballW[2] / wl;
    const th = wl * dt, c = Math.cos(th), s = Math.sin(th), t1 = 1 - c;
    const d = [
      t1 * ax * ax + c, t1 * ax * ay - s * az, t1 * ax * az + s * ay,
      t1 * ax * ay + s * az, t1 * ay * ay + c, t1 * ay * az - s * ax,
      t1 * ax * az - s * ay, t1 * ay * az + s * ax, t1 * az * az + c,
    ];
    const m = ballM, o = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let cc = 0; cc < 3; cc++) {
        o[r * 3 + cc] = d[r * 3] * m[cc] + d[r * 3 + 1] * m[3 + cc] + d[r * 3 + 2] * m[6 + cc];
      }
    }
    ballM = o;
  }
  // back to the engine's Euler (it composes Ry*Rx*Rz)
  const m = ballM;
  const sx = Math.max(-1, Math.min(1, -m[5]));
  const x = Math.asin(sx);
  if (Math.abs(m[5]) < 0.9999) {
    ballMesh.rotation.set(x, Math.atan2(m[2], m[8]), Math.atan2(m[3], m[4]));
  } else {
    ballMesh.rotation.set(x, Math.atan2(-m[6], m[0]), 0);
  }
}

function renderView(v, t, dtReal) {
  if (App.trailTest && v.ball) v.ball.shot = 3;   // ?trailtest=1 — visual verification hook
  // countdown display
  if (v.phase === 'countdown') {
    const n = Math.ceil(v.phaseT / (TUNE.countdownT / 3));
    // short lifetime, refreshed every frame: online the rendered phase lags the
    // WHISTLE that would clear it, so a never-expiring digit sticks all match
    HUD.big(String(clamp(n, 1, 3)), 'get ready…', 350);
  } else if (v.phase === 'over') { HUD.hideBig(); }

  HUD.score(v.score, App.teamNames[0], App.teamNames[1]);
  HUD.clock(v.clock, v.overtime);

  if (!v.isReplay) updateNameTags(v.ctlSlot);
  for (let i = 0; i < beans.length; i++) {
    const pv = v.players[i];
    // Practice parks unused beans 120m off the pitch; don't draw or pose them.
    if (pv && pv.off) { if (beans[i].visible !== false) beans[i].visible = false; continue; }
    if (beans[i].visible === false) beans[i].visible = true;
    poseBean(beans[i], pv, t, v.ctlSlot);
  }

  // ball (carried: draw it clearly in front of the dribbler's feet)
  let bx = v.ball.x, by = v.ball.y, bz = v.ball.z;
  if (v.ball.owner >= 0 && v.players[v.ball.owner]) {
    const o = v.players[v.ball.owner];
    bx = o.x + o.fx * 0.85; by = o.y + o.fy * 0.85; bz = 0.11;
  }
  ballMesh.position.set(bx, Math.max(bz, 0.11) + 0.24, by);
  // Roll the ball off its actual travel instead of spinning at a fixed rate: the
  // axis is square to the direction it's going and the rate is speed / radius, so
  // it rolls the right way at the right speed — and sits still when the ball does.
  updateBallSpin(bx, by, bz, dtReal);
  // shot tracer
  trailBuf.unshift({ x: ballMesh.position.x, y: ballMesh.position.y, z: ballMesh.position.z });
  if (trailBuf.length > 13) trailBuf.pop();
  const shotStage = v.ball.shot ?? -1;
  // a live threatening pass gets its own green tracer, so you can read the danger
  // of the ball in flight before it even arrives
  const threat = !!v.ball.threat && shotStage < 0;
  const trailCol = threat ? 0x3ce07f
    : shotStage >= 4 ? 0xff2d9a : shotStage >= 3 ? 0xff5b7e : shotStage >= 2 ? 0xff9d5c : shotStage >= 1 ? 0xffd93b : 0xffffff;
  const trailBoost = shotStage >= 3 ? 1.35 : threat ? 1.1 : 1;
  for (let i = 0; i < trail.length; i++) {
    const src = trailBuf[i + 1];
    const on = (shotStage >= 0 || threat) && src;
    trail[i].visible = !!on;
    if (on) {
      trail[i].position.set(src.x, src.y, src.z);
      const f2 = 1 - i / trail.length;
      trail[i].scale.setScalar((0.35 + f2 * 0.75) * trailBoost);
      trail[i].material.opacity = f2 * (threat ? 0.62 : 0.3 + shotStage * 0.16);
      trail[i].material.color.setHex(trailCol);
    }
  }
  // energized ball while a shot is live
  if (shotStage >= 0) {
    const bp = 1.12 + shotStage * 0.05 + Math.sin(t * 30) * 0.06;
    ballMesh.scale.set(bp, bp, bp);
  } else ballMesh.scale.set(1, 1, 1);
  // drive the ball's visible spin off the curl it is actually carrying
  ballSpinCurve = v.ball.curve || 0;
  ballSpinBack = v.ball.backspin || 0;
  ballShadow.position.set(bx, 0.03, by);
  const sh = clamp(1 - v.ball.z / 8, 0.3, 1);
  ballShadow.scale.setScalar(sh); ballShadow.material.opacity = 0.3 * sh;

  // control ring (+ flash on switch)
  if (v.ctlSlot >= 0 && v.players[v.ctlSlot]) {
    const cp = v.players[v.ctlSlot];
    controlRing.visible = true;
    if (renderView._lastCtl !== v.ctlSlot) { renderView._lastCtl = v.ctlSlot; renderView._switchT = 0.25; }
    if (renderView._switchT > 0) renderView._switchT -= dtReal;
    const swf = Math.max(0, renderView._switchT || 0) / 0.25;
    controlRing.position.set(cp.x, 0.08, cp.y);
    controlRing.rotation.z = t * 1.5;
    controlRing.scale.setScalar(1 + swf * 1.1);
    controlRing.material.opacity = 1;
    // charge feedback
    if (cp.charging && cp.chargeT > 0) {
      const frac = clamp(cp.chargeT / TUNE.chargeStageT[2], 0, 1);
      const stage = cp.chargeT >= TUNE.chargeStageT[2] ? 3 : cp.chargeT >= TUNE.chargeStageT[1] ? 2 : cp.chargeT >= TUNE.chargeStageT[0] ? 1 : 0;
      HUD.charge(frac, stage);
      chargeRing.material.opacity = 0.65;
      chargeRing.material.color.setHex(stage >= 3 ? 0xff5b7e : stage >= 2 ? 0xff9d5c : 0xffd93b);
      chargeRing.position.set(cp.x, 0.1, cp.y);
      chargeRing.scale.setScalar(1 + frac * 0.6 + Math.sin(t * 12) * 0.05);
    } else if (cp.passCharge > 0) {
      // weighting a pass — mint, and it flips gold once it stops auto-targeting
      // and starts going exactly where you point it
      const frac = clamp(cp.passCharge / TUNE.passChargeMax, 0, 1);
      const aimed = frac >= TUNE.aimPassAt;
      HUD.charge(frac, aimed ? 2 : 1);
      chargeRing.material.opacity = 0.6;
      chargeRing.material.color.setHex(aimed ? 0xffd93b : 0x7be3a8);
      chargeRing.position.set(cp.x, 0.1, cp.y);
      chargeRing.scale.setScalar(1 + frac * 0.7);
    } else if (cp.bhCharge > 0) {
      // winding up a big hit — same bar, angrier colour so it reads as a hit not a shot
      const frac = clamp(cp.bhCharge / TUNE.bhChargeMax, 0, 1);
      HUD.charge(frac, frac >= 1 ? 3 : frac > 0.6 ? 2 : 1);
      chargeRing.material.opacity = 0.7;
      chargeRing.material.color.setHex(frac >= 1 ? 0xff3b6e : 0x9b8cff);
      chargeRing.position.set(cp.x, 0.1, cp.y);
      chargeRing.scale.setScalar(1 + frac * 1.1 + Math.sin(t * 18) * 0.07 * frac);
    } else { HUD.charge(0, 0); chargeRing.material.opacity = 0; }
  } else { controlRing.visible = false; HUD.charge(0, 0); chargeRing.material.opacity = 0; }

  // camera
  const hw2 = TUNE.pitchW / 2;
  const tx = clamp(v.ball.x * 0.82, -(hw2 - 6.5), hw2 - 6.5);
  camX = lerp(camX, tx, 1 - Math.exp(-4 * dtReal));
  const zoomOut = clamp(Math.abs(v.ball.x) / hw2, 0, 1) * 1.5;
  // drama zoom: push in when play is deep in an attacking third
  const attackDepth = clamp((Math.abs(v.ball.x) - hw2 * 0.5) / (hw2 * 0.5), 0, 1);
  camZoom = lerp(camZoom, attackDepth * 1.6, 1 - Math.exp(-2.5 * dtReal));
  if (camPunch > 0) camPunch = Math.max(0, camPunch - dtReal * 4);
  // Height and pull-back scale with the pitch, or a bigger field just crops.
  const CAMS = TUNE.pitchH / 30;
  let cx = camX + (Math.random() - 0.5) * shake;
  let cy = 17.2 * CAMS + zoomOut - camZoom - camPunch * 0.7 + (Math.random() - 0.5) * shake;
  let cz = 25.5 * CAMS + zoomOut * 1.6 - camZoom * 1.4 - camPunch;
  camLook.set(camX * 0.92, 0.3, v.ball.y * 0.32 - 2.2);

  // replay owns the camera outright while it runs
  const inReplay = !!(v.isReplay && replay);
  if (inReplay) {
    const rc = replayCamera(v);
    cx = rc.pos[0]; cy = rc.pos[1]; cz = rc.pos[2];
    camLook.set(rc.look[0], rc.look[1], rc.look[2]);
  }
  // goal celebration: swing in low and close on the scorer, hold, then release
  if (cele && cele.hold && replay) cele.t = 0;   // the orbit waits for the replay
  if (cele && !inReplay) {
    cele.t += dtReal;
    const sp2 = v.players[cele.slot];
    const remain = cele.endAt - performance.now() / 1000;
    if (!sp2 || remain <= 0) { cele = null; }
    else {
      const inT = clamp(cele.t / 0.45, 0, 1);                       // ease in
      const outT = clamp(remain / 0.5, 0, 1);                       // ease out on the restart
      const w = Math.min(inT, outT) * Math.min(inT, outT) * (3 - 2 * Math.min(inT, outT));
      const orbit = cele.t * 0.9;
      const tx2 = sp2.x + Math.sin(orbit) * 3.6;
      const tz2 = sp2.y + 6.4 + Math.cos(orbit) * 1.2;
      cx = lerp(cx, tx2, w); cy = lerp(cy, 3.4, w); cz = lerp(cz, tz2, w);
      camLook.set(lerp(camLook.x, sp2.x, w), lerp(camLook.y, 1.15, w), lerp(camLook.z, sp2.y, w));
      if (Math.random() < 0.35 * w) {
        particles.spawn(sp2.x + (Math.random() - 0.5) * 2, 0.6 + Math.random() * 2, sp2.y + (Math.random() - 0.5) * 2,
          2, cele.hex, 2.2, 3, 0.9);
      }
    }
  }
  // easing back from a celebration/replay camera to the live one
  if (camBlend > 0 && camBlendFrom) {
    camBlend = Math.max(0, camBlend - dtReal);
    const w = camBlend / CAM_BLEND_T;                 // 1 at handover -> 0 when done
    const e = w * w * (3 - 2 * w);
    cx = lerp(cx, camBlendFrom[0], e); cy = lerp(cy, camBlendFrom[1], e); cz = lerp(cz, camBlendFrom[2], e);
    camLook.set(lerp(camLook.x, camBlendFrom[3], e), lerp(camLook.y, camBlendFrom[4], e),
      lerp(camLook.z, camBlendFrom[5], e));
    if (camBlend <= 0) camBlendFrom = null;
  }
  camera.position.set(cx, cy, cz);
  camera.lookAt(camLook);
  shake = Math.max(0, shake - dtReal * 1.6);

  // receiver indicator (bouncing arrow above the pass target)
  const pt = v.ball.passTgt ?? -1;
  recvArrow.visible = pt >= 0 && !!v.players[pt];
  if (recvArrow.visible) {
    const r = v.players[pt];
    recvArrow.position.set(r.x, 2.1 + Math.abs(Math.sin(t * 7)) * 0.35, r.y);
    recvArrow.material.color.setHex(pt === v.ctlSlot ? 0xffd93b : 0xffffff);
  }

  // deke ghosts fade
  for (const g2 of ghosts) {
    if (g2.life > 0) {
      g2.life -= dtReal * 4.5;
      g2.mesh.material.opacity = Math.max(0, g2.life * 0.4);
      if (g2.life <= 0) g2.mesh.visible = false;
    }
  }

  // sprint dust (visual RNG only — sim untouched)
  for (const p of v.players) {
    const spd = Math.hypot(p.vx || 0, p.vy || 0);
    if (spd > 9.4 && Math.random() < 0.25) particles.spawn(p.x, 0.15, p.y, 1, 0xfff7ee, 0.8, 1.2, 0.35);
  }

  updatePopups(dtReal);

  // mouse-aim reticle
  if (reticle) {
    const showRet = Input.scheme === 'mouse' && Input.lastDevice !== 'pad' && Input.cursorSim
      && App.mode !== 'menu' && !replay;
    reticle.visible = !!showRet;
    if (showRet) {
      const ga = Input.goalAim;
      if (ga) {
        // aiming at the net: stand the reticle up on the goal face at the exact spot
        reticle.position.set(ga.gx, ga.z, ga.y);
        reticle.rotation.set(0, Math.PI / 2, t * 2.2);
      } else {
        reticle.position.set(Input.cursorSim.x, 0.06, Input.cursorSim.y);
        reticle.rotation.set(Math.PI / 2, 0, t * 2.2);
      }
      const sc = (ga ? 0.8 : 1) * (1 + Math.sin(t * 6) * 0.08);
      reticle.scale.set(sc, sc, sc);
    }
  }

  updatePrecip(dtReal, t);
  updateNets(dtReal);
  // ball inside the goal: keep pushing the net where it presses against it
  {
    const half = TUNE.pitchW / 2;
    if (Math.abs(v.ball.x) > half - 0.3 && Math.abs(v.ball.y) < TUNE.goalW / 2 + 0.4 && v.ball.z < TUNE.goalH) {
      netKick(v.ball.x, v.ball.y, v.ball.z, 0.05);
    }
  }

  // rails
  if (railFlash > 0) { railFlash -= dtReal * 2.5; }
  const railC = railFlash > 0 ? 0xffe94d : 0xff8a70;
  for (const rm of railMats) rm.color.setHex(railC);

  // crowd bob (throttled to 15Hz — 220 instances don't need per-frame updates)
  if (crowdMesh && t - (renderView._crowdT || 0) > 1 / 15) {
    renderView._crowdT = t;
    const dummy = renderView._crowdDummy || (renderView._crowdDummy = new THREE.Object3D());
    for (let i = 0; i < crowdPhases.length; i++) {
      const c = crowdPhases[i];
      dummy.position.set(c.x, c.y + Math.abs(Math.sin(t * 2.2 + c.ph)) * 0.25, c.z);
      dummy.updateMatrix(); crowdMesh.setMatrixAt(i, dummy.matrix);
    }
    crowdMesh.instanceMatrix.needsUpdate = true;
  }

  particles.update(dtReal);
  renderer.render(scene, camera);
}

// ============================================================================
// ONLINE
// ============================================================================
function defaultServer() {
  if (location.protocol.startsWith('http') && location.host) {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }
  return 'ws://localhost:8470';
}

function netConnect(url, onOpen) {
  const ws = new WebSocket(url);
  ws.onopen = onOpen;
  ws.onerror = () => { $('onError').textContent = 'Could not reach server. Is server.js running?'; };
  ws.onclose = () => {
    if (App.mode === 'online') { toast('Disconnected from server'); backToMenu(); }
  };
  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'snap') netStatSnap(typeof e.data === 'string' ? e.data.length : 0);
    if (msg.t === 'pong') {
      NS.rtt = performance.now() - msg.ts;
      NS.rttMin = Math.min(NS.rttMin, NS.rtt);
      return;
    }
    netHandle(msg);
  };
  return ws;
}

// lobby row index → sim player index (keepers 4 and 9 are never human)
const FIELD_SLOTS = [0, 1, 2, 3, 5, 6, 7, 8];

// Accent colours: teammates all share a kit colour, so this is what tells them
// apart on the pitch (and in the lobby list).
const ACCENT_COLORS = [
  { css: '#ff5fa2', hex: 0xff5fa2 }, { css: '#38b6ff', hex: 0x38b6ff },
  { css: '#ffd93b', hex: 0xffd93b }, { css: '#57e39b', hex: 0x57e39b },
  { css: '#b08cff', hex: 0xb08cff }, { css: '#ff8a4c', hex: 0xff8a4c },
];

function sendRoster(slot, arche, traits, accent) {
  const N = App.net;
  if (N?.ws?.readyState === 1) N.ws.send(JSON.stringify({ t: 'roster', slot, arche, traits, accent }));
}

// Whole-roster builder: every field bean is editable, AI ones included. You get
// your own side; the host gets both.
function buildLobbyRoster(msg) {
  const N = App.net;
  if (!N || !$('lobbySlots')) return;
  N.lobbyMsg = msg;
  if (typeof N.selSlot !== 'number') N.selSlot = N.slot;

  // match length — host sets it, everyone sees it
  const tsel = $('lobbyTimer');
  if (tsel) {
    if (msg.timerLen) tsel.value = String(msg.timerLen);
    tsel.disabled = !N.isHost;
    $('lobbyTimerNote').textContent = N.isHost ? '' : "host's choice";
    tsel.onchange = () => {
      if (N.isHost && N.ws?.readyState === 1) N.ws.send(JSON.stringify({ t: 'timer', sec: parseInt(tsel.value) }));
    };
  }
  const wsel = $('lobbyWeather');
  if (wsel) {
    if (msg.weather) wsel.value = msg.weather;
    wsel.disabled = !N.isHost;
    $('lobbyWeatherNote').textContent = N.isHost ? '' : "host's choice";
    wsel.onchange = () => {
      if (N.isHost && N.ws?.readyState === 1) N.ws.send(JSON.stringify({ t: 'weather', w: wsel.value }));
    };
  }
  const myTeam = N.slot < 5 ? 0 : 1;
  const editable = (slot, nm) => (!nm || slot === N.slot) && ((slot < 5 ? 0 : 1) === myTeam || N.isHost);
  const el = $('lobbySlots'); el.innerHTML = '';
  msg.slots.forEach((nm, i) => {
    const slot = FIELD_SLOTS[i];
    const r = (msg.roster && msg.roster[i]) || { arche: 'allround', traits: {}, accent: i % ACCENT_COLORS.length };
    const seatTeam = slot < 5 ? 0 : 1;
    const mine = slot === N.slot;
    const canEdit = editable(slot, nm);

    const row = document.createElement('div');
    row.className = 'lobbyslot' + (mine ? ' mine' : '') + (!nm ? ' free' : '') + (slot === N.selSlot ? ' sel' : '');

    const sw = document.createElement('span');
    sw.className = 'accdot';
    sw.style.background = ACCENT_COLORS[(r.accent | 0) % ACCENT_COLORS.length].css;
    sw.title = canEdit ? 'click to change colour' : 'colour';
    if (canEdit) sw.onclick = () => sendRoster(slot, r.arche, r.traits || {}, ((r.accent | 0) + 1) % ACCENT_COLORS.length);
    row.appendChild(sw);

    const who = document.createElement('span');
    who.style.flex = '1'; who.style.cursor = 'pointer';
    who.title = 'select — the stat points below apply to this bean';
    who.textContent = `${seatTeam === 0 ? 'PINK' : 'BLUE'} ${(slot % 5) + 1} · ${nm || 'bot'}${mine ? ' (you)' : ''}`;
    who.onclick = () => { N.selSlot = slot; buildLobbyRoster(msg); };
    row.appendChild(who);

    const sel = document.createElement('select');
    sel.style.fontSize = '12px'; sel.style.padding = '2px 6px';
    for (const k of Object.keys(ARCHETYPES)) {
      const o = document.createElement('option'); o.value = k; o.textContent = ARCHETYPES[k].label;
      sel.appendChild(o);
    }
    sel.value = r.arche; sel.disabled = !canEdit;
    // new archetype clears the spent points, and the stat panel follows the bean
    // you just changed so you can immediately spend them on its new base stats
    sel.onchange = () => { N.selSlot = slot; sendRoster(slot, sel.value, {}, r.accent); };
    row.appendChild(sel);

    if (!nm && !mine) {
      const b = document.createElement('button');
      b.className = 'mini'; b.style.width = 'auto'; b.style.padding = '0 10px'; b.style.fontSize = '11px';
      b.textContent = 'PLAY AS';
      b.title = 'move yourself into this seat — you control this bean';
      b.onclick = () => N.ws.send(JSON.stringify({ t: 'slot', slot }));
      row.appendChild(b);
    }
    el.appendChild(row);
  });

  // stat points apply to whichever bean is selected above, yours or a bot's
  const selIdx = FIELD_SLOTS.indexOf(N.selSlot);
  // tolerate an older server that doesn't send a roster rather than blanking the panel
  const selR = (msg.roster && msg.roster[selIdx])
    || { arche: 'allround', traits: {}, accent: selIdx % ACCENT_COLORS.length };
  if (selR) {
    const selName = msg.slots[selIdx];
    const selTeam = N.selSlot < 5 ? 0 : 1;
    const canEditSel = editable(N.selSlot, selName);
    const traits = { ...(selR.traits || {}) };
    const who = `${selTeam === 0 ? 'PINK' : 'BLUE'} ${(N.selSlot % 5) + 1}`;
    buildTraitUI($('lobbyTraits'), selR.arche, traits,
      canEditSel ? `${who} stat points` : `${who} stat points (not yours to set)`,
      () => sendRoster(N.selSlot, selR.arche, traits, selR.accent), !canEditSel);
  }
}

function netHandle(msg) {
  const N = App.net;
  switch (msg.t) {
    case 'hosted': case 'joined': {
      N.code = msg.code; N.slot = msg.slot; N.ctl = msg.slot; N.isHost = msg.t === 'hosted';
      $('lobby').classList.remove('hidden');
      $('lobbyCode').textContent = msg.code;
      $('bStart').style.display = N.isHost ? '' : 'none';
      break;
    }
    case 'lobby': buildLobbyRoster(msg); break;
    case 'slotset': {
      N.slot = msg.slot; N.ctl = msg.slot;
      if (N.lobbyMsg) buildLobbyRoster(N.lobbyMsg);   // editability moved with us
      break;
    }
    case 'ctl': { N.ctl = msg.slot; N.pred = null; break; }   // server moved our control
    case 'ctlmap': { App.ctlMap = msg.m; break; }             // who's driving what, for everyone
    case 'started': {
      N.cfg = msg.cfg;
      weatherKey = resolveWeather(msg.cfg.weather);   // host already rolled any 'random'
      App.teamNames = [msg.cfg.teams[0].name, msg.cfg.teams[1].name];
      App.rosterMeta = rosterMetaFrom(msg.cfg.teams);
      App.stats = { shots: [0, 0], hits: [0, 0], perfect: [0, 0], oneTimers: [0, 0], saves: [0, 0], zaps: [0, 0] };
      N.snaps = []; N.seq = 0; N.pred = null; N.ctl = N.slot; App.ctlMap = null;
      N.hist = []; N.ackSeq = -1; N.perr = null; N.shownX = undefined; N.lastAuthT = -1;
      N.loc = null; N.locCtl = -1;
      // Rollback needs the match from tick 0. A late joiner has no way back to
      // it, so it stays on interpolation rather than desyncing quietly.
      N.rb = (App.rollback && typeof msg.cfg.seed === 'number') ? rbStart(msg.cfg) : null;
      // Ask for the input stream only if we are going to replay it. Unasked, it
      // was ~11KB/s of every client's bandwidth going straight in the bin.
      if (N.ws && N.ws.readyState === 1) N.ws.send(JSON.stringify({ t: 'rb', on: !!N.rb }));
      beginMatchUI();
      App.mode = 'online';
      HUD.net(`online · slot ${N.slot} · ${N.code}`);
      break;
    }
    case 'snap': {
      const N2 = App.net;
      msg.rt = performance.now();
      N2.snaps.push(msg);
      if (N2.snaps.length > 12) N2.snaps.shift();
      N2.lastSnap = msg.sn;
      if (msg.ak) {
        const mine = msg.ak[typeof N2.ctl === 'number' ? N2.ctl : N2.slot];
        if (typeof mine === 'number') N2.ackSeq = mine;
      }
      // Events used to fire the instant the packet landed, but we render 80ms
      // behind the newest snapshot. So a GOAL started its replay while the
      // recorded footage was still 80ms short of the ball crossing the line —
      // every online replay clipped out just before the finish — and every
      // online thud and spark went off early. Hold them to the render clock.
      // Rollback runs its own timeline and fires events off the confirmed state,
      // so the snapshot's event list would double them up.
      if (N2.rb) {
        if (msg.ip) N2.rb.queue.push(...msg.ip);
        if (typeof msg.h === 'number') N2.rb.check.push([msg.hk, msg.h]);
      } else if (msg.ev && msg.ev.length) {
        pendingEv.push({ at: performance.now() + NET_INTERP_MS, ev: msg.ev });
      }
      if (msg.sn.ph === 'over' && !App.over) endMatch(null);
      break;
    }
    // Authoritative repair. Anything still queued predates this state, so it has
    // to go — replaying it would re-apply history we just overwrote.
    case 'sync': {
      const R = App.net && App.net.rb;
      if (R) {
        restoreState(R.conf, msg.st);
        R.queue.length = 0; R.check.length = 0;
        R.syncPend = false; R.prev = null; R.cur = cloneState(R.conf); R.show = -1; R.tclock = -1; R.track.length = 0; R.evQ.length = 0;
        NS.resyncs++;
        console.warn(`[bopball] resynced to tick ${msg.tick}`);
      }
      break;
    }
    case 'err': $('onError').textContent = msg.msg; break;
  }
}

// Prediction needs your real top speed, not an average. Archetypes run spd 3-9,
// so a Speedster predicted at a Playmaker's pace drifts a metre a second.
function statsForSlot(slot) {
  const N = App.net;
  if (!N || !N.cfg || slot < 0) return { spd: 6 };
  const team = slot < 5 ? 0 : 1, idx = slot % 5;
  const tc = N.cfg.teams[team];
  if (idx === 4 || !tc) return { spd: 5 };
  const src = (tc.lineup && tc.lineup[idx]) || (idx === 0 ? tc.captain : tc.sidekick);
  return statsFrom(src?.arche || 'allround', src?.traits);
}

// ---- rollback ---------------------------------------------------------------
// One sim, one clock. The client runs the whole match locally from the server's
// seed and replays the exact inputs the server used. Ticks the server has not
// sent yet are predicted by repeating each bean's last input — except your own,
// which uses your live input, so your bean answers instantly. When the real
// inputs arrive we re-simulate from the last confirmed tick, so a misprediction
// costs a re-sim rather than a visible correction. Everything renders off the
// same state, which is the whole point: no second clock for remote beans.
const RB_LEAD_MIN = 1, RB_LEAD_MAX = 14;
// How far the remote track trails the newest confirmed tick. Just enough to keep
// two samples on hand to interpolate between — everything beyond this is margin
// the player pays for in how stale other beans look.
const RB_TRACK_BEHIND = 1.5;
// Draw between two sim ticks. Positions and facings lerp; discrete fields take
// the newer tick, because you cannot interpolate 'norm' halfway into 'down'.
function blendViews(a, b, f) {
  const v = { ...b };
  v.players = b.players.map((pb, i) => {
    const pa = a.players[i] || pb;
    return { ...pb, x: lerp(pa.x, pb.x, f), y: lerp(pa.y, pb.y, f),
      fx: lerp(pa.fx, pb.fx, f), fy: lerp(pa.fy, pb.fy, f) };
  });
  v.ball = { ...b.ball, x: lerp(a.ball.x, b.ball.x, f), y: lerp(a.ball.y, b.ball.y, f), z: lerp(a.ball.z, b.ball.z, f) };
  return v;
}
// Draw each bean from the source that can actually be smooth for it.
//
// Your own bean and the ball come off the prediction: they must answer your
// input now, and your own inputs are known so the prediction is exact.
//
// Remote beans come off the CONFIRMED track instead, interpolated. Predicting
// them means repeating their last input through the lead window, and a real
// player changes direction constantly — so the guess is wrong most packets and
// gets corrected 30 times a second. That correction is the visual disruption,
// and no amount of smoothing removes it because the error keeps arriving. Drawn
// from the confirmed track they are a few ticks behind but never wrong, so they
// never need correcting. Nothing to smooth, nothing to see.
function rbView(R, ctl, f, liveInp) {
  const view = R.prev
    ? blendViews(viewFromState(R.prev, ctl), viewFromState(R.cur, ctl), f)
    : viewFromState(R.cur, ctl);
  // Your own bean is EXTRAPOLATED, never interpolated. Blending prev->cur draws
  // it up to a full tick in the past — at f=0, right after a tick, it is showing
  // the previous one. Single player never pays that because it draws the newest
  // state directly, and that missing ~8ms average is a real part of why online
  // felt less crisp. Your input is known, so the honest answer is to run your
  // bean forward the leftover fraction of a tick rather than lag it.
  if (ctl >= 0 && R.cur.players[ctl] && liveInp) {
    const src = R.cur.players[ctl];
    const sub = { ...src };
    sub.inMx = liveInp.mx || 0; sub.inMy = liveInp.my || 0;
    sub.inSprint = !!liveInp.sprint; sub.charging = !!liveInp.bHeld;
    const dt = f * DT;
    if (dt > 0 && moveStep(sub, R.cur.ball.owner === ctl, dt)) {
      sub.x += sub.vx * dt; sub.y += sub.vy * dt;
    }
    const v = view.players[ctl];
    v.x = sub.x; v.y = sub.y; v.vx = sub.vx; v.vy = sub.vy;
    if (sub.fx || sub.fy) { v.fx = sub.fx; v.fy = sub.fy; }
    v.st = src.st; v.stT = src.stT;              // pose from the tick, not blended
  }
  const tr = R.track;
  if (tr.length < 2) return view;
  // Its own clock, already advanced this frame at real rate.
  const want = R.tclock;
  const newest = tr[tr.length - 1].t;
  const at = Math.min(want, newest);
  let i = tr.length - 2;
  while (i > 0 && tr[i].t > at) i--;
  const a = tr[i], b = tr[i + 1];
  const g = clamp((at - a.t) / Math.max(b.t - a.t, 1), 0, 1);
  for (let p = 0; p < view.players.length; p++) {
    if (p === ctl) continue;                  // yours stays predicted
    const pa = a.pl[p], pb = b.pl[p];
    if (!pa || !pb) continue;
    const v = view.players[p];
    v.x = lerp(pa.x, pb.x, g); v.y = lerp(pa.y, pb.y, g);
    v.fx = lerp(pa.fx, pb.fx, g); v.fy = lerp(pa.fy, pb.fy, g);
    v.vx = pb.vx; v.vy = pb.vy;
    // Discrete state takes the newer sample — you cannot interpolate 'norm'
    // halfway into 'down' — but it must come from the TRACK, not the guess.
    // Same as the snapshot path: advance the animation timer smoothly while the
    // state holds, so poses play every frame instead of every track sample.
    v.st = pb.st; v.stT = pa.st === pb.st ? lerp(pa.stT, pb.stT, g) : pb.stT;
    v.charging = pb.charging; v.chargeT = pb.chargeT;
    v.buff = pb.buff; v.bhCharge = pb.bhCharge; v.passCharge = pb.passCharge;
  }
  // The ball. Predicting it is EXACT while it is yours — you are dribbling it or
  // you just struck it, and your own inputs are known — and free flight after
  // that is pure physics. It only becomes a guess once someone else can touch it,
  // which is precisely when it should come off the confirmed track instead.
  // Crossfaded because the handover is a real discontinuity between two different
  // trajectories, and it must not read as the ball flicking sideways.
  const bl = R.cur.ball;
  const mine = bl.owner === ctl || (bl.owner < 0 && bl.lastTouch === ctl);
  // dt-based, not per frame: a per-frame rate hands over twice as fast at 120fps
  // as at 60. Slow enough that the two trajectories converge instead of cutting.
  R.ballMix += ((mine ? 1 : 0) - R.ballMix) * (1 - Math.exp(-4.5 * R.lastDt));
  if (R.ballMix < 0.999 && a.ba && b.ba) {
    const cx = lerp(a.ba.x, b.ba.x, g), cy = lerp(a.ba.y, b.ba.y, g), cz = lerp(a.ba.z, b.ba.z, g);
    const m = R.ballMix;
    view.ball.x = lerp(cx, view.ball.x, m);
    view.ball.y = lerp(cy, view.ball.y, m);
    view.ball.z = lerp(cz, view.ball.z, m);
  }
  return view;
}

// The same input the sim would get locally, for the bean we are driving.
function rbLocalInput(ctl) {
  if (ctl < 0) return null;
  const N = App.net;
  const inp = N && N.lastInp ? { ...N.lastInp } : null;
  if (inp) inp.human = true;
  return inp;
}
function rbStart(cfg) {
  const R = {
    conf: makeMatch({
      seed: cfg.seed, timerLen: cfg.timerLen, teams: cfg.teams,
      weakGoalies: cfg.weakGoalies, keeperReflex: cfg.kr || [14, 14],
    }),
    queue: [], acc: 0, lead: 4, last: new Array(10).fill(null),
    cur: null, prev: null, ready: false, evSeen: 0,
    check: [], syncPend: false, show: -1, track: [], n: 0, trackLag: 0, tclock: -1, ballMix: 0, lastDt: 1 / 60, evQ: [],
  };
  R.cur = cloneState(R.conf);
  return R;
}
// Advance the confirmed state by every input frame the server has delivered.
function rbConsume(R) {
  while (R.queue.length) {
    const [rng, frame] = R.queue.shift();
    const inputs = frame.map(decodeInput);
    for (let i = 0; i < 10; i++) if (inputs[i]) R.last[i] = inputs[i];
    // Adopt the server's PRNG. Its AI draws from the same stream the physics
    // uses, and we do not run the AI, so without this we drift within seconds.
    R.conf.rngState = rng;
    step(R.conf, inputs);
    // Do NOT fire these yet. They describe the confirmed tick, but the beans they
    // are about are drawn a few ticks later off the track — firing on arrival put
    // every thud, spark and shake ahead of the thing that caused it. Queue them
    // against their tick and spend them when the track clock gets there.
    const pendEv = R.conf.events.length ? R.conf.events.slice() : null;
    R.ready = true;
    // Keep the confirmed track. Remote beans are drawn from THIS, interpolated,
    // rather than from a prediction that has to be corrected every packet.
    R.track.push({
      t: R.conf.tick,
      // Pose travels WITH the body. Taking st/stT from the prediction while the
      // position came from here put a remote bean's animation 100ms ahead of
      // itself — sliding before it arrived, and flickering whenever the guessed
      // state was wrong. Same tick, same bean, same everything.
      pl: R.conf.players.map(p => ({
        x: p.x, y: p.y, fx: p.fx, fy: p.fy, vx: p.vx, vy: p.vy,
        st: p.st, stT: p.stT, charging: p.charging, chargeT: p.chargeT,
        buff: p.buffT > 0, bhCharge: p.bhChargeT || 0, passCharge: p.passChargeT || 0,
      })),
      ba: { x: R.conf.ball.x, y: R.conf.ball.y, z: R.conf.ball.z },
    });
    // Point the queued events at that same track entry, so when they finally fire
    // the positions they read are exactly the ones on screen. No extra copy.
    if (pendEv) {
      R.evQ.push({ t: R.conf.tick, ev: pendEv, st: { players: R.track[R.track.length - 1].pl } });
      if (R.evQ.length > 60) R.evQ.shift();
    }
    if (R.track.length > 90) R.track.shift();
  }
  // Am I still playing the same match as everyone else? Silent divergence is the
  // one failure mode rollback has that interpolation does not, so never assume.
  while (R.check.length && R.check[0][0] <= R.conf.tick) {
    const [tk, want] = R.check.shift();
    if (tk !== R.conf.tick) continue;
    NS.hashOk++;
    if (matchHash(R.conf) !== want) {
      NS.desync++; NS.hashOk--;
      // Ask for the truth. serializeState is lossless; the snapshot is not, so
      // there is no way to repair this from the data we already have.
      if (!R.syncPend) {
        R.syncPend = true;
        App.net.ws.send(JSON.stringify({ t: 'resync' }));
        console.warn(`[bopball] desync at tick ${tk}, requesting resync`);
      }
    }
  }
}
function rbFrame(dtReal, ctl, liveInp) {
  const R = App.net.rb;
  rbConsume(R);
  R.lastDt = clamp(dtReal, 0, 0.05);
  if (!R.ready) return null;
  // How far ahead of the server we run: enough to cover the trip there, so your
  // input lands on the tick you thought it would.
  const want = clamp(Math.round((NS.rtt / 2) / (DT * 1000)) + 1, RB_LEAD_MIN, RB_LEAD_MAX);
  if (R.show < 0) R.show = R.conf.tick + want;

  // The remote track gets its OWN clock rather than inheriting the prediction's.
  // Chaining it off the show clock stacked margin on margin — 63ms of it at every
  // latency, so even on localhost remote beans sat 83ms back when physics needed
  // 18. It only has to trail the newest confirmed tick by enough to always have
  // two samples to interpolate between. Convergence is done by nudging the
  // PLAYBACK RATE, never by moving the clock, because moving it is a jump.
  if (R.tclock < 0) R.tclock = R.conf.tick - RB_TRACK_BEHIND;
  const terr = (R.conf.tick - RB_TRACK_BEHIND) - R.tclock;
  if (Math.abs(terr) > 10) R.tclock = R.conf.tick - RB_TRACK_BEHIND;   // hopeless: reset
  else R.tclock += dtReal * TICK_RATE * clamp(1 + terr * 0.06, 0.9, 1.1);
  // Never let it outrun the data. Past the newest confirmed tick the lookup
  // clamps and every remote bean freezes on the last sample until the clock
  // drifts back — a stall dressed up as smoothness. Caught by the harness, which
  // runs frames faster than real time and reproduced it immediately.
  if (R.tclock > R.conf.tick - 0.5) R.tclock = R.conf.tick - 0.5;
  NS.offset = (R.show + clamp(R.acc / DT, 0, 1) - R.tclock) * DT * 1000;

  R.acc += dtReal;
  let guard = 0;
  while (R.acc >= DT && guard++ < 6) {
    R.acc -= DT;
    // The presentation tick advances on the FRAME clock, once per tick, always.
    // Rebuilding as conf+lead instead meant the world moved whenever a packet
    // landed — two ticks at a time, thirty times a second, frozen in between.
    // The network's burstiness is absorbed by how DEEP we predict, not by how
    // fast the world moves. Nudge by one tick at a time when we drift out of
    // band, so the clock corrects without anyone seeing a jump.
    const behind = R.show - R.conf.tick;
    if (behind > want + 3) { /* too far ahead: hold this tick and let conf catch up */ }
    else if (behind < want - 3) { R.show += 2; }
    else R.show++;
    const n = clamp(R.show - R.conf.tick, 0, RB_LEAD_MAX);
    NS.lead = n; R.n = n;
    // Constant, and only nudged when the target itself moves, so the remote
    // track keeps advancing at exactly one tick per tick.
    // Spend queued events at the moment the track actually shows them.
    const at = R.tclock;
    while (R.evQ.length && R.evQ[0].t <= at) {
      const e = R.evQ.shift();
      handleEvents(e.ev, e.st);
    }
    R.prev = R.cur;
    // Re-simulate the predicted window from scratch: cheap for ten beans, and it
    // means a late input never leaves a stale world behind.
    const s = cloneState(R.conf);
    for (let k = 0; k < n; k++) {
      const inputs = R.last.slice();
      if (ctl >= 0) inputs[ctl] = liveInp;      // your bean, live, no round trip
      s.events.length = 0;
      step(s, inputs);
    }
    // Remote beans run on a guess — their last input repeated until the real one
    // lands. When the guess was wrong their position steps. Absorb the step into
    // a decaying offset so it reads as a slight drift instead of a pop. Only past
    // a threshold, so ordinary motion is never touched, and never for your own
    // bean, which is exact by construction.
    // No correction smoothing here any more: remote beans are no longer drawn
    // from this prediction (see rbView), so there is nothing left to correct.
    R.cur = s;
  }
  return R;
}

// Sending input is NOT part of building a view, and keeping it inside netFrame
// meant the rollback path — which builds its view elsewhere and so never called
// netFrame — never sent a single input to the server. Nothing the player pressed
// left the machine and their bean could not move at all. Both paths call this.
function netSend(dtReal) {
  const N = App.net;
  if (!N || !N.ws) return;
  // send input at ~60Hz (was 30 — halves the worst-case input age)
  N.pingAcc = (N.pingAcc || 0) + dtReal;
  if (N.pingAcc > 0.5 && N.ws.readyState === 1) {
    N.pingAcc = 0;
    N.ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
  }
  // Subtract the interval, never zero it. Zeroing threw away the overshoot, which
  // made the send rate a function of the display (~48Hz on a 144Hz screen, and
  // 30Hz at exactly 60fps where dtReal never quite clears the threshold) AND made
  // the predictor's partial step a sawtooth: it advanced 6.9, 7.0, 2.8, 6.9, 7.0,
  // 2.8 ms, so every third frame moved 40% as far as its neighbours. Same mistake
  // as the server's tick loop had.
  N.sendAcc = (N.sendAcc || 0) + dtReal;
  if (N.sendAcc >= 1 / 60 && N.ws.readyState === 1) {
    N.sendAcc -= 1 / 60;
    if (N.sendAcc > 0.1) N.sendAcc = 0;        // long stall: don't burst-catch-up
    // aim origin = the bean we're actually driving (prediction, else last render)
    const cs = typeof N.ctl === 'number' ? N.ctl : N.slot;
    const seen = N.view && N.view.players && N.view.players[cs];
    const ox = N.pred ? N.pred.x : (seen ? seen.x : undefined);
    const oy = N.pred ? N.pred.y : (seen ? seen.y : undefined);
    // menu open over a live match: stand still rather than acting on menu keys
    const gxA = (N.slot < 5 ? 1 : -1) * (TUNE.pitchW / 2);   // the goal we're attacking
    const inp = App.menuOpen
      ? { mx: 0, my: 0, sprint: false, aHeld: false, bHeld: false, yHeld: false, lobHeld: false }
      : readHumanInput(ox, oy, gxA);
    // The tick this input was aimed at — the one remote beans are drawn at right
    // now. The server rewinds to it before judging contact, so a tackle lands
    // where you saw the target rather than where they had already moved on to.
    inp.vt = N.rb ? Math.round(N.rb.tclock) : 0;
    N.lastInp = inp;
    N.ws.send(JSON.stringify({ t: 'input', seq: ++N.seq, inp }));
    // Keep every input the server has not confirmed yet, to replay on top of the
    // last state it did confirm. Capped so a dead connection cannot grow it forever.
    (N.hist = N.hist || []).push({
      seq: N.seq, mx: inp.mx || 0, my: inp.my || 0, sprint: !!inp.sprint,
      charging: !!inp.bHeld, bhCharge: inp.aHeld ? (N.hist?.length ? (N.hist[N.hist.length - 1].bhCharge + 1) : 1) : 0,
    });
    if (N.hist.length > 90) N.hist.shift();
  }
}

function netFrame(dtReal) {
  const N = App.net;
  if (!N || !N.snaps || N.snaps.length === 0) return;
  // interpolate: render 80ms behind newest snapshot (30Hz snaps = 33ms spacing,
  // so this still keeps two in hand to interpolate between)
  const renderAt = performance.now() - NET_INTERP_MS;
  // How far the render clock sits behind the newest packet. Below zero means the
  // buffer is too thin and we are extrapolating off the end of it — the exact
  // moment remote beans start to stutter.
  NS.age = N.snaps[N.snaps.length - 1].rt - renderAt;
  let a = N.snaps[0], b = N.snaps[N.snaps.length - 1];
  for (let i = 0; i < N.snaps.length - 1; i++) {
    if (N.snaps[i].rt <= renderAt && N.snaps[i + 1].rt >= renderAt) { a = N.snaps[i]; b = N.snaps[i + 1]; break; }
  }
  const span = Math.max(b.rt - a.rt, 1);
  const f = clamp((renderAt - a.rt) / span, 0, 1);
  const pa = a.sn, pb = b.sn;
  const players = [];
  for (let i = 0; i < 10; i++) {
    const A = pa.pl[i], B = pb.pl[i];
    players.push({
      i, x: lerp(A[0], B[0], f), y: lerp(A[1], B[1], f), vx: B[2], vy: B[3],
      fx: lerp(A[4], B[4], f), fy: lerp(A[5], B[5], f),
      // stT drives every timed pose (leap, volley, keeper dive). Leaving it out
      // made those animations compute zero displacement — the jumps were happening
      // in the sim and rendering flat.
      // stT drives every timed pose. Taking it raw from the newer snapshot threw
      // away every other tick of animation progress — the sim animates at 60Hz
      // and snapshots arrive at 30 — so falls, dives, leaps and volleys played at
      // half their frames and short ones could disappear between two packets
      // entirely. You saw standing, then prone, with no fall in between. Advance
      // it smoothly whenever the state has not changed; a state change still
      // takes the new value, because you cannot be half way between two poses.
      st: B[6], stT: A[6] === B[6] ? lerp(A[7], B[7], f) : B[7],
      charging: B[8] > 0, chargeT: B[8], buff: B[9] > 0,
      bhCharge: B[10] || 0, passCharge: B[11] || 0,
      cele: pb.ph === 'goalcele' ? (((i < 5 ? 0 : 1) === (pb.ko === 0 ? 1 : 0)) ? 1 : -1) : 0,
    });
  }
  // Prediction for your own bean. The old version dead-reckoned at a hardcoded
  // 8.6 u/s with no acceleration and no stats, then dragged itself 12% per frame
  // toward the truth — a permanent tug-of-war between a wrong guess and the
  // server, which is what "skating" was. This replays your unacknowledged inputs
  // through the SAME moveStep the server runs, from the last state the server
  // confirmed. Right answer instead of a smoothed wrong one.
  const ctl = typeof N.ctl === 'number' ? N.ctl : N.slot;
  // Control follows the ball, so the bean you drive changes mid-match — the
  // predictor has to re-seed on handover or it replays your inputs onto the
  // position of whoever you just stopped driving.
  if (ctl !== N.predCtl) { N.predCtl = ctl; N.hist = []; N.perr = null; N.shownX = undefined; N.myStats = statsForSlot(ctl); }
  if (ctl >= 0 && App.predict !== false && N.hist) {
    const me = players[ctl];
    // Predict from the NEWEST snapshot, not the interpolation target. Everyone
    // else is rendered at now-minus-buffer; your own bean is rendered at now,
    // which is the entire point of predicting it. Basing it on the delayed
    // bracket while trimming history against the newest ack mixed two different
    // clocks, so the replay length oscillated and the bean buzzed.
    const newest = N.snaps[N.snaps.length - 1].sn;
    const auth = newest.pl[ctl];
    const ack = N.ackSeq ?? -1;
    while (N.hist.length && N.hist[0].seq <= ack) N.hist.shift();
    const sim = {
      x: auth[0], y: auth[1], vx: auth[2], vy: auth[3], fx: auth[4], fy: auth[5],
      st: auth[6], recT: auth[12] || 0, stats: N.myStats || { spd: 6 },
      charging: false, inMx: 0, inMy: 0, inSprint: false, bhChargeT: auth[10] || 0,
    };
    const carrying = newest.ba[3] === ctl;
    for (const h of N.hist) {
      sim.inMx = h.mx; sim.inMy = h.my; sim.inSprint = h.sprint;
      sim.charging = h.charging; sim.bhChargeT = h.bhCharge;
      if (moveStep(sim, carrying, DT)) { sim.x += sim.vx * DT; sim.y += sim.vy * DT; }
      if (sim.recT > 0) sim.recT--;
    }
    // History is whole ticks, so the replay lands on the last input boundary, not
    // on now. Carry the remainder so the convergence target below is where you
    // should actually be this instant rather than up to 16ms behind it.
    const partial = clamp(N.sendAcc || 0, 0, DT);
    if (partial > 0 && N.lastInp) {
      sim.inMx = N.lastInp.mx || 0; sim.inMy = N.lastInp.my || 0; sim.inSprint = !!N.lastInp.sprint;
      if (moveStep(sim, carrying, partial)) { sim.x += sim.vx * partial; sim.y += sim.vy * partial; }
    }
    // Absorb corrections instead of popping. Only when a NEW snapshot lands can
    // `sim` is exact but it is built from a discrete tick count against a base
    // that jumps two ticks every snapshot, so its RATE stutters at 30Hz even when
    // its value is right — the bean was correct but not moving at the same speed
    // as the rest of the scene. So don't render it. Render a state integrated at
    // real frame dt (the same clock everything else interpolates on) and use the
    // exact replay purely as the thing to converge on. Steady-state error is
    // ~0, so the correction is invisible; it only does work after a real
    // misprediction, and then it eases instead of snapping.
    // Seed a handover from what was ON SCREEN, not from the prediction. Until you
    // took this bean it was drawn as a remote — interpolated ~80ms in the past.
    // The moment it becomes yours it is drawn predicted, at now. Seeding straight
    // to the predicted position jumps it forward by the whole offset, which is
    // why grabbing a new player puts him somewhere the game did not have him.
    // Starting where he already was and letting the convergence below carry him
    // forward turns that pop into a short glide.
    if (!N.loc || N.locCtl !== ctl) {
      N.loc = { x: me.x, y: me.y, vx: me.vx, vy: me.vy, fx: me.fx, fy: me.fy };
      N.locCtl = ctl;
    }
    const L = N.loc;
    // Only norm/leap are predictable — moveStep declines everything else. During a
    // slide, deke, volley or knockdown the replay advances no position at all
    // while the real bean is moving fast, so rendering it meant a hard jump on
    // every packet. Fall back to the ordinary interpolation the other nine beans
    // already use: slightly behind, but perfectly smooth. Predict when we can,
    // interpolate when we can't, never render a raw snapshot.
    const authNorm = sim.st === 'norm' || sim.st === 'leap';
    const err = Math.hypot(sim.x - L.x, sim.y - L.y);
    if (!authNorm || err > 2) {
      L.x = me.x; L.y = me.y; L.vx = me.vx; L.vy = me.vy; L.fx = me.fx; L.fy = me.fy;
      NS.perr = err;
    } else {
      const cur = N.lastInp || {};
      L.st = 'norm'; L.recT = sim.recT; L.stats = sim.stats; L.charging = !!cur.bHeld;
      L.bhChargeT = sim.bhChargeT; L.inSprint = !!cur.sprint;
      L.inMx = cur.mx || 0; L.inMy = cur.my || 0;
      const dt = clamp(dtReal, 0, 0.05);
      if (moveStep(L, carrying, dt)) { L.x += L.vx * dt; L.y += L.vy * dt; }
      const c = 1 - Math.exp(-7 * dt);           // converge on the exact answer
      L.x += (sim.x - L.x) * c; L.y += (sim.y - L.y) * c;
      L.vx += (sim.vx - L.vx) * c; L.vy += (sim.vy - L.vy) * c;
    }
    NS.perr = err;
    me.x = L.x; me.y = L.y; me.vx = L.vx; me.vy = L.vy;
    if (L.fx || L.fy) { me.fx = L.fx; me.fy = L.fy; }
    // Velocity must come from the prediction too, or the walk cycle animates to a
    // stale server velocity while the body moves predicted — the feet slide.
    me.vx = sim.vx; me.vy = sim.vy;
    if (sim.fx || sim.fy) { me.fx = sim.fx; me.fy = sim.fy; }
  }
  N.view = {
    players,
    ball: { x: lerp(pa.ba[0], pb.ba[0], f), y: lerp(pa.ba[1], pb.ba[1], f), z: lerp(pa.ba[2], pb.ba[2], f),
      owner: pb.ba[3], shot: pb.ba[4] ?? -1, passTgt: pb.ba[5] ?? -1, threat: !!pb.ba[6] },
    score: pb.sc, clock: pb.ck, overtime: !!pb.ot, phase: pb.ph, phaseT: pb.phT, ctlSlot: ctl,
  };
}

// ============================================================================
// MENUS / SETUP UI
// ============================================================================
const SCREENS = ['screen-title', 'screen-setup', 'screen-online', 'screen-end', 'screen-help', 'screen-pause', 'screen-controls'];
function showScreen(id) {
  for (const s2 of SCREENS) $(s2).classList.toggle('hidden', s2 !== id);
}
function backToMenu() {
  App.mode = 'menu'; App.local = null; App.menuOpen = false;
  App.practice = false; practiceHUD(false);
  cele = null; endReplay(); replayBuf = []; pendingEv = [];
  presentSawCele = false; camBlend = 0; camBlendFrom = null;
  if (App.net?.ws) { try { App.net.ws.close(); } catch {} }
  App.net = null; App.cup = null;
  HUD.show(false); HUD.net('');
  disposeScene();
  showScreen('screen-title');
}

const Setup = {
  color: 0, sel: 0, startSlot: 0,
  lineup: [
    { arche: 'striker', traits: {} },
    { arche: 'speedster', traits: {} },
    { arche: 'playmaker', traits: {} },
    { arche: 'tank', traits: {} },
  ],
  save() {
    try { localStorage.setItem('bopball.team.v1', JSON.stringify({ color: this.color, lineup: this.lineup, startSlot: this.startSlot, name: $('teamName')?.value })); } catch (e) {}
  },
  load() {
    try {
      const d = JSON.parse(localStorage.getItem('bopball.team.v1') || 'null');
      if (!d) return;
      if (typeof d.color === 'number') this.color = d.color % 6;
      if (Array.isArray(d.lineup) && d.lineup.length === 4) {
        this.lineup = d.lineup.map(p => ({ arche: ARCHETYPES[p?.arche] ? p.arche : 'allround', traits: p?.traits || {} }));
      }
      if (typeof d.startSlot === 'number') this.startSlot = Math.min(3, Math.max(0, d.startSlot));
      if (d.name && $('teamName')) $('teamName').value = d.name;
    } catch (e) {}
  },
};

const SLOT_NAMES = ['CAPTAIN 👑', 'PLAYER 2', 'PLAYER 3', 'PLAYER 4'];
function buildSetupUI() {
  // colors
  const cr = $('colorRow'); cr.innerHTML = '';
  TEAM_COLORS.forEach((col, i) => {
    const dv = document.createElement('div');
    dv.className = 'swatch' + (i === Setup.color ? ' sel' : '');
    dv.style.background = col.css; dv.title = col.name;
    dv.onclick = () => { Setup.color = i; Setup.save(); buildSetupUI(); };
    cr.appendChild(dv);
  });
  // lineup slot chips
  const sr = $('slotRow'); sr.innerHTML = '';
  Setup.lineup.forEach((pl, i) => {
    const chip = document.createElement('div');
    chip.className = 'slotchip' + (i === Setup.sel ? ' sel' : '');
    chip.innerHTML = `${SLOT_NAMES[i]}<small>${ARCHETYPES[pl.arche].label}</small>`;
    chip.onclick = () => { Setup.sel = i; buildSetupUI(); };
    sr.appendChild(chip);
  });
  // archetype grid for the selected player
  const sel = Setup.lineup[Setup.sel];
  const grid = $('archeGrid'); grid.innerHTML = '';
  for (const key of Object.keys(ARCHETYPES)) {
    const a = ARCHETYPES[key];
    const d = document.createElement('div');
    d.className = 'arche' + (key === sel.arche ? ' sel' : '');
    d.innerHTML = `<b>${a.label}</b><small>${a.desc}</small>`;
    d.onclick = () => { sel.arche = key; sel.traits = {}; Setup.save(); buildSetupUI(); };
    grid.appendChild(d);
  }
  buildTraitUI($('traitPanel'), sel.arche, sel.traits, `${SLOT_NAMES[Setup.sel]} traits`);
  // start-as picker
  const ss = $('selStart'); ss.innerHTML = '';
  Setup.lineup.forEach((pl, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${SLOT_NAMES[i]} (${ARCHETYPES[pl.arche].label})`;
    ss.appendChild(o);
  });
  ss.value = Setup.startSlot;
  ss.onchange = () => { Setup.startSlot = parseInt(ss.value); Setup.save(); };
}

const STAT_LABELS = { spd: 'Speed', sho: 'Shot', hit: 'Hit', tkl: 'Tackle', pas: 'Passing' };
function buildTraitUI(el, arche, traits, title, onChange, locked = false) {
  const refresh = onChange || (() => { Setup.save(); buildSetupUI(); });
  el.innerHTML = '';
  const used = STAT_KEYS.reduce((a, k) => a + (traits[k] || 0), 0);
  const head = document.createElement('div');
  head.innerHTML = `<label class="lab">${title} — ${TRAIT_POINTS - used} pts left</label>`;
  el.appendChild(head);
  for (const k of STAT_KEYS) {
    const base = ARCHETYPES[arche][k], extra = traits[k] || 0;
    const row = document.createElement('div'); row.className = 'statrow';
    let pips = '';
    for (let i = 0; i < 10; i++) pips += `<span class="pip ${i < base + extra ? 'on' : ''}" ${i >= base && i < base + extra ? 'style="background:#ffd93b"' : ''}></span>`;
    row.innerHTML = `<span class="nm">${STAT_LABELS[k]}</span>${pips}`;
    const minus = document.createElement('button'); minus.className = 'mini'; minus.textContent = '−';
    minus.disabled = locked || extra <= 0;
    minus.onclick = () => { traits[k] = extra - 1; refresh(); };
    const plus = document.createElement('button'); plus.className = 'mini'; plus.textContent = '+';
    plus.disabled = locked || used >= TRAIT_POINTS || base + extra >= 10;
    plus.onclick = () => { traits[k] = extra + 1; refresh(); };
    row.appendChild(minus); row.appendChild(plus);
    el.appendChild(row);
  }
}

function playerTeamCfg() {
  Setup.save();
  return {
    name: ($('teamName').value || 'BOP UNITED').toUpperCase(),
    color: Setup.color,
    lineup: Setup.lineup.map(p => ({ arche: p.arche, traits: { ...p.traits } })),
  };
}
function randomOppCfg(excludeColor, tier) {
  const keys = Object.keys(ARCHETYPES);
  let color = (Math.random() * 6) | 0; if (color === excludeColor) color = (color + 1) % 6;
  return {
    name: OPP_NAMES[(Math.random() * OPP_NAMES.length) | 0],
    color,
    lineup: [0, 1, 2, 3].map(() => ({ arche: keys[(Math.random() * keys.length) | 0], traits: {} })),
  };
}

// ---------------------------------------------------------- controls UI ----
let _bindCapture = null;   // {action, kind:'kb'|'pad', el}
function buildControlsUI() {
  $('selScheme').value = Input.scheme;
  $('schemeHelp').textContent = Input.scheme === 'mouse'
    ? 'Mouse aim: WASD move · LMB pass (or click a teammate to switch to them) · RMB hold = charge, release = shoot at cursor · Space = deke / Big Hit · Q or middle-click = lob · Shift sprint. Gamepad still works any time.'
    : 'Classic: everything on keys/buttons, aiming follows your movement direction. Rebind anything below.';
  $('dzSlider').value = Input.deadzone; $('dzVal').textContent = Input.deadzone.toFixed(2);
  $('selVib').value = Input.vibration ? '1' : '0';
  const pct = v => `${Math.round(v * 100)}%`;
  const vs = $('volSlider'), cs2 = $('crowdSlider');
  vs.value = Vol.master; $('volVal').textContent = pct(Vol.master);
  cs2.value = Vol.crowd; $('crowdVal').textContent = pct(Vol.crowd);
  vs.oninput = () => { Vol.master = parseFloat(vs.value); $('volVal').textContent = pct(Vol.master); Vol.save(); Audio2.applyVolume(); };
  cs2.oninput = () => { Vol.crowd = parseFloat(cs2.value); $('crowdVal').textContent = pct(Vol.crowd); Vol.save(); Audio2.applyVolume(); };
  const list = $('bindList'); list.innerHTML = '';
  for (const a of ACTIONS) {
    const row = document.createElement('div'); row.className = 'bindrow';
    const kbNames = (Input.binds[a.id] || []).map(keyName).join(' / ') || '—';
    const padNames = (Input.gbinds[a.id] || []).map(i => PAD_NAMES[i] ?? i).join('/') || '—';
    row.innerHTML = `<span class="bn">${a.label}</span>`;
    const kbBtn = document.createElement('div'); kbBtn.className = 'bindkey'; kbBtn.textContent = kbNames;
    kbBtn.onclick = () => startBindCapture(a.id, 'kb', kbBtn);
    const padBtn = document.createElement('div'); padBtn.className = 'bindkey pad'; padBtn.textContent = '🎮 ' + padNames;
    padBtn.onclick = () => startBindCapture(a.id, 'pad', padBtn);
    row.appendChild(kbBtn); row.appendChild(padBtn);
    list.appendChild(row);
  }
}
function startBindCapture(action, kind, el) {
  cancelBindCapture();
  _bindCapture = { action, kind, el };
  el.classList.add('listening');
  el.textContent = kind === 'kb' ? 'press a key…' : 'press a pad button…';
  if (kind === 'pad') {
    const before = (activePad()?.buttons || []).map(b => b.pressed);
    _bindCapture.poll = setInterval(() => {
      const gp = activePad();
      if (!gp) return;
      for (let i = 0; i < gp.buttons.length; i++) {
        if (gp.buttons[i].pressed && !before[i]) {
          Input.gbinds[action] = [i]; Input.save(); cancelBindCapture(); buildControlsUI(); updateHint();
          return;
        }
        before[i] = gp.buttons[i].pressed;
      }
    }, 50);
    _bindCapture.timeout = setTimeout(() => { cancelBindCapture(); buildControlsUI(); }, 6000);
  }
}
function cancelBindCapture() {
  if (!_bindCapture) return;
  if (_bindCapture.poll) clearInterval(_bindCapture.poll);
  if (_bindCapture.timeout) clearTimeout(_bindCapture.timeout);
  _bindCapture.el.classList.remove('listening');
  _bindCapture = null;
}
addEventListener('keydown', e => {
  if (!_bindCapture || _bindCapture.kind !== 'kb') return;
  e.preventDefault(); e.stopPropagation();
  if (e.code !== 'Escape') { Input.binds[_bindCapture.action] = [e.code]; Input.save(); }
  cancelBindCapture(); buildControlsUI(); updateHint();
}, true);

function wireControlsScreen() {
  $('bControls1').onclick = () => { App._ctrlReturn = 'screen-title'; buildControlsUI(); showScreen('screen-controls'); };
  $('bControls2').onclick = () => { App._ctrlReturn = 'screen-pause'; buildControlsUI(); showScreen('screen-controls'); };
  $('bBack4').onclick = () => { cancelBindCapture(); showScreen(App._ctrlReturn || 'screen-title'); };
  $('selScheme').onchange = () => { Input.scheme = $('selScheme').value; Input.save(); buildControlsUI(); updateHint(); };
  $('dzSlider').oninput = () => { Input.deadzone = parseFloat($('dzSlider').value); $('dzVal').textContent = Input.deadzone.toFixed(2); Input.save(); };
  $('selVib').onchange = () => { Input.vibration = $('selVib').value === '1'; Input.save(); if (Input.vibration) padRumble(0.6, 0.6, 150); };
  $('bResetBinds').onclick = () => { Input.defaults(); Input.save(); buildControlsUI(); updateHint(); };
}

function wireMenus() {
  buildSetupUI();
  $('bPlay').onclick = () => { Audio2.ensure(); App.cup = null; showScreen('screen-setup'); };
  $('bCup').onclick = () => {
    Audio2.ensure();
    App.cup = { stage: 0, stages: [
      { name: 'WOBBLE ROVERS', diff: 'pro' },
      { name: 'GLOOP ATHLETIC', diff: 'superstar' },
      { name: 'THE FINAL BOSSES', diff: 'legend' },
    ]};
    showScreen('screen-setup');
    toast('CUP RUN: 3 rounds. Difficulty ramps. Good luck, bean.');
  };
  $('bTraining').onclick = () => {
    Audio2.ensure(); App.cup = null;
    const t0 = playerTeamCfg();
    startLocal({ teams: [t0, randomOppCfg(t0.color)], diff: 'rookie', timerLen: 300, weakGoalies: true, momentum: false });
    toast('Training: Rookie rivals, weak goalies. Mess around!');
  };
  if ($('bPractice')) $('bPractice').onclick = () => {
    Audio2.ensure(); App.cup = null;
    startPractice();
    toast('PRACTICE ARENA — R resets the ball, 1-5 change who is on the pitch, E = finesse');
  };
  $('bHelp').onclick = () => showScreen('screen-help');
  $('bBack1').onclick = $('bBack2').onclick = $('bBack3').onclick = () => showScreen('screen-title');
  $('bKickoff').onclick = () => {
    const t0 = playerTeamCfg();
    let diff = $('selDiff').value, oppName = null;
    if (App.cup) { diff = App.cup.stages[App.cup.stage].diff; oppName = App.cup.stages[App.cup.stage].name; }
    const opp = randomOppCfg(t0.color, diff); if (oppName) opp.name = oppName;
    startLocal({
      teams: [t0, opp], diff,
      timerLen: parseInt($('selTimer').value),
      weakGoalies: $('selWeakG').value === '1',
      momentum: $('selMomentum').value === '1',
      weather: $('selWeather') ? $('selWeather').value : 'random',
    });
  };
  $('bRematch').onclick = () => {
    if (App.cup === null && $('bRematch').textContent === 'MENU') { backToMenu(); return; }
    $('bKickoff').onclick();
  };
  $('bMenu').onclick = backToMenu;
  // online
  $('bOnline').onclick = () => { Audio2.ensure(); $('onServer').value = defaultServer(); showScreen('screen-online'); };
  $('bHost').onclick = () => {
    const t0 = playerTeamCfg();
    App.net = { snaps: [] };
    App.net.ws = netConnect($('onServer').value, () => {
      App.net.ws.send(JSON.stringify({
        t: 'host', name: $('onName').value || 'Bean',
        cfg: {
          teams: [t0, randomOppCfg(t0.color)],
          timerLen: parseInt($('selTimer').value || '180'),
          weather: $('selWeather') ? $('selWeather').value : 'random',
          weakGoalies: false, diff: 'pro',
        },
      }));
    });
  };
  $('bJoin').onclick = () => {
    App.net = { snaps: [] };
    App.net.ws = netConnect($('onServer').value, () => {
      App.net.ws.send(JSON.stringify({ t: 'join', code: ($('onCode').value || '').toUpperCase(), name: $('onName').value || 'Bean' }));
    });
  };
  $('bStart').onclick = () => App.net?.ws?.send(JSON.stringify({ t: 'start' }));
  // pause
  addEventListener('keydown', e => {
    if (e.code !== 'Escape') return;
    if (App.mode === 'local') {
      App.paused = !App.paused;
      $('pauseTitle').textContent = 'PAUSED';
      $('pauseNote').classList.add('hidden');
      showScreen(App.paused ? 'screen-pause' : null);
    } else if (App.mode === 'online') {
      // can't pause an authoritative shared match — open the menu over a live
      // game instead, and hold neutral input so menu keys don't reach the pitch
      App.menuOpen = !App.menuOpen;
      $('pauseTitle').textContent = 'MENU';
      $('pauseNote').classList.remove('hidden');
      showScreen(App.menuOpen ? 'screen-pause' : null);
    }
  });
  $('bResume').onclick = () => { App.paused = false; App.menuOpen = false; showScreen(null); };
  $('bQuit').onclick = () => { App.paused = false; App.menuOpen = false; backToMenu(); };
}

// ============================================================================
// BOOT
// ============================================================================
function boot() {
  const canvas = $('c');
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (e) {
    document.body.innerHTML = '<div style="padding:40px;font-weight:800;">WebGL is not available on this device/browser.</div>';
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    if (camera) { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  });
  Input.load();
  Setup.load();
  wireMenus();
  wireControlsScreen();
  wirePracticeKeys();
  updateHint();
  showScreen('screen-title');

  const q = new URLSearchParams(location.search);
  if (q.has('controls')) { buildControlsUI(); showScreen('screen-controls'); }
  // ?replaytest=1 — force an instant replay a few seconds in, to eyeball the cameras
  if (q.has('replaytest')) {
    setTimeout(() => startReplay(0, TUNE.pitchW / 2, performance.now() / 1000), 3000);
  }
  if (q.has('trailtest')) App.trailTest = true;
  if (q.has('netgraph')) App.netGraph = true;
  // Test driver: step the frame loop by hand on a fake clock. window.__frame(ms)
  // advances one frame; window.__frames(n, ms) runs a burst. Everything the
  // renderer and netcode do per frame becomes reachable from a script.
  if (q.has('harness')) {
    App.harness = true;
    let hnow = 0;
    window.__frame = (ms = 1000 / 60) => { hnow += ms; frame(hnow); return hnow; };
    window.__frames = (n = 60, ms = 1000 / 60) => { for (let i = 0; i < n; i++) { hnow += ms; frame(hnow); } return hnow; };
    window.__ns = NS;
  }
  if (q.get('predict') === '0') App.predict = false;   // A/B against raw interpolation
  // OFF by default, deliberately. The path the user actually played and rated as
  // close to right is the prediction one; rollback was made default on my
  // reasoning rather than on evidence, and it had never once been exercised
  // because it did not send input. Opt in with ?rollback=1 to test it; the
  // default stays on the path with a track record.
  App.rollback = q.get('rollback') === '1';
  if (q.has('setup')) { buildSetupUI(); showScreen('screen-setup'); }
  if (q.has('autohost') || q.has('autojoin')) {
    // headless netcode smoke test hooks
    const code = (q.get('autohost') || q.get('autojoin') || 'TEST1').toUpperCase();
    const hosting = q.has('autohost');
    const t0 = { name: 'NET PINK', color: 0, captain: { arche: 'striker', traits: {} }, sidekick: { arche: 'allround', traits: {} } };
    const t1 = { name: 'NET BLUE', color: 1, captain: { arche: 'enforcer', traits: {} }, sidekick: { arche: 'playmaker', traits: {} } };
    App.net = { snaps: [] };
    window.__app = App;
    App.net.ws = netConnect(defaultServer(), () => {
      if (hosting) {
        App.net.ws.send(JSON.stringify({ t: 'host', code, name: 'HostBean', cfg: { teams: [t0, t1], timerLen: 120, diff: 'pro' } }));
        setTimeout(() => App.net.ws.send(JSON.stringify({ t: 'start' })), 2500);
      } else {
        App.net.ws.send(JSON.stringify({ t: 'join', code, name: 'JoinBean' }));
      }
    });
    // wiggle inputs so the server sees movement
    setInterval(() => { keys.KeyD = !keys.KeyD; keys.KeyW = Math.random() < 0.5; }, 900);
  } else if (q.has('autotest')) {
    const seed = parseInt(q.get('seed') || '42');
    const t0 = { name: 'TEST PINK', color: 0, captain: { arche: 'striker', traits: {} }, sidekick: { arche: 'allround', traits: {} } };
    const t1 = { name: 'TEST BLUE', color: 1, captain: { arche: 'enforcer', traits: {} }, sidekick: { arche: 'playmaker', traits: {} } };
    startLocal({ teams: [t0, t1], diff: 'pro', timerLen: 120, weakGoalies: false, momentum: false, seed,
      weather: q.get('weather') || 'clear' });   // ?weather=rain etc. for visual checks
    window.__app = App;
    const ff = parseInt(q.get('ff') || '0');
    if (ff > 0) {
      const L = App.local;
      for (let i = 0; i < ff; i++) {
        step(L.state, autotestInputs(L));
        if (L.state.phase === 'over') break;
      }
    }
  }
  // keep a frame loop alive even in menus (cheap)
  if (!App.raf) { App.lastT = performance.now(); App.raf = requestAnimationFrame(frame); }
}
boot();
