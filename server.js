// Same Brain? - test server (v0.2). No dependencies: plain Node (18+).
// State lives in memory and is also saved to a JSON file when the host has a writable disk.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GOOGLE_VERIFY = process.env.GOOGLE_VERIFY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');
const QUESTIONS = require('./questions.json').map((q, i) => ({ id: i, q: q.q, o: q.o }));
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const ROUNDS = 5;
const ANSWER_MS = 15000;
const REVEAL_MS = 3500;
const INVITE_MS = 30000;
const OFFLINE_GRACE_MS = 15000;
const FORGET_MS = 7 * 24 * 3600 * 1000;
const MAX_PLAYERS = 5000;

// Plans. Payment is not connected: in this build the plan is a test switch.
const PLANS = {
  free: { label: 'Free', price: 0, chatMs: 3 * 60000, friends: 1 },
  plus: { label: 'Plus', price: 3, chatMs: 10 * 60000, friends: 5 },
  max: { label: 'Unlimited', price: 8, chatMs: null, friends: null }
};
const AGES = ['18-24', '25-34', '35-44', '45+'];
const INTENTS = ['friends', 'dating', 'playing'];
const INTERESTS = ['Food', 'Music', 'Films', 'Sport', 'Travel', 'Gaming', 'Books', 'Hiking',
  'Cooking', 'Cars', 'Art', 'Tech', 'Pets', 'Coffee', 'Dancing', 'Beach'];

const ADJ = ['Sleepy', 'Dizzy', 'Sneaky', 'Turbo', 'Fancy', 'Grumpy', 'Wobbly', 'Cosmic', 'Crispy', 'Jumpy',
  'Salty', 'Fluffy', 'Mighty', 'Shy', 'Loud', 'Lucky', 'Spicy', 'Chill', 'Dramatic', 'Polite'];
const NOUN = [['Falafel', '🧆'], ['Penguin', '🐧'], ['Cactus', '🌵'], ['Otter', '🦦'], ['Mango', '🥭'],
  ['Octopus', '🐙'], ['Llama', '🦙'], ['Pickle', '🥒'], ['Waffle', '🧇'], ['Panda', '🐼'], ['Taco', '🌮'],
  ['Hedgehog', '🦔'], ['Koala', '🐨'], ['Pretzel', '🥨'], ['Flamingo', '🦩'], ['Dumpling', '🥟'],
  ['Sloth', '🦥'], ['Croissant', '🥐'], ['Owl', '🦉'], ['Avocado', '🥑']];
const COLORS = ['#FF5D5D', '#2FCFA8', '#6C8CFF', '#FF9F1C', '#C77DFF', '#FF7AB6'];
const REACTIONS = ['gg', 'ha', 'twin', 'how', 'again', 'bye'];
const CHAT_PRESETS = {
  hi: '👋 Hi there!', lol: '😂 That made me laugh', tell: '🤔 Tell me more',
  same: '🙌 Same here!', nice: '😊 Nice talking to you'
};
const VERDICTS = [
  'Total opposites. Scientists are baffled.',
  'One thing in common. It is a start.',
  'Some overlap. A shy Venn diagram.',
  'More alike than not. Suspicious.',
  'Nearly the same brain. Who copied who?',
  'SAME BRAIN. Separated at birth?'
];

const players = new Map(); // id -> player
const duels = new Map();
const chats = new Map();
const phones = new Map();  // phone hash -> player id
let reports = [];
let stats = { since: new Date().toISOString(), days: {}, events: [] };

const now = () => Date.now();
const rid = (n) => crypto.randomBytes(n).toString('hex');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const today = () => new Date().toISOString().slice(0, 10);

function bump(key, n) {
  const d = today();
  if (!stats.days[d]) stats.days[d] = {};
  stats.days[d][key] = (stats.days[d][key] || 0) + (n || 1);
}
function logEvent(type, detail) {
  stats.events.push({ at: now(), type, detail: detail || '' });
  if (stats.events.length > 300) stats.events.shift();
}

