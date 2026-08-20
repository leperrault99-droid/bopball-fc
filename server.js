// ============================================================================
// BOPBALL FC — authoritative game server. ZERO dependencies:
// hand-rolled RFC6455 WebSocket over node:http + static file serving.
// Run:  node server.js   →  http://localhost:8470  (game) + ws on same port
// ============================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMatch, step, snapshot, encodeInput, decodeInput, matchHash, serializeState } from './sim.js';
import { DIFFICULTY, makeBrain, aiInputs } from './ai.js';

const PORT = process.env.PORT || 8470;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.md': 'text/markdown' };

// ------------------------------------------------------------- websocket ----
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function makeConn(sock) {
  const conn = {
    sock, alive: true, buf: Buffer.alloc(0),
    onmessage: null, onclose: null,
    send(obj) {
      if (!this.alive) return;
      try { sock.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch { this.close(); }
    },
    close() {
      if (!this.alive) return;
      this.alive = false;
      try { sock.end(Buffer.from([0x88, 0x00])); } catch {}
      if (this.onclose) this.onclose();
    },
  };
  sock.on('data', chunk => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    // parse frames
    for (;;) {
      const b = conn.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { conn.close(); return; }         // 1MB cap
      const maskOff = off, dataOff = off + (masked ? 4 : 0);
      if (b.length < dataOff + len) return;
      let data = b.subarray(dataOff, dataOff + len);
      if (masked) {
        const mask = b.subarray(maskOff, maskOff + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = data[i] ^ mask[i & 3];
        data = un;
      }
      conn.buf = b.subarray(dataOff + len);
      if (op === 8) { conn.close(); return; }
      if (op === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch {} continue; }
      if (op === 10) continue;
      if ((op === 1 || op === 2) && fin && conn.onmessage) {
        try { conn.onmessage(data.toString('utf8')); } catch (e) { /* bad msg */ }
      }
    }
  });
  sock.on('error', () => conn.close());
  sock.on('close', () => conn.close());
  return conn;
}

// ----------------------------------------------------------------- rooms ----
const rooms = new Map(); // code → room
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
// human-assignable field slots in preference order (captains first, balanced teams)
const SLOT_ORDER = [0, 5, 1, 6, 2, 7, 3, 8];
// the same 8 slots in display order (team 0 then team 1) — lobby rows line up with this
const FIELD = [0, 1, 2, 3, 5, 6, 7, 8];
const ACCENTS = 6;

// One editable roster per room covering every field bean, AI ones included.
function initRoster(cfg) {
  const r = new Array(10).fill(null);
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 4; i++) {
      const src = cfg.teams[t].lineup[i];
      r[t * 5 + i] = { arche: src.arche, traits: { ...src.traits }, accent: i % ACCENTS };
    }
  }
  return r;
}

