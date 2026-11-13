// Same Brain? - test server. No dependencies: plain Node (18+).
// All state lives in memory, so it resets whenever the server restarts.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const QUESTIONS = require('./questions.json');
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const ROUNDS = 5;
const ANSWER_MS = 15000;
const REVEAL_MS = 3500;
const INVITE_MS = 30000;
const OFFLINE_GRACE_MS = 15000;
const FORGET_MS = 24 * 3600 * 1000;
const MAX_PLAYERS = 5000;

const ADJ = ['Sleepy', 'Dizzy', 'Sneaky', 'Turbo', 'Fancy', 'Grumpy', 'Wobbly', 'Cosmic', 'Crispy', 'Jumpy',
  'Salty', 'Fluffy', 'Mighty', 'Shy', 'Loud', 'Lucky', 'Spicy', 'Chill', 'Dramatic', 'Polite'];
const NOUN = [['Falafel', '🧆'], ['Penguin', '🐧'], ['Cactus', '🌵'], ['Otter', '🦦'], ['Mango', '🥭'],
  ['Octopus', '🐙'], ['Llama', '🦙'], ['Pickle', '🥒'], ['Waffle', '🧇'], ['Panda', '🐼'], ['Taco', '🌮'],
  ['Hedgehog', '🦔'], ['Koala', '🐨'], ['Pretzel', '🥨'], ['Flamingo', '🦩'], ['Dumpling', '🥟'],
  ['Sloth', '🦥'], ['Croissant', '🥐'], ['Owl', '🦉'], ['Avocado', '🥑']];
const COLORS = ['#FF5D5D', '#2FCFA8', '#6C8CFF', '#FF9F1C', '#C77DFF', '#FF7AB6'];
const REACTIONS = ['gg', 'ha', 'twin', 'how', 'again', 'bye'];
const VERDICTS = [
  'Total opposites. Scientists are baffled.',
  'One thing in common. It is a start.',
  'Some overlap. A shy Venn diagram.',
  'More alike than not. Suspicious.',
  'Nearly the same brain. Who copied who?',
  'SAME BRAIN. Separated at birth?'
];

const players = new Map(); // id -> player
const duels = new Map();   // id -> duel
const reports = [];

const now = () => Date.now();
const rid = (n) => crypto.randomBytes(n).toString('hex');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function makePlayer(bot) {
  const [noun, emoji] = pick(NOUN);
  return {
    id: rid(6), token: rid(16), name: pick(ADJ) + noun, emoji, color: pick(COLORS),
    lat: 0, lng: 0, radius: 10, points: 0, bot: !!bot,
    streams: new Set(), offlineAt: now(), lastSeen: now(),
    blocked: new Set(), duelId: null, invite: null, outgoing: null
  };
}

function isOnline(p) {
  return p.bot || p.streams.size > 0 || now() - p.offlineAt < OFFLINE_GRACE_MS;
}

function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Two players see each other only if each is inside the other's radius.
function inRange(a, b) {
  const d = distKm(a, b);
  return d <= a.radius && d <= b.radius;
}
function canSee(a, b) {
  return a !== b && !b.bot && isOnline(b) && !a.blocked.has(b.id) && !b.blocked.has(a.id) && inRange(a, b);
}

function card(p) { return { id: p.id, name: p.name, emoji: p.emoji, color: p.color, bot: p.bot }; }

function stableAngle(a, b) {
  const h = crypto.createHash('md5').update(a.id + b.id).digest();
  return h.readUInt16BE(0) % 360; // decorative only, not a real bearing
}