function makePlayer(bot) {
  const [noun, emoji] = pick(NOUN);
  return {
    id: rid(6), token: rid(16), name: pick(ADJ) + noun, emoji, color: pick(COLORS),
    lat: 0, lng: 0, radius: 10, points: 0, bot: !!bot,
    age: null, intent: null, interests: [],
    registered: false, phoneHash: null, pending: null, plan: 'free',
    friends: new Set(), waves: [], ans: {}, daily: { day: '', done: {} },
    streams: new Set(), offlineAt: now(), lastSeen: now(), lastMsgAt: 0,
    blocked: new Set(), duelId: null, chatId: null, invite: null, outgoing: null
  };
}

const isOnline = (p) => p.bot || p.streams.size > 0 || now() - p.offlineAt < OFFLINE_GRACE_MS;
const isBusy = (p) => !!(p.duelId || p.chatId);
const blockedEither = (a, b) => a.blocked.has(b.id) || b.blocked.has(a.id);

function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const distLabel = (d) => (d < 1 ? 'under 1 km' : 'about ' + Math.round(d) + ' km');
// Two players see each other only if each is inside the other's radius.
function inRange(a, b) { const d = distKm(a, b); return d <= a.radius && d <= b.radius; }
function canSee(a, b) { return a !== b && !b.bot && isOnline(b) && !blockedEither(a, b) && inRange(a, b); }

function card(p) {
  return { id: p.id, name: p.name, emoji: p.emoji, color: p.color, bot: p.bot, age: p.age, intent: p.intent, interests: p.interests };
}
function stableAngle(a, b) {
  return crypto.createHash('md5').update(a.id + b.id).digest().readUInt16BE(0) % 360; // decorative, not a bearing
}

// ---------- quiz helpers ----------
function dailyIds(day) {
  let seed = crypto.createHash('md5').update('samebrain' + day).digest().readUInt32BE(0);
  const ids = [];
  while (ids.length < ROUNDS) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const i = seed % QUESTIONS.length;
    if (!ids.includes(i)) ids.push(i);
  }
  return ids;
}
function dailyDone(p) { return p.daily.day === today() && Object.keys(p.daily.done).length >= ROUNDS; }
function similarity(a, b) {
  let common = 0, same = 0;
  for (const k in a.ans) if (k in b.ans) { common++; if (a.ans[k] === b.ans[k]) same++; }
  return common >= 3 ? Math.round((same / common) * 100) : null;
}

// ---------- message filter ----------
const NUMWORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g;
const CONTACT = /@|https?:|www\.|\.(com|net|org|me|io|co|app|ly|gg)\b|\bdot\s+(com|net)\b|\b(whats\s*app|wats\s*app|watsapp|telegram|insta|instagram|snapchat|facebook|fb|messenger|tik\s*tok|twitter|discord|viber|skype|linkedin|gmail|hotmail|yahoo|outlook|icloud|e-?mail|my number|phone number)\b/;
const EXPLICIT = /\b(sex|sexy|sexting|nude|nudes|naked|horny|porn|dick|pussy|boobs|fuck\w*|blowjob|hook\s?up)\b/;
function filterText(t) {
  const s = t.toLowerCase();
  if ((s.match(/[0-9٠-٩۰-۹]/g) || []).length >= 3) return 'Numbers cannot be shared here.';
  if ((s.match(NUMWORDS) || []).length >= 4) return 'Numbers cannot be shared here.';
  if (CONTACT.test(s)) return 'Links, emails and social accounts cannot be shared here.';
  if (EXPLICIT.test(s)) return 'Keep it friendly. That message was not sent.';
  return null;
}

// ---------- views ----------
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
    v.talk = p.id in d.talk ? d.talk[p.id] : null;
    v.chatLabel = opp ? chatLabel(chatMsFor(p, opp)) : '';
  }
  return v;
}

function chatMsFor(a, b) { // the longer plan covers both people
  const x = PLANS[a.plan].chatMs, y = PLANS[b.plan].chatMs;
  return x === null || y === null ? null : Math.max(x, y);
}
const chatLabel = (ms) => (ms === null ? 'no time limit' : Math.round(ms / 60000) + ' minutes');