function makeRoom(code, hostConn, hostName, cfg) {
  const room = {
    code, cfg: sanitizeCfg(cfg), started: false, over: false,
    clients: new Map(),         // conn → {name, slot}
    inputs: new Array(10).fill(null),
    state: null, brains: null, loop: null, evBuf: [], tickN: 0,
  };
  room.roster = initRoster(room.cfg);
  rooms.set(code, room);
  addClient(room, hostConn, hostName, true);
  return room;
}
const ARCHE_OK = new Set(['striker', 'enforcer', 'playmaker', 'allround', 'speedster', 'tank']);
// cosmetic only — the sim never reads it, but everyone must be shown the same sky
const WEATHER_OK = new Set(['random', 'clear', 'golden', 'overcast', 'rain', 'snow', 'night']);
const WEATHER_ROLL = ['clear', 'golden', 'overcast', 'rain', 'snow', 'night'];
function sanePlayer(p, fallbackArche) {
  const arche = ARCHE_OK.has(p?.arche) ? p.arche : fallbackArche;
  const traits = {}; let budget = 4;
  for (const k of ['spd', 'sho', 'hit', 'tkl', 'pas']) {
    let v = Math.max(0, Math.min(4, (p?.traits?.[k] | 0)));
    v = Math.min(v, budget); budget -= v;
    if (v) traits[k] = v;
  }
  return { arche, traits };
}
function sanitizeCfg(cfg) {
  const c = cfg || {};
  const team = (t, fallbackName) => ({
    name: String(t?.name || fallbackName).slice(0, 14).toUpperCase(),
    color: (t?.color | 0) % 6,
    lineup: [0, 1, 2, 3].map(i => sanePlayer(t?.lineup?.[i] ?? (i === 0 ? t?.captain : t?.sidekick),
      i === 0 ? 'striker' : 'allround')),
  });
  const teams = [team(c.teams?.[0], 'PINK POPPERS'), team(c.teams?.[1], 'BLUE BOMBERS')];
  if (teams[1].color === teams[0].color) teams[1].color = (teams[1].color + 1) % 6;
  return {
    teams,
    timerLen: Math.min(Math.max(parseInt(c.timerLen) || 180, 60), 900),
    weather: WEATHER_OK.has(c.weather) ? c.weather : 'random',
    weakGoalies: !!c.weakGoalies,
    diff: DIFFICULTY[c.diff] ? c.diff : 'pro',
  };
}
function addClient(room, conn, name, isHost) {
  // pick first free slot in preference order
  const taken = new Set([...room.clients.values()].map(c => c.slot));
  let slot = -1;
  for (const s of SLOT_ORDER) if (!taken.has(s)) { slot = s; break; }
  if (slot < 0) { conn.send({ t: 'err', msg: 'Room is full (8 players).' }); conn.close(); return false; }
  room.clients.set(conn, { name: String(name || 'Bean').slice(0, 12), slot, isHost: !!isHost, lastInp: null });
  conn.send({ t: isHost ? 'hosted' : 'joined', code: room.code, slot, cfg: room.cfg });
  broadcastLobby(room);
  if (room.started) {
    conn.send({ t: 'started', cfg: room.cfg });  // late joiner drops into the match
  }
  conn.onmessage = raw => handleMsg(room, conn, raw);
  conn.onclose = () => {
    room.clients.delete(conn);
    if (room.clients.size === 0) { destroyRoom(room); return; }
    broadcastLobby(room);
  };
  return true;
}
function destroyRoom(room) {
  if (room.loop) clearInterval(room.loop);
  rooms.delete(room.code);
  log(`room ${room.code} closed`);
}
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const conn of room.clients.keys()) conn.send(s);
}
function broadcastLobby(room) {
  const slots = new Array(10).fill(null);
  for (const c of room.clients.values()) slots[c.slot] = c.name;
  // present as 8 field slots (skip keepers 4 and 9)
  broadcast(room, {
    t: 'lobby',
    slots: FIELD.map(i => slots[i]),
    roster: FIELD.map(i => room.roster[i]),
    timerLen: room.cfg.timerLen,
    weather: room.cfg.weather,
  });
}