function duelView(d, p) {
  const meA = d.a === p.id;
  const opp = players.get(meA ? d.b : d.a);
  const mine = (i) => d.answers[i][meA ? 0 : 1];
  const theirs = (i) => d.answers[i][meA ? 1 : 0];
  const revealed = d.phase === 'q' ? d.idx : Math.min(d.idx + 1, ROUNDS);
  const marks = [];
  for (let i = 0; i < revealed; i++) marks.push(mine(i) !== null && mine(i) === theirs(i));
  const v = {
    id: d.id, phase: d.phase, idx: Math.min(d.idx, ROUNDS - 1), total: ROUNDS,
    opp: opp ? card(opp) : { id: '', name: 'Someone', emoji: '👻', color: '#999', bot: false },
    marks, msLeft: Math.max(0, d.deadline - now()), oppLeft: d.left.size > 0 && !d.left.has(p.id)
  };
  if (d.phase !== 'done') {
    const q = d.questions[d.idx];
    v.q = { text: q.q, options: q.o };
    v.mine = mine(d.idx);
    v.oppAnswered = theirs(d.idx) !== null;
    if (d.phase === 'r') v.theirs = theirs(d.idx);
  } else {
    const m = marks.filter(Boolean).length;
    v.final = { matches: m, pct: Math.round((m / ROUNDS) * 100), verdict: VERDICTS[m], points: d.points };
    v.reactions = d.reactions.map((r) => ({ mine: r.from === p.id, key: r.key }));
    v.rematch = { me: d.rematch.has(p.id), them: opp ? d.rematch.has(opp.id) : false };
  }
  return v;
}

function snapshot(p) {
  const nearby = [];
  const board = [{ name: p.name, emoji: p.emoji, color: p.color, points: p.points, me: true }];
  for (const o of players.values()) {
    if (o === p || o.bot) continue;
    if (canSee(p, o)) {
      const d = distKm(p, o);
      nearby.push({
        ...card(o), points: o.points, busy: !!o.duelId,
        dist: d < 1 ? 'under 1 km' : 'about ' + Math.round(d) + ' km',
        ring: Math.min(4, Math.floor((d / p.radius) * 4) + 1), angle: stableAngle(p, o), _d: d
      });
    }
    if (o.points > 0 && !p.blocked.has(o.id) && !o.blocked.has(p.id) && inRange(p, o)) {
      board.push({ name: o.name, emoji: o.emoji, color: o.color, points: o.points, me: false });
    }
  }
  nearby.sort((x, y) => x._d - y._d);
  nearby.forEach((n) => delete n._d);
  board.sort((x, y) => y.points - x.points);
  const s = {
    me: { ...card(p), points: p.points, radius: p.radius },
    nearby, board: board.slice(0, 10), invite: null, outgoing: null, duel: null
  };
  if (p.invite && players.has(p.invite.from)) {
    s.invite = { from: card(players.get(p.invite.from)), msLeft: Math.max(0, p.invite.expires - now()) };
  }
  if (p.outgoing && players.has(p.outgoing)) s.outgoing = card(players.get(p.outgoing));
  if (p.duelId && duels.has(p.duelId)) s.duel = duelView(duels.get(p.duelId), p);
  return s;
}

function sse(p, event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of p.streams) res.write(msg);
}
const toast = (p, text) => { if (p && !p.bot) sse(p, 'toast', { text }); };

let pushQueued = false;
function pushAll() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    for (const p of players.values()) if (p.streams.size) sse(p, 'state', snapshot(p));
  });
}

// ---------- duels ----------
function startDuel(a, b) {
  for (const p of [a, b]) {
    if (p.outgoing) { const t = players.get(p.outgoing); if (t && t.invite && t.invite.from === p.id) t.invite = null; }
    if (p.invite) {
      const f = players.get(p.invite.from);
      if (f && f.outgoing === p.id && f !== a && f !== b) { f.outgoing = null; toast(f, p.name + ' started another game.'); }
    }
    p.outgoing = null; p.invite = null;
  }
  const pool = QUESTIONS.slice();
  const questions = [];
  for (let i = 0; i < ROUNDS; i++) questions.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const d = {
    id: rid(6), a: a.id, b: b.id, questions, idx: 0, phase: 'q', deadline: 0, timer: null,
    answers: questions.map(() => [null, null]), reactions: [], rematch: new Set(), left: new Set(),
    points: 0, practice: a.bot || b.bot
  };
  duels.set(d.id, d);
  a.duelId = b.duelId = d.id;
  startQuestion(d);
}

function botOf(d) {
  const a = players.get(d.a), b = players.get(d.b);
  return a && a.bot ? a : b && b.bot ? b : null;
}