function chatView(c, p) {
  const opp = players.get(c.a === p.id ? c.b : c.a);
  return {
    id: c.id, kind: c.kind, phase: c.phase, prompt: c.prompt,
    opp: opp ? card(opp) : { id: '', name: 'Someone', emoji: '👻', color: '#999', bot: false },
    msgs: c.msgs.map((m) => ({ mine: m.from === p.id, text: m.text })),
    msLeft: c.deadline === null ? null : Math.max(0, c.deadline - now()),
    canType: p.registered, myDecision: p.id in c.decide ? c.decide[p.id] : null, result: c.result
  };
}

function snapshot(p) {
  const nearby = [], like = [];
  const board = [{ name: p.name, emoji: p.emoji, color: p.color, points: p.points, me: true }];
  for (const o of players.values()) {
    if (o === p || o.bot || blockedEither(p, o) || !inRange(p, o)) continue;
    const d = distKm(p, o), online = isOnline(o);
    if (online) {
      nearby.push({
        ...card(o), points: o.points, busy: isBusy(o), dist: distLabel(d),
        ring: Math.min(4, Math.floor((d / p.radius) * 4) + 1), angle: stableAngle(p, o), _d: d
      });
    }
    if (o.points > 0) board.push({ name: o.name, emoji: o.emoji, color: o.color, points: o.points, me: false });
    if (p.intent && o.intent === p.intent) {
      const sim = similarity(p, o);
      if (sim !== null) {
        like.push({ ...card(o), sim, dist: distLabel(d), online, busy: isBusy(o), waved: o.waves.some((w) => w.from === p.id) });
      }
    }
  }
  nearby.sort((x, y) => x._d - y._d);
  nearby.forEach((n) => delete n._d);
  board.sort((x, y) => y.points - x.points);
  like.sort((x, y) => y.sim - x.sim);

  const ids = dailyIds(today());
  const done = p.daily.day === today() ? p.daily.done : {};
  const s = {
    me: {
      ...card(p), points: p.points, radius: p.radius, registered: p.registered, plan: p.plan,
      friendCap: PLANS[p.plan].friends, friendCount: p.friends.size, needsProfile: !p.intent, dailyDone: dailyDone(p)
    },
    nearby, board: board.slice(0, 10), like: like.slice(0, 10),
    waves: p.waves.map((w) => players.get(w.from)).filter((o) => o && !blockedEither(p, o))
      .map((o) => ({ ...card(o), online: isOnline(o), busy: isBusy(o), sim: similarity(p, o) })),
    friends: [...p.friends].map((id) => players.get(id)).filter(Boolean)
      .map((o) => ({ ...card(o), online: isOnline(o), busy: isBusy(o) })),
    daily: ids.map((i) => ({ id: i, text: QUESTIONS[i].q, options: QUESTIONS[i].o, mine: i in done ? done[i] : null })),
    plans: Object.keys(PLANS).map((k) => ({ key: k, ...PLANS[k] })),
    options: { ages: AGES, intents: INTENTS, interests: INTERESTS },
    invite: null, outgoing: null, duel: null, chat: null
  };
  if (p.invite && players.has(p.invite.from)) {
    s.invite = { from: card(players.get(p.invite.from)), kind: p.invite.kind, msLeft: Math.max(0, p.invite.expires - now()) };
  }
  if (p.outgoing && players.has(p.outgoing)) s.outgoing = card(players.get(p.outgoing));
  if (p.duelId && duels.has(p.duelId)) s.duel = duelView(duels.get(p.duelId), p);
  if (p.chatId && chats.has(p.chatId)) s.chat = chatView(chats.get(p.chatId), p);
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

// Clears invites in both directions before two players start something together.
function clearPending(a, b) {
  for (const p of [a, b]) {
    if (p.outgoing) { const t = players.get(p.outgoing); if (t && t.invite && t.invite.from === p.id) t.invite = null; }
    if (p.invite) {
      const f = players.get(p.invite.from);
      if (f && f.outgoing === p.id && f !== a && f !== b) { f.outgoing = null; toast(f, p.name + ' is busy now.'); }
    }
    p.outgoing = null; p.invite = null;
  }
}

// ---------- duels ----------
function startDuel(a, b) {
  clearPending(a, b);
  const pool = QUESTIONS.slice();
  const questions = [];
  for (let i = 0; i < ROUNDS; i++) questions.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const d = {
    id: rid(6), a: a.id, b: b.id, questions, idx: 0, phase: 'q', deadline: 0, timer: null,
    answers: questions.map(() => [null, null]), reactions: [], rematch: new Set(), left: new Set(),
    talk: {}, points: 0, practice: a.bot || b.bot
  };
  duels.set(d.id, d);
  a.duelId = b.duelId = d.id;
  bump(d.practice ? 'botGames' : 'games');
  if (!d.practice) logEvent('game', a.name + ' vs ' + b.name);
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
  const q = d.questions[d.idx];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.o.length) return 'Bad answer.';
  const slot = d.a === p.id ? 0 : 1;
  if (d.answers[d.idx][slot] !== null) return 'You already answered.';
  d.answers[d.idx][slot] = choice;
  if (!p.bot) p.ans[q.id] = choice; // feeds the "think like you" matching
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
  if (!d.practice) bump('gamesFinished');
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

function leaveDuel(p) {
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
}

function talkPrompt(d) {
  let same = null;
  for (let i = 0; i < ROUNDS; i++) {
    const [x, y] = d.answers[i], q = d.questions[i];
    if (x === null || y === null) continue;
    if (x !== y) return 'You disagreed on "' + q.q + '". Defend your answer.';
    if (!same) same = 'You both picked "' + q.o[x] + '" for "' + q.q + '". Explain yourselves.';
  }
  return same || 'You made it past the quiz. Say hello.';
}

// ---------- chats ----------
function startChat(a, b, kind, prompt) {
  clearPending(a, b);
  const ms = kind === 'friend' ? null : chatMsFor(a, b);
  const c = {
    id: rid(6), a: a.id, b: b.id, kind, prompt: prompt || '', msgs: [], phase: 'open',
    deadline: ms === null ? null : now() + ms, timer: null, decide: {}, result: null, left: new Set()
  };
  if (ms !== null) c.timer = setTimeout(() => { if (chats.get(c.id) === c && c.phase === 'open') closeChat(c); }, ms);
  chats.set(c.id, c);
  a.chatId = b.chatId = c.id;
  bump(kind === 'friend' ? 'friendChats' : 'matchChats');
  logEvent(kind === 'friend' ? 'friend chat' : 'match chat', a.name + ' and ' + b.name);
  pushAll();
}

function closeChat(c) { // an open chat ends: strangers decide about friendship, friends just finish
  clearTimeout(c.timer);
  const a = players.get(c.a), b = players.get(c.b);
  if (c.kind === 'friend' || !a || !b || a.friends.has(b.id)) { c.phase = 'closed'; c.result = 'ended'; }
  else c.phase = 'decide';
  pushAll();
}

function leaveChat(p) {
  const c = chats.get(p.chatId);
  p.chatId = null;
  if (!c) return;
  c.left.add(p.id);
  const opp = players.get(c.a === p.id ? c.b : c.a);
  if (!opp || c.left.has(opp.id)) { clearTimeout(c.timer); chats.delete(c.id); return; }
  if (c.phase !== 'closed') { clearTimeout(c.timer); c.phase = 'closed'; c.result = 'left'; }
}

function unfriend(a, b) { a.friends.delete(b.id); b.friends.delete(a.id); }
const friendsFull = (p) => PLANS[p.plan].friends !== null && p.friends.size >= PLANS[p.plan].friends;

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
const hashPhone = (digits) => crypto.createHash('sha256').update('sb-phone:' + digits).digest('hex');

// Returns an error string, a data object, or nothing.
function act(p, body) {
  const other = typeof body.who === 'string' ? players.get(body.who) : null;
  switch (body.type) {
    case 'loc':
      if (!setLoc(p, body.lat, body.lng)) return 'Bad location.';
      break;
    case 'radius':
      setRadius(p, body.km);
      break;

    case 'profile': {
      const ints = Array.isArray(body.interests) ? [...new Set(body.interests)].filter((x) => INTERESTS.includes(x)) : [];
      if (!AGES.includes(body.age) || !INTENTS.includes(body.intent) || ints.length !== 3) return 'Pick an age range, what you are here for, and three interests.';
      if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== p.name) {
        const name = body.name.trim().replace(/\s+/g, ' ');
        if (!p.registered) return 'Verify your phone to choose your own name.';
        if (!/^[\p{L} ]{2,14}$/u.test(name) || filterText(name)) return 'Names are 2 to 14 letters, no numbers or symbols.';
        p.name = name;
      }
      if (!p.intent) { bump('profiles'); logEvent('profile', p.name + ' is here for ' + body.intent); }
      p.age = body.age; p.intent = body.intent; p.interests = ints;
      break;
    }

    case 'daily': {
      const ids = dailyIds(today());
      if (!ids.includes(body.q)) return 'That question is not in today\'s five.';
      const q = QUESTIONS[body.q];
      if (!Number.isInteger(body.choice) || body.choice < 0 || body.choice >= q.o.length) return 'Bad answer.';
      if (p.daily.day !== today()) p.daily = { day: today(), done: {} };
      if (!(body.q in p.daily.done)) {
        p.daily.done[body.q] = body.choice;
        p.ans[body.q] = body.choice;
        if (dailyDone(p)) { bump('dailyQuizzes'); logEvent('daily quiz', p.name); }
      }
      break;
    }

    case 'wave':
      if (!other || other.bot || other === p || blockedEither(p, other) || !inRange(p, other)) return 'That player is not around.';
      if (!other.waves.some((w) => w.from === p.id)) {
        other.waves.push({ from: p.id, at: now() });
        if (other.waves.length > 20) other.waves.shift();
        bump('waves');
        toast(other, p.name + ' waved at you.');
      }
      break;
    case 'unwave':
      p.waves = p.waves.filter((w) => w.from !== body.who);
      break;

    case 'challenge':
      if (!other || !canSee(p, other)) return 'That player is not online nearby right now.';
      if (isBusy(p) || p.outgoing) return 'Finish what you started first.';
      if (isBusy(other)) return other.name + ' is busy right now.';
      if (other.invite) return other.name + ' already has an invite waiting.';
      other.invite = { from: p.id, expires: now() + INVITE_MS, kind: 'duel' };
      p.outgoing = other.id;
      break;
    case 'chatreq':
      if (!other || !p.friends.has(other.id) || !other.friends.has(p.id)) return 'You can only start a chat with a friend.';
      if (!isOnline(other)) return other.name + ' is offline.';
      if (isBusy(p) || p.outgoing) return 'Finish what you started first.';
      if (isBusy(other)) return other.name + ' is busy right now.';
      if (other.invite) return other.name + ' already has an invite waiting.';
      other.invite = { from: p.id, expires: now() + INVITE_MS, kind: 'chat' };
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
      const from = players.get(p.invite.from), kind = p.invite.kind;
      p.invite = null;
      if (from) from.outgoing = null;
      if (!from || !isOnline(from) || isBusy(from)) return 'That invite expired.';
      if (body.accept === true) {
        if (isBusy(p)) return 'You are busy right now.';
        if (kind === 'chat') startChat(from, p, 'friend', '');
        else startDuel(from, p);
      } else toast(from, p.name + ' passed this time.');
      break;
    }

    case 'bot': {
      if (isBusy(p)) return 'You are busy right now.';
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
      if (opp.bot) { endDuel(d); return act(p, { type: 'bot' }); }
      if (d.rematch.has(opp.id)) { endDuel(d); startDuel(p, opp); }
      break;
    }
    case 'talk': { // "Keep talking" after a game: the chat opens only if both say yes
      const d = duels.get(p.duelId);
      if (!d || d.phase !== 'done' || d.practice) return 'No game to continue.';
      const opp = players.get(d.a === p.id ? d.b : d.a);
      d.talk[p.id] = body.yes === true;
      if (opp && d.talk[p.id] && d.talk[opp.id] === true && !d.left.has(opp.id)) {
        const prompt = talkPrompt(d);
        endDuel(d);
        startChat(p, opp, 'match', prompt);
      }
      break;
    }
    case 'leave':
      leaveDuel(p);
      break;

    case 'say': {
      const c = chats.get(p.chatId);
      if (!c || c.phase !== 'open') return 'This chat is closed.';
      if (now() - p.lastMsgAt < 600) return 'Slow down a little.';
      let text;
      if (typeof body.preset === 'string' && CHAT_PRESETS[body.preset]) text = CHAT_PRESETS[body.preset];
      else {
        if (!p.registered) return 'Verify your phone to type your own messages.';
        if (typeof body.text !== 'string') return 'Empty message.';
        text = body.text.trim().slice(0, 200);
        if (!text) return 'Empty message.';
        const bad = filterText(text);
        if (bad) { bump('blockedMessages'); return bad; }
      }
      p.lastMsgAt = now();
      c.msgs.push({ from: p.id, text });
      if (c.msgs.length > 300) c.msgs.shift();
      bump('messages');
      break;
    }
    case 'endchat': {
      const c = chats.get(p.chatId);
      if (!c || c.phase !== 'open') return 'This chat is already closed.';
      closeChat(c);
      break;
    }
    case 'decide': {
      const c = chats.get(p.chatId);
      if (!c || c.phase !== 'decide') return 'Nothing to decide.';
      const opp = players.get(c.a === p.id ? c.b : c.a);
      if (body.add === true && friendsFull(p)) return 'Your friends list is full. Remove a friend or change plan on the Me tab.';
      c.decide[p.id] = body.add === true;
      if (!opp || body.add !== true) { c.phase = 'closed'; c.result = 'no'; }
      else if (c.decide[opp.id] === true) {
        c.phase = 'closed';
        if (friendsFull(opp) || friendsFull(p)) c.result = 'full';
        else {
          p.friends.add(opp.id); opp.friends.add(p.id);
          c.result = 'friends'; bump('friendships'); logEvent('new friends', p.name + ' and ' + opp.name);
        }
      }
      break;
    }
    case 'chatleave':
      leaveChat(p);
      break;
    case 'unfriend':
      if (other) unfriend(p, other);
      break;

    case 'reg_start': {
      const digits = String(body.phone || '').replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return 'Enter a full mobile number with country code.';
      p.pending = { hash: hashPhone(digits), code: String(1000 + crypto.randomInt(9000)), tries: 0 };
      pushAll();
      // TEST MODE: no SMS provider is connected, so the code is returned to the screen.
      return { testCode: p.pending.code };
    }
    case 'reg_verify': {
      if (!p.pending) return 'Ask for a code first.';
      if (++p.pending.tries > 5) { p.pending = null; return 'Too many tries. Ask for a new code.'; }
      if (String(body.code || '').trim() !== p.pending.code) return 'That code is not right.';
      const hash = p.pending.hash;
      p.pending = null;
      const existing = players.get(phones.get(hash));
      if (existing && existing !== p) { // this phone already has an account: hand it back
        existing.lat = p.lat; existing.lng = p.lng; existing.radius = p.radius;
        players.delete(p.id);
        pushAll();
        return { switchTo: { id: existing.id, token: existing.token } };
      }
      p.registered = true; p.phoneHash = hash; phones.set(hash, p.id);
      bump('registrations'); logEvent('registration', p.name);
      break;
    }
    case 'plan':
      if (!PLANS[body.plan]) return 'Unknown plan.';
      if (!p.registered) return 'Verify your phone first.';
      p.plan = body.plan;
      logEvent('plan (test switch)', p.name + ' -> ' + PLANS[p.plan].label);
      break;

    case 'block':
    case 'report':
      if (!other || other === p) return 'Player not found.';
      if (body.type === 'report') {
        reports.push({ at: new Date().toISOString(), by: p.name + ' (' + p.id + ')', about: other.name + ' (' + other.id + ')' });
        bump('reports'); logEvent('report', p.name + ' reported ' + other.name);
      }
      p.blocked.add(other.id);
      unfriend(p, other);
      p.waves = p.waves.filter((w) => w.from !== other.id);
      if (p.duelId && other.duelId === p.duelId) leaveDuel(p);
      if (p.chatId && other.chatId === p.chatId) leaveChat(p);
      if (p.invite && p.invite.from === other.id) { p.invite = null; other.outgoing = null; }
      break;
    default:
      return 'Unknown action.';
  }
  pushAll();
  return null;
}