function handleMsg(room, conn, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  const me = room.clients.get(conn);
  if (!me) return;
  // Straight echo, off the snapshot path so measuring costs the broadcast nothing.
  if (msg.t === 'ping') { conn.send(JSON.stringify({ t: 'pong', ts: msg.ts })); return; }
  // Only ship the rollback input stream if somebody is actually replaying it.
  if (msg.t === 'rb') { me.wantsRb = !!msg.on; room.wantInputs = [...room.clients.values()].some(c => c.wantsRb); return; }
  // A desynced client asks for the truth. Rate-limited: recovery is a few KB and
  // a client that is broken enough to ask twice a second is broken for good.
  if (msg.t === 'resync' && room.started && room.state) {
    const now = Date.now();
    if (!me.lastSync || now - me.lastSync > 1000) {
      me.lastSync = now;
      conn.send(JSON.stringify({ t: 'sync', tick: room.state.tick, st: serializeState(room.state) }));
      log(`room ${room.code}: resync sent to ${me.name} at tick ${room.state.tick}`);
    }
    return;
  }
  if (msg.t === 'input' && room.started && !room.over) {
    const i = msg.inp || {};
    // Latch the momentary buttons. Input arrives at ~60Hz and the tick loop reads
    // only the newest message, so a quick tap that lands between two ticks used to
    // be overwritten and lost outright — the press simply never happened.
    if (i.aHeld) me.aLatch = true;
    if (i.yHeld) me.yLatch = true;
    if (i.bHeld) me.bLatch = true;
    if (i.lobHeld) me.lobLatch = true;
    me.lastInp = {
      mx: clampNum(i.mx), my: clampNum(i.my),
      ax: typeof i.ax === 'number' ? clampNum(i.ax) : undefined,
      ay: typeof i.ay === 'number' ? clampNum(i.ay) : undefined,
      sprint: !!i.sprint, aHeld: !!i.aHeld, bHeld: !!i.bHeld, yHeld: !!i.yHeld, lobHeld: !!i.lobHeld,
    };
    me.pendSeq = msg.seq | 0;              // newest input received, acked once consumed
    me.inCount = (me.inCount || 0) + 1;
  } else if (msg.t === 'weather' && me.isHost && !room.started) {
    room.cfg = { ...room.cfg, weather: WEATHER_OK.has(msg.w) ? msg.w : 'random' };
    broadcastLobby(room);
  } else if (msg.t === 'timer' && me.isHost && !room.started) {
    room.cfg = { ...room.cfg, timerLen: Math.min(Math.max(parseInt(msg.sec) || 180, 60), 900) };
    broadcastLobby(room);
  } else if (msg.t === 'roster' && !room.started) {
    // build any bean on your own side, AI ones included; the host may set both sides
    const slot = msg.slot | 0;
    if (!FIELD.includes(slot)) return;
    const myTeam = me.slot < 5 ? 0 : 1, tgtTeam = slot < 5 ? 0 : 1;
    if (tgtTeam !== myTeam && !me.isHost) return;
    const seated = [...room.clients.values()].find(c => c.slot === slot);
    if (seated && seated !== me) return;             // hands off someone else's bean
    const p = sanePlayer(msg, 'allround');
    room.roster[slot] = { arche: p.arche, traits: p.traits, accent: Math.max(0, Math.min(ACCENTS - 1, msg.accent | 0)) };
    broadcastLobby(room);
  } else if (msg.t === 'slot' && !room.started) {
    // lobby seat picker: claim any free field slot (either team)
    const want = msg.slot | 0;
    if (!SLOT_ORDER.includes(want)) return;
    for (const c of room.clients.values()) if (c.slot === want) return;   // already taken
    me.slot = want;
    conn.send({ t: 'slotset', slot: want });
    broadcastLobby(room);
  } else if (msg.t === 'start' && me.isHost && (!room.started || room.over)) {
    startMatch(room);
  }
}
function clampNum(v) { v = +v || 0; return v < -1 ? -1 : v > 1 ? 1 : v; }

const TICK_MS = 1000 / 60;
const MAX_CATCHUP = 250;   // ms of backlog we'll replay after a stall (else death spiral)
const MAX_STEPS = 8;       // sim ticks per timer fire