function startQuestion(d) {
  d.phase = 'q';
  d.deadline = now() + ANSWER_MS;
  clearTimeout(d.timer);
  d.timer = setTimeout(() => reveal(d), ANSWER_MS);
  const bot = botOf(d);
  if (bot) {
    const idx = d.idx;
    setTimeout(() => {
      if (duels.get(d.id) === d && d.phase === 'q' && d.idx === idx) {
        answer(bot, Math.floor(Math.random() * d.questions[idx].o.length));
      }
    }, 1500 + Math.random() * 3500);
  }
  pushAll();
}

function answer(p, choice) {
  const d = duels.get(p.duelId);
  if (!d || d.phase !== 'q') return 'That question is closed.';
  if (!Number.isInteger(choice) || choice < 0 || choice >= d.questions[d.idx].o.length) return 'Bad answer.';
  const slot = d.a === p.id ? 0 : 1;
  if (d.answers[d.idx][slot] !== null) return 'You already answered.';
  d.answers[d.idx][slot] = choice;
  if (d.answers[d.idx][0] !== null && d.answers[d.idx][1] !== null) reveal(d);
  else pushAll();
  return null;
}

function reveal(d) {
  if (duels.get(d.id) !== d || d.phase !== 'q') return;
  clearTimeout(d.timer);
  d.phase = 'r';
  d.deadline = now() + REVEAL_MS;
  d.timer = setTimeout(() => {
    if (d.idx + 1 >= ROUNDS) finish(d);
    else { d.idx++; startQuestion(d); }
  }, REVEAL_MS);
  pushAll();
}

function finish(d) {
  d.phase = 'done';
  d.deadline = now();
  const m = d.answers.filter((x) => x[0] !== null && x[0] === x[1]).length;
  d.points = d.practice ? 0 : 10 + m * 10; // practice rounds do not count
  for (const id of [d.a, d.b]) { const p = players.get(id); if (p) p.points += d.points; }
  const bot = botOf(d);
  if (bot) {
    setTimeout(() => {
      if (duels.get(d.id) === d) { d.reactions.push({ from: bot.id, key: m >= 3 ? 'twin' : 'how' }); pushAll(); }
    }, 1500);
  }
  pushAll();
}

function endDuel(d) {
  clearTimeout(d.timer);
  duels.delete(d.id);
  for (const id of [d.a, d.b]) {
    const p = players.get(id);
    if (!p) continue;
    if (p.duelId === d.id) p.duelId = null;
    if (p.bot) players.delete(p.id);
  }
}

function leave(p) {
  const d = duels.get(p.duelId);
  p.duelId = null;
  if (!d) return;
  const opp = players.get(d.a === p.id ? d.b : d.a);
  if (d.phase !== 'done') {
    if (opp) toast(opp, p.name + ' left the game.');
    endDuel(d);
  } else {
    d.left.add(p.id);
    if (!opp || opp.bot || d.left.has(opp.id)) endDuel(d);
  }
  pushAll();
}

// ---------- actions ----------
function setLoc(p, lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return false;
  // stored rounded to about 100 m; coordinates are never sent to other players
  p.lat = Math.round(lat * 1000) / 1000;
  p.lng = Math.round(lng * 1000) / 1000;
  return true;
}
function setRadius(p, km) {
  if (typeof km === 'number' && isFinite(km)) p.radius = Math.max(1, Math.min(50, Math.round(km)));
}