// ---------- housekeeping + persistence ----------
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
      if (p.duelId) leaveDuel(p);
      if (p.chatId) leaveChat(p);
      if (p.outgoing) act(p, { type: 'cancel' });
      if (!p.registered && t - p.lastSeen > FORGET_MS) {
        for (const id of p.friends) { const f = players.get(id); if (f) f.friends.delete(p.id); }
        players.delete(p.id);
      }
    }
  }
  pushAll();
}, 5000).unref();

function save() {
  try {
    const list = [];
    for (const p of players.values()) {
      if (p.bot) continue;
      list.push({ ...p, streams: undefined, pending: null, invite: null, outgoing: null, duelId: null, chatId: null,
        friends: [...p.friends], blocked: [...p.blocked] });
    }
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ players: list, reports, stats }));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { /* no writable disk on this host: keep running from memory */ }
}
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const raw of data.players || []) {
      const p = Object.assign(makePlayer(false), raw);
      p.streams = new Set(); p.friends = new Set(raw.friends || []); p.blocked = new Set(raw.blocked || []);
      p.offlineAt = 0;
      players.set(p.id, p);
      if (p.phoneHash) phones.set(p.phoneHash, p.id);
    }
    reports = data.reports || [];
    if (data.stats && data.stats.days) stats = data.stats;
    console.log('Loaded ' + players.size + ' players from ' + DATA_FILE);
  } catch (e) { /* first start */ }
}
load();
setInterval(save, 30000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); });