// Which bean each human drives this tick. Mirrors single player: control follows
// whoever on your team has the ball, and the pass button switches to the nearest
// team-mate while defending. Your seat (c.slot) only fixes your team.
//
// A bean driven by another human is NEVER available — not to switch onto, and not
// to be auto-followed onto. The old version tracked claims as it iterated, so a
// human processed earlier could switch onto a team-mate's bean and shunt that
// team-mate somewhere else. heldBy is kept live across every reassignment instead.
function resolveControl(room) {
  const s = room.state, b = s.ball;
  const list = [...room.clients.values()];
  for (const c of list) if (typeof c.ctl !== 'number' || c.ctl < 0) c.ctl = c.slot;
  const teamOf = c => (c.slot < 5 ? 0 : 1);

  const heldBy = new Map();                       // bean index -> the human on it
  for (const c of list) heldBy.set(c.ctl, c);
  const free = (c, i) => !heldBy.has(i) || heldBy.get(i) === c;
  const assign = (c, i) => {
    if (c.ctl === i) return;
    if (heldBy.get(c.ctl) === c) heldBy.delete(c.ctl);
    c.ctl = i; heldBy.set(i, c);
  };

  // auto-follow: if a field bean on your team has the ball and no human is already
  // driving it, the nearest team-mate takes it over
  const carrier = (b.owner >= 0 && !s.players[b.owner].keeper) ? b.owner : -1;
  const carrierTeam = carrier >= 0 ? s.players[carrier].team : -1;
  if (carrier >= 0 && !heldBy.has(carrier)) {
    let pick = null, pd = Infinity;
    for (const c of list) {
      if (teamOf(c) !== carrierTeam) continue;
      const cur = s.players[c.ctl];
      const d = cur ? Math.hypot(cur.x - s.players[carrier].x, cur.y - s.players[carrier].y) : Infinity;
      if (d < pd) { pd = d; pick = c; }
    }
    if (pick) assign(pick, carrier);
  }

  for (const c of list) {
    const aHeld = !!(c.lastInp && c.lastInp.aHeld);
    const switchEdge = aHeld && !c.prevA;
    c.prevA = aHeld;
    if (heldBy.get(carrier) === c) continue;      // on the ball: the button passes instead
    const team = teamOf(c);
    // Off the ball you may cycle at will, including while a team-mate is carrying.
    // Candidates are ordered nearest-the-ball first, and each press steps one along
    // that order — so the first press grabs the obvious man and repeat presses walk
    // through the rest instead of re-picking the same one.
    if (switchEdge) {
      const opts = s.players
        .filter(p => p.team === team && !p.keeper && free(c, p.i))
        .sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y));
      if (opts.length) {
        const at = opts.findIndex(p => p.i === c.ctl);
        assign(c, opts[(at + 1) % opts.length].i);
      }
    }
  }
}

// One authoritative 60Hz tick: gather inputs, fill the empty slots with AI, step.
function serverTick(room, fillProf) {
  const s = room.state;
  const inputs = new Array(10).fill(null);
  const humanSlots = [new Set(), new Set()];
  resolveControl(room);
  for (const [conn, c] of room.clients) {
    const team = c.slot < 5 ? 0 : 1;
    humanSlots[team].add(c.ctl);
    const inp = c.lastInp ? { ...c.lastInp } : null;
    if (inp) {                                   // consume any press that landed between ticks
      inp.human = true;                          // only humans may skip a goal celebration
      if (c.aLatch) { inp.aHeld = true; c.aLatch = false; }
      if (c.yLatch) { inp.yHeld = true; c.yLatch = false; }
      // bHeld is shoot and slide — the most pressed button in the game — and it was
      // never latched, so any tap landing between two server ticks was dropped
      // outright. That is the press that does not register.
      if (c.bLatch) { inp.bHeld = true; c.bLatch = false; }
      if (c.lobLatch) { inp.lobHeld = true; c.lobLatch = false; }
    }
    if (inp && s.ball.owner === (team === 0 ? 4 : 9)) { inp.distA = inp.aHeld; inp.distB = inp.bHeld; }
    inputs[c.ctl] = inp;
    if (c.ctl !== c.sentCtl) { c.sentCtl = c.ctl; conn.send({ t: 'ctl', slot: c.ctl }); }
  }
  // Who is driving which bean, for everyone. Control follows the ball now, so the
  // seat a human joined in tells you nothing about which bean they're on.
  // Only broadcast when the assignment actually changes — it's rare.
  {
    const map = new Array(10).fill(null);
    for (const c of room.clients.values()) map[c.ctl] = c.name;
    const sig = map.join('|');
    if (sig !== room.ctlSig) { room.ctlSig = sig; broadcast(room, { t: 'ctlmap', m: map }); }
  }
  aiInputs(s, 0, fillProf, humanSlots[0], room.brains[0], inputs);
  aiInputs(s, 1, fillProf, humanSlots[1], room.brains[1], inputs);
  // Record the exact inputs this tick consumed BEFORE stepping. A rollback client
  // starts from the same seed and cfg and replays these, so its sim is the same
  // sim — that is what puts every bean on one clock instead of two.
  const enc = inputs.map(encodeInput);
  if (room.inpBuf) {
    if (room.inpFrom < 0) room.inpFrom = s.tick;
    // The AI draws from the sim's PRNG before we get here, and a rollback client
    // does not run the AI — so its stream would drift apart within two seconds no
    // matter how perfect the inputs are. Ship the authoritative PRNG with the
    // frame; one integer buys exact determinism. Measured: zero hash divergence
    // over 9000 ticks with it, first divergence at tick 93 without.
    room.inpBuf.push([s.rngState, enc]);
  }
  // Step with what we SEND, not with what we generated. The wire rounds mx/my to
  // 2dp, and stepping with full precision here would desync every client.
  step(s, enc.map(decodeInput));
  // This tick consumed whatever input had arrived, so that seq is now baked into
  // the authoritative state. Clients replay everything AFTER it on top.
  for (const c of room.clients.values()) if (c.pendSeq !== undefined) c.ackSeq = c.pendSeq;
  if (s.events.length) room.evBuf.push(...s.events);
  room.tickN++;
  if (room.tickN % 1200 === 0) {
    // name:inputsReceived@beanCurrentlyDriven
    const counts = [...room.clients.values()].map(c => `${c.name}:${c.inCount || 0}@${c.ctl}`).join(' ');
    log(`room ${room.code} tick ${room.tickN} clock ${s.clock.toFixed(0)} score ${s.score} inputs ${counts}`);
  }
}