function act(p, body) {
  const other = typeof body.who === 'string' ? players.get(body.who) : null;
  switch (body.type) {
    case 'loc':
      if (!setLoc(p, body.lat, body.lng)) return 'Bad location.';
      break;
    case 'radius':
      setRadius(p, body.km);
      break;
    case 'challenge':
      if (!other || !canSee(p, other)) return 'That player is no longer nearby.';
      if (p.duelId || p.outgoing) return 'Finish what you started first.';
      if (other.duelId) return other.name + ' is in a game.';
      if (other.invite) return other.name + ' already has an invite waiting.';
      other.invite = { from: p.id, expires: now() + INVITE_MS };
      p.outgoing = other.id;
      break;
    case 'cancel': {
      const t = players.get(p.outgoing);
      if (t && t.invite && t.invite.from === p.id) t.invite = null;
      p.outgoing = null;
      break;
    }
    case 'respond': {
      if (!p.invite) return 'That invite expired.';
      const from = players.get(p.invite.from);
      p.invite = null;
      if (from) from.outgoing = null;
      if (!from || !isOnline(from) || from.duelId) return 'That invite expired.';
      if (body.accept === true) { if (p.duelId) return 'You are already in a game.'; startDuel(from, p); }
      else toast(from, p.name + ' passed this time.');
      break;
    }
    case 'bot': {
      if (p.duelId) return 'You are already in a game.';
      const bot = makePlayer(true);
      bot.name = 'Robo' + bot.name.replace(/^[A-Z][a-z]+/, '');
      bot.lat = p.lat; bot.lng = p.lng;
      players.set(bot.id, bot);
      startDuel(p, bot);
      break;
    }
    case 'answer':
      return answer(p, body.choice);
    case 'react': {
      const d = duels.get(p.duelId);
      if (!d || d.phase !== 'done' || !REACTIONS.includes(body.key)) return 'Cannot send that now.';
      if (d.reactions.filter((r) => r.from === p.id).length >= 3) return 'Three reactions per game.';
      d.reactions.push({ from: p.id, key: body.key });
      break;
    }
    case 'rematch': {
      const d = duels.get(p.duelId);
      if (!d || d.phase !== 'done') return 'No game to replay.';
      const opp = players.get(d.a === p.id ? d.b : d.a);
      if (!opp || d.left.has(opp.id)) return 'They already left.';
      d.rematch.add(p.id);
      if (opp.bot) {
        endDuel(d);
        return act(p, { type: 'bot' });
      }
      if (d.rematch.has(opp.id)) { endDuel(d); startDuel(p, opp); }
      break;
    }
    case 'leave':
      leave(p);
      break;
    case 'block':
    case 'report':
      if (!other || other === p) return 'Player not found.';
      if (body.type === 'report') {
        reports.push({ at: new Date().toISOString(), by: p.id, about: other.id });
        console.log('REPORT', JSON.stringify(reports[reports.length - 1]));
      }
      p.blocked.add(other.id);
      if (p.duelId && other.duelId === p.duelId) leave(p);
      if (p.invite && p.invite.from === other.id) { p.invite = null; other.outgoing = null; }
      break;
    default:
      return 'Unknown action.';
  }
  pushAll();
  return null;
}

// ---------- housekeeping ----------
setInterval(() => {
  const t = now();
  for (const p of [...players.values()]) {
    if (p.bot) continue;
    if (p.streams.size) p.lastSeen = t;
    if (p.invite && p.invite.expires < t) {
      const from = players.get(p.invite.from);
      if (from) { from.outgoing = null; toast(from, p.name + ' did not answer.'); }
      p.invite = null;
    }
    if (!isOnline(p)) {
      if (p.duelId) leave(p);
      if (p.outgoing) act(p, { type: 'cancel' });
      if (t - p.lastSeen > FORGET_MS) players.delete(p.id);
    }
  }
  pushAll();
}, 5000).unref();

// ---------- http ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function auth(id, token) {
  const p = typeof id === 'string' ? players.get(id) : null;
  return p && !p.bot && typeof token === 'string' && p.token === token ? p : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX_PATH));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, players: players.size });

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readBody(req);
      if (!body || body.adult !== true) return json(res, 400, { error: 'You must confirm you are 18 or older.' });
      let p = auth(body.id, body.token);
      if (!p) {
        if (players.size >= MAX_PLAYERS) return json(res, 503, { error: 'The game is full. Try again later.' });
        p = makePlayer(false);
      }
      if (!setLoc(p, body.lat, body.lng)) return json(res, 400, { error: 'Location is missing.' });
      setRadius(p, body.radius);
      p.offlineAt = now(); p.lastSeen = now();
      players.set(p.id, p);
      pushAll();
      return json(res, 200, { id: p.id, token: p.token });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const p = auth(url.searchParams.get('id'), url.searchParams.get('token'));
      if (!p) return json(res, 401, { error: 'Unknown player.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      p.streams.add(res);
      sse(p, 'state', snapshot(p));
      pushAll();
      req.on('close', () => { p.streams.delete(res); if (!p.streams.size) p.offlineAt = now(); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/act') {
      const body = await readBody(req);
      const p = body && auth(body.id, body.token);
      if (!p) return json(res, 401, { error: 'Unknown player.' });
      const err = act(p, body);
      return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
  }
});

server.listen(PORT, () => console.log('Same Brain? running on port ' + PORT));