// ---------- admin page ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STAT_COLS = [['visits', 'Visits'], ['crawlers', 'Search bots'], ['newPlayers', 'New players'], ['returns', 'Returning'],
  ['profiles', 'Profiles'], ['games', 'Games'], ['gamesFinished', 'Finished'], ['botGames', 'Bot games'], ['dailyQuizzes', 'Daily quiz'],
  ['waves', 'Waves'], ['matchChats', 'Match chats'], ['friendChats', 'Friend chats'], ['messages', 'Messages'],
  ['blockedMessages', 'Blocked msgs'], ['friendships', 'New friends'], ['registrations', 'Sign ups'], ['reports', 'Reports']];

function adminPage() {
  const humans = [...players.values()].filter((p) => !p.bot);
  const count = (f) => humans.filter(f).length;
  const tiles = [
    ['Online now', count(isOnline)], ['In a game', count((p) => p.duelId)], ['In a chat', count((p) => p.chatId)],
    ['Players known', humans.length], ['Phone verified', count((p) => p.registered)],
    ['Here for dating', count((p) => p.intent === 'dating')], ['Here for friends', count((p) => p.intent === 'friends')],
    ['Just playing', count((p) => p.intent === 'playing')],
    ['On Plus', count((p) => p.plan === 'plus')], ['On Unlimited', count((p) => p.plan === 'max')],
    ['Friendships', humans.reduce((n, p) => n + p.friends.size, 0) / 2]
  ];
  const days = Object.keys(stats.days).sort().reverse().slice(0, 30);
  const total = {};
  for (const d of Object.keys(stats.days)) for (const k in stats.days[d]) total[k] = (total[k] || 0) + stats.days[d][k];
  const row = (label, obj) => '<tr><th>' + esc(label) + '</th>' + STAT_COLS.map((c) => '<td>' + (obj[c[0]] || 0) + '</td>').join('') + '</tr>';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><meta http-equiv="refresh" content="30"><title>Same Brain? activity</title><style>' +
    'body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:#f6f4ee;color:#1d1a3a}h1{margin:0 0 4px}h2{margin:28px 0 8px;font-size:18px}' +
    '.muted{color:#666;font-size:14px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:14px}' +
    '.tile{background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px 12px}.tile b{display:block;font-size:26px;font-variant-numeric:tabular-nums}' +
    '.scroll{overflow-x:auto;background:#fff;border:1px solid #ddd;border-radius:10px}table{border-collapse:collapse;font-size:13px;width:100%}' +
    'th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}th:first-child,td.l{text-align:left}' +
    'thead th{background:#1d1a3a;color:#fff;position:sticky;top:0}tr.total th,tr.total td{font-weight:700;background:#fff3cf}' +
    '</style></head><body><h1>Same Brain? activity</h1>' +
    '<p class="muted">Counting since ' + esc(stats.since.slice(0, 16).replace('T', ' ')) + ' UTC. Days are UTC. This page refreshes every 30 seconds.</p>' +
    '<div class="tiles">' + tiles.map((t) => '<div class="tile"><b>' + t[1] + '</b>' + esc(t[0]) + '</div>').join('') + '</div>' +
    '<h2>Per day</h2><div class="scroll"><table><thead><tr><th>Day</th>' + STAT_COLS.map((c) => '<th>' + c[1] + '</th>').join('') + '</tr></thead><tbody>' +
    '<tr class="total">' + row('All time', total).slice(4) + days.map((d) => row(d, stats.days[d])).join('') + '</tbody></table></div>' +
    '<h2>Latest activity</h2><div class="scroll"><table><thead><tr><th>Time (UTC)</th><th style="text-align:left">What</th><th style="text-align:left">Who</th></tr></thead><tbody>' +
    (stats.events.slice(-100).reverse().map((e) => '<tr><th>' + new Date(e.at).toISOString().slice(5, 19).replace('T', ' ') + '</th><td class="l">' + esc(e.type) + '</td><td class="l">' + esc(e.detail) + '</td></tr>').join('') || '<tr><td class="l" colspan="3">Nothing yet.</td></tr>') +
    '</tbody></table></div>' +
    '<h2>Reports</h2><div class="scroll"><table><thead><tr><th>Time (UTC)</th><th style="text-align:left">Reported by</th><th style="text-align:left">About</th></tr></thead><tbody>' +
    (reports.slice(-100).reverse().map((r) => '<tr><th>' + esc(r.at.slice(0, 19).replace('T', ' ')) + '</th><td class="l">' + esc(r.by) + '</td><td class="l">' + esc(r.about) + '</td></tr>').join('') || '<tr><td class="l" colspan="3">No reports.</td></tr>') +
    '</tbody></table></div></body></html>';
}
function adminAllowed(req, url) {
  if (!ADMIN_KEY) return false;
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const same = (v) => typeof v === 'string' && crypto.timingSafeEqual(h(v), h(ADMIN_KEY));
  const cookie = /(?:^|;\s*)sbadmin=([^;]+)/.exec(req.headers.cookie || '');
  return same(url.searchParams.get('key')) || (cookie && same(decodeURIComponent(cookie[1])));
}

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
const siteUrl = (req) => (req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      bump(/bot|crawl|spider|slurp|preview|lighthouse|monitor/i.test(req.headers['user-agent'] || '') ? 'crawlers' : 'visits');
      let html = fs.readFileSync(INDEX_PATH, 'utf8').replace(/__SITE_URL__/g, siteUrl(req));
      html = html.replace('<!--GOOGLE_VERIFY-->', GOOGLE_VERIFY ? '<meta name="google-site-verification" content="' + esc(GOOGLE_VERIFY) + '">' : '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nSitemap: ' + siteUrl(req) + '/sitemap.xml\n');
    }
    if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + siteUrl(req) + '/</loc></url></urlset>\n');
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      if (!adminAllowed(req, url)) {
        res.writeHead(ADMIN_KEY ? 401 : 404, { 'Content-Type': 'text/plain' });
        return res.end(ADMIN_KEY ? 'Add ?key=YOUR_ADMIN_KEY to the address.' : 'The activity page is off. Set the ADMIN_KEY environment variable to turn it on.');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Set-Cookie': 'sbadmin=' + encodeURIComponent(ADMIN_KEY) + '; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=2592000' });
      return res.end(adminPage());
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readBody(req);
      if (!body || body.adult !== true) return json(res, 400, { error: 'You must confirm you are 18 or older.' });
      let p = auth(body.id, body.token);
      if (p) bump('returns');
      else {
        if (players.size >= MAX_PLAYERS) return json(res, 503, { error: 'The app is full. Try again later.' });
        p = makePlayer(false);
        bump('newPlayers'); logEvent('new player', p.name);
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
      const out = act(p, body);
      if (typeof out === 'string') return json(res, 400, { error: out });
      return json(res, 200, Object.assign({ ok: true }, out || {}));
    }
    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
  }
});

server.listen(PORT, () => console.log('Same Brain? running on port ' + PORT + (ADMIN_KEY ? '' : ' (activity page off: set ADMIN_KEY)')));