function startMatch(room) {
  const prof = DIFFICULTY[room.cfg.diff];
  // every field bean comes from the lobby roster; carry accent + who's driving it
  // so clients can tell the beans apart and name the scorer
  const seatName = new Array(10).fill(null);
  for (const c of room.clients.values()) seatName[c.slot] = c.name;
  const teams = room.cfg.teams.map(t => ({ ...t, lineup: t.lineup.map(p => ({ ...p })) }));
  for (const slot of FIELD) {
    const r = room.roster[slot];
    if (!r) continue;
    teams[slot < 5 ? 0 : 1].lineup[slot % 5] = {
      arche: r.arche, traits: r.traits, accent: r.accent,
      name: seatName[slot] || `BOT ${(slot % 5) + 1}`,
      human: !!seatName[slot],
    };
  }
  // roll 'random' once here so every client draws the same weather
  const weather = room.cfg.weather === 'random'
    ? WEATHER_ROLL[crypto.randomInt(WEATHER_ROLL.length)]
    : room.cfg.weather;
  // seed and keeper reflex ride along in cfg so a rollback client can build the
  // identical match. Same seed + same inputs + deterministic sim = same world.
  const seed = crypto.randomInt(1 << 30);
  const kr = [prof.keeperReflex, prof.keeperReflex];
  room.cfg = { ...room.cfg, teams, weather, seed, kr };
  room.state = makeMatch({
    seed,
    timerLen: room.cfg.timerLen,
    teams,
    weakGoalies: room.cfg.weakGoalies,
    keeperReflex: kr,
  });
  room.brains = [makeBrain(0), makeBrain(1)];
  room.started = true; room.over = false; room.evBuf = []; room.tickN = 0;
  room.inpBuf = []; room.inpFrom = -1;
  for (const c of room.clients.values()) { c.ctl = c.slot; c.sentCtl = -1; c.prevA = false; }
  room.ctlSig = null;                       // force a fresh ctlmap on the first tick
  broadcast(room, { t: 'started', cfg: room.cfg });
  log(`room ${room.code}: match started, ${room.clients.size} humans`);
  if (room.loop) clearInterval(room.loop);
  // AI fill profile: server AI gets a mild reaction handicap vs humans (fairness)
  const fillProf = { ...prof, react: prof.react + 8 };
  // Fixed 60Hz via accumulator, NOT one sim tick per timer fire: OS timer
  // granularity is coarse (~15.6ms on Windows), so a naive setInterval(1000/60)
  // only lands ~37 ticks/sec and the whole match runs in slow motion. Step on
  // elapsed real time instead so the clock is right on every platform.
  room.acc = 0;
  room.lastT = Date.now();
  room.loop = setInterval(() => {
    const s = room.state;
    if (!s || s.phase === 'over') {
      if (!room.over) {
        room.over = true;
        broadcast(room, { t: 'snap', sn: snapshot(s), ev: [{ t: 'FULLTIME' }] });
        log(`room ${room.code}: full time ${s.score[0]}-${s.score[1]}`);
      }
      return;
    }
    const now = Date.now();
    room.acc = Math.min(room.acc + (now - room.lastT), MAX_CATCHUP);
    room.lastT = now;
    let snapDue = false, steps = 0;
    while (room.acc >= TICK_MS && steps < MAX_STEPS && s.phase !== 'over') {
      room.acc -= TICK_MS; steps++;
      serverTick(room, fillProf);
      // 60Hz snapshots. Remote beans and every timed animation are reconstructed
      // from these, so at 30 the client was inferring half of what it drew — the
      // skipped animation frames the user described. Paid for by no longer
      // shipping rollback input frames to clients that are not running rollback.
      snapDue = true;
    }
    if (snapDue) {
      // Acks go in the shared broadcast keyed by bean, so it stays one JSON.stringify
      // for the whole room rather than a per-client serialise.
      const ak = {};
      for (const c of room.clients.values()) if (c.ackSeq !== undefined) ak[c.ctl] = c.ackSeq;
      const msg = { t: 'snap', sn: snapshot(s), ev: room.evBuf, ak };
      if (room.wantInputs && room.inpBuf && room.inpBuf.length) {
        msg.if = room.inpFrom; msg.ip = room.inpBuf;
        // Truth marker: a rollback client that has simulated up to this tick must
        // arrive at this hash. If it does not, it is quietly playing a different
        // match and needs to be told rather than left to drift.
        msg.hk = s.tick; msg.h = matchHash(s);
        room.inpBuf = []; room.inpFrom = -1;
      }
      broadcast(room, msg);
      room.evBuf = [];
    }
  }, 4);
}

// ------------------------------------------------------------- http/boot ----
const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(DIR, path.normalize(p).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(DIR)) { res.writeHead(403); res.end(); return; }
  // Never serve dotfiles/dotdirs. This server gets pointed at the open internet
  // (tunnels, VPS), and /.git alone hands over the entire repo history.
  if (path.relative(DIR, file).split(/[\\/]/).some(seg => seg.startsWith('.'))) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    // No caching, ever. With no Cache-Control the browser heuristically caches
    // client.js / sim.js as ES modules, so a code change silently doesn't take and
    // you're testing an old build without knowing it. This server only ever serves
    // a live dev build, so caching buys nothing and costs real debugging time.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
  sock.setNoDelay(true);
  const conn = makeConn(sock);
  // first message decides: host or join
  conn.onmessage = raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'host') {
      let code = null;
      if (msg.code && /^[A-Z0-9]{4,6}$/.test(msg.code) && !rooms.has(msg.code)) code = msg.code; // dev/test override
      const room = makeRoom(code || newCode(), conn, msg.name, msg.cfg);
      log(`room ${room.code} hosted by ${msg.name || 'Bean'}`);
    } else if (msg.t === 'join') {
      const room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) { conn.send({ t: 'err', msg: 'No room with that code.' }); return; }
      addClient(room, conn, msg.name, false);
      log(`${msg.name || 'Bean'} joined room ${room.code}`);
    }
  };
});
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
server.listen(PORT, () => log(`BOPBALL FC server on http://localhost:${PORT}  (game + websocket)`));
