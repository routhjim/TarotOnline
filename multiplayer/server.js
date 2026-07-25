/*
 * server.js — authoritative Taroky game server (Node + ws).
 *
 *   npm install
 *   npm start                       # listens on ws://localhost:8080
 *
 * Design:
 *  - The server holds the ONE true game state (via taroky-engine).
 *  - Clients never send state; they send ACTIONS. The server validates every
 *    action against the engine and rejects anything illegal or out of turn.
 *  - After each state change the server pushes each client a REDACTED view
 *    (viewFor) so a player only ever sees their own hand.
 *  - Empty seats are filled with bots; the server drives bot moves on a timer.
 *
 * This is a reference implementation: single process, in-memory rooms, no auth,
 * no persistence. For production add: auth/identity, reconnect tokens, a DB or
 * Redis for room state, rate limiting, and horizontal scaling (sticky rooms).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// The bundled web client (single self-contained HTML). Served at the root so
// players just visit the server URL in a browser — no file to download.
let CLIENT_HTML = '';
try { CLIENT_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'); } catch (e) { /* no client bundled; API-only */ }
const T = require('./taroky-engine');

// ---------- Elo ratings (persisted to disk) ----------
// Set RATINGS_FILE to a path on a mounted volume so ratings survive redeploys.
// If a Railway volume is mounted at /data it is used automatically.
const RATINGS_FILE = process.env.RATINGS_FILE || (fs.existsSync('/data') ? '/data/ratings.json' : path.join(__dirname, 'ratings.json'));
let ratings = {};                 // name -> { elo, deals, pwh?, salt? }  (pwh/salt = claimed-name protection)
try { ratings = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8')); } catch (e) { /* first run */ }
function hashPw(pw, salt) { return crypto.createHash('sha256').update(salt + '\u0000' + pw).digest('hex'); }
// Returns null if ok, or an error string. Claims the name if unprotected and a pw is offered.
function checkPlayerPw(name, pw) {
  name = ('' + (name || '')).trim();
  pw = ('' + (pw || '')).trim();
  if (!name) return null;
  const r = ratings[name];
  if (r && r.pwh) {
    if (!pw) return 'that name is password-protected \u2014 enter your player password';
    if (hashPw(pw, r.salt) !== r.pwh) return 'wrong player password for that name';
    return null;
  }
  if (pw) {  // claim: first player to set a password owns the name
    const entry = r || (ratings[name] = { elo: 1200, deals: 0 });
    entry.salt = crypto.randomBytes(8).toString('hex');
    entry.pwh = hashPw(pw, entry.salt);
    saveRatings();
  }
  return null;
}
let ratingsSaveT = null;
function saveRatings() {
  clearTimeout(ratingsSaveT);
  ratingsSaveT = setTimeout(() => { try { fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings)); } catch (e) { console.error('ratings save failed', e.message); } }, 300);
}
function eloOf(name) { return ratings[name] ? ratings[name].elo : 1200; }
function leaderboard() {
  return Object.keys(ratings)
    .filter((name) => ratings[name].deals > 0)
    .map((name) => ({ name, elo: Math.round(ratings[name].elo), deals: ratings[name].deals, locked: !!ratings[name].pwh }))
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 10);
}
// Rate one finished deal (per-hand: chip delta sign for THIS deal only, so a
// player is never penalized for a table's prior chip history). A player's
// "opponents" are the seats whose delta has the opposite sign (handles
// partnerships, solos, Žebrák). Bots are rated by their difficulty — beating
// Novice barely moves you; Insane sees every hand, so it prices like a master.
// Human opponents weigh more than bots: K scales from 16 (all-bot) to 32 (all-human).
// Bake-off-calibrated (chips/100-deal rates over ~1,500 randomized deals):
// novice -84, advanced +5, synthetic +8 (but +18 head-to-head vs advanced),
// hybrid +64 over the field — a ~200 Elo step over synthetic. Expert measured
// ~even with synthetic head-to-head; Insane sees every hand, so it prices like a master.
const BOT_ELO = { novice: 1000, advanced: 1300, synthetic: 1350, expert: 1400, hybrid: 1550, insane: 1900 };
function rateDeal(room, g) {
  const delta = g.result && g.result.delta;
  if (!delta) return;
  const botElo = (s) => BOT_ELO[(room.aiLevels && room.aiLevels[s]) || room.aiLevel] || 1000;
  const seatInfo = [0, 1, 2, 3].map((s) => {
    const human = !!(room.seats[s] || room.reserved[s]);
    return { human, name: room.names[s], d: delta[s], elo: human ? eloOf(room.names[s]) : botElo(s) };
  });
  if (!seatInfo.some((x) => x.human)) return;
  const changes = {};
  for (const me of seatInfo) {
    if (!me.human || me.d === 0) continue;
    const opps = seatInfo.filter((x) => x.d * me.d < 0);
    if (!opps.length) continue;
    const oppAvg = opps.reduce((t, x) => t + x.elo, 0) / opps.length;
    const expected = 1 / (1 + Math.pow(10, (oppAvg - me.elo) / 400));
    const score = me.d > 0 ? 1 : 0;
    const humanShare = opps.filter((x) => x.human).length / opps.length;
    const K = 16 + 16 * humanShare;   // PvP results move ratings twice as hard as bot farming
    changes[me.name] = (changes[me.name] || 0) + K * (score - expected);
  }
  let touched = false;
  for (const name in changes) {
    const r = ratings[name] || (ratings[name] = { elo: 1200, deals: 0 });
    r.elo = Math.round((r.elo + changes[name]) * 10) / 10;
    r.deals += 1;
    touched = true;
  }
  if (touched) { saveRatings(); broadcastTables(); }
}

const PORT = process.env.PORT || 8080;
const BOT_DELAY = 800;          // ms between bot moves (pacing)
const TRICK_PAUSE = 1600;       // ms to hold a completed 4-card trick on the table
const GRACE_MS = 120000;        // how long a disconnected player's seat is held for them
const AWAY_MOVE_DELAY = 10000;  // bot waits this long before moving for a briefly-disconnected player
const rooms = new Map();        // roomId -> Room

const AI_LEVELS = ['novice', 'advanced', 'synthetic', 'hybrid', 'expert', 'insane'];
function makeRoom(id, aiLevel, password, ais) {
  const base = AI_LEVELS.includes(aiLevel) ? aiLevel : 'novice';
  // per-seat bot levels: creator may pass ais[0..3]; missing/invalid entries fall back to the base level
  const aiLevels = [0, 1, 2, 3].map((s) => (ais && AI_LEVELS.includes(ais[s])) ? ais[s] : base);
  return {
    id,
    seats: [null, null, null, null], // ws or null (null => bot)
    names: ['North', 'East', 'South', 'West'],
    reserved: [null, null, null, null], // {token,name,timer} — seat held for a disconnected player
    aiLevel: base,
    aiLevels,
    password: ('' + (password || '')).trim().slice(0, 50) || null, // private table
    chat: [],                        // last 50 messages: {seat,name,text,ts}
    game: null,
    botTimer: null,
  };
}

// Drop a room only when nobody is connected AND nobody is expected back.
function cleanupRoom(room) {
  const humans = room.seats.filter(Boolean).length;
  const held = room.reserved.filter(Boolean).length;
  if (humans === 0 && held === 0) {
    clearTimeout(room.botTimer);
    rooms.delete(room.id);
  }
}

function broadcast(room) {
  room.lastActivity = Date.now();
  const g = room.game;
  // rate each deal exactly once, the moment it reaches scoring
  if (g && g.phase === 'scoring' && g._ratedDeal !== g.deal) { g._ratedDeal = g.deal; rateDeal(room, g); }
  for (let seat = 0; seat < 4; seat++) {
    const ws = room.seats[seat];
    if (ws && ws.readyState === ws.OPEN) send(ws, { type: 'state', view: T.viewFor(g, seat) });
  }
}
function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }

// Drive bots: whenever it's a bot seat's move, apply it after a short delay.
function pumpBots(room) {
  clearTimeout(room.botTimer);
  const g = room.game;
  if (!g || g.phase === 'scoring' || g.phase === 'idle') return;
  // tell the engine which seats are people: bots read a human forehand's opening
  // small-trump lead as a partner signal, but ignore the same lead from a bot
  g.humans = [0, 1, 2, 3].map((s) => !!(room.seats[s] || room.reserved[s]));
  // If a trick just completed, pause on it so players can see all four cards
  // before the next lead sweeps it away.
  let delay = BOT_DELAY;
  if (g.lastTrick && room.heldSeq !== g.lastTrick.seq) { room.heldSeq = g.lastTrick.seq; delay = TRICK_PAUSE; }
  for (let seat = 0; seat < 4; seat++) {
    const isBot = !room.seats[seat];
    if (!isBot) continue;
    if (room.aiLevels) g.aiLevel = room.aiLevels[seat];   // per-seat bot brains
    const action = T.aiAction(g, seat);
    if (action) {
      // If this seat belongs to a disconnected player, give them time to come
      // back before the bot plays their move for them.
      const d = room.reserved[seat] ? Math.max(delay, AWAY_MOVE_DELAY) : delay;
      room.botTimer = setTimeout(() => {
        if (room.seats[seat]) { pumpBots(room); return; }   // player came back — their move again
        const res = T.applyAction(g, seat, action);
        if (res.ok) { broadcast(room); pumpBots(room); }
      }, d);
      return; // one bot move at a time
    }
  }
}

function startHand(room) {
  T.newDeal(room.game);
  broadcast(room);
  pumpBots(room);
}

const server = http.createServer((req, res) => {
  // Serve the game client at the root (and /index.html). WebSocket upgrades are
  // handled separately by the WebSocketServer attached below.
  if (CLIENT_HTML && (req.url === '/' || req.url === '/index.html')) {
    // no-cache: browsers must revalidate so redeploys reach players immediately
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(CLIENT_HTML);
    return;
  }
  res.writeHead(CLIENT_HTML ? 404 : 200, { 'Content-Type': 'text/plain' });
  res.end(CLIENT_HTML ? 'Not found' : 'Taroky server is up. Connect a client over WebSocket (wss://this-host).');
});
const wss = new WebSocketServer({ server });

// --- lobby: track all connected sockets and broadcast the live table list ---
const sockets = new Set();
function tableList() {
  const out = [];
  for (const [id, room] of rooms) {
    const humans = room.seats.filter(Boolean).length + room.reserved.filter(Boolean).length;
    const uniform = room.aiLevels ? room.aiLevels.every((x) => x === room.aiLevels[0]) : true;
    if (humans > 0) out.push({ id, humans, ai: uniform ? room.aiLevel : 'mixed', locked: !!room.password });
  }
  return out;
}
function broadcastTables() {
  const tables = tableList();
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN && ws.meta && ws.meta.seat == null) send(ws, { type: 'tables', tables, leaderboard: leaderboard() });
  }
}

// Heartbeat: ping every 25s so half-dead sockets are detected quickly AND the
// hosting proxy (Railway et al.) never sees an idle connection to kill.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);

// ---------- watchdog sweeper ----------
// Every 60s: (1) reap seats held by sockets that died without a close event,
// (2) close tables that have had no connected human for 5+ minutes,
// (3) kick the bot pump on any live game that has sat idle too long (stalled timer).
const VACANT_CLOSE_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of [...rooms]) {
    // 1. dead-socket seats: treat as a disconnect (seat -> bot, no reservation to honor here;
    //    the normal close handler would have made one, so only truly zombie sockets hit this)
    let reaped = false;
    for (let s = 0; s < 4; s++) {
      const w = room.seats[s];
      if (w && w.readyState > 1) { room.seats[s] = null; reaped = true; }
    }
    const humans = room.seats.filter(Boolean).length;
    const held = room.reserved.filter(Boolean).length;
    if (humans === 0) {
      // 2. vacant too long (counting held seats as "maybe coming back" only within their grace)
      if (held === 0 || now - (room.lastHuman || room.lastActivity || 0) > VACANT_CLOSE_MS) {
        for (const r of room.reserved) if (r) clearTimeout(r.timer);
        clearTimeout(room.botTimer);
        rooms.delete(id);
        broadcastTables();
        continue;
      }
    } else {
      room.lastHuman = now;
    }
    // 3. stalled game: humans present, hand in progress, but nothing has moved for 90s
    const g = room.game;
    if (g && g.phase !== 'idle' && g.phase !== 'scoring' && now - (room.lastActivity || 0) > 90000) {
      pumpBots(room);
      room.lastActivity = now; // don't re-kick every sweep
    }
    if (reaped) { broadcast(room); pumpBots(room); broadcastTables(); }
  }
}, 60000);

wss.on('connection', (ws) => {
  ws.meta = { roomId: null, seat: null, token: null };
  ws.pwFails = 0;   // brute-force guard: too many wrong passwords -> drop the socket
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  sockets.add(ws);
  send(ws, { type: 'tables', tables: tableList(), leaderboard: leaderboard() });

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch (e) { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    sockets.delete(ws);
    const { roomId, seat, token } = ws.meta;
    const room = rooms.get(roomId);
    if (room && seat != null && room.seats[seat] === ws) {
      room.seats[seat] = null;
      // Hold the seat for GRACE_MS so a dropped connection can resume.
      if (token) {
        room.reserved[seat] = {
          token,
          name: room.names[seat],
          timer: setTimeout(() => {
            room.reserved[seat] = null;    // grace expired — seat becomes a normal bot
            cleanupRoom(room);
            broadcastTables();
          }, GRACE_MS),
        };
      }
      cleanupRoom(room);
      if (rooms.has(roomId) && room.game) { broadcast(room); pumpBots(room); }
    }
    broadcastTables();
  });
});

function handle(ws, msg) {
  switch (msg.type) {
    case 'join': {
      // { type:'join', roomId, name, seat? }
      const roomId = msg.roomId || 'lobby';
      let room = rooms.get(roomId);
      if (!room) { room = makeRoom(roomId, msg.ai, msg.password, msg.ais); rooms.set(roomId, room); } // creator picks AI level(s) + optional password
      let seat = -1;
      // Resume: a reconnect token matching a held seat puts the player right back (no password needed).
      if (msg.token) {
        for (let i = 0; i < 4; i++) {
          const r = room.reserved[i];
          if (r && r.token === msg.token && !room.seats[i]) {
            seat = i; clearTimeout(r.timer); room.reserved[i] = null; break;
          }
        }
      }
      // Claimed-name protection: a passworded player name can only be used with its password.
      const pwErr = checkPlayerPw(msg.name, msg.playerPw);
      if (pwErr) {
        if (++ws.pwFails >= 5) { try { ws.close(); } catch (e) {} return; }
        send(ws, { type: 'error', error: pwErr }); return;
      }
      // Private table: everyone except token-resumers must present the password.
      if (seat < 0 && room.password && ('' + (msg.password || '')).trim() !== room.password) {
        send(ws, { type: 'error', error: 'wrong password' });
        return;
      }
      // Name fallback: if their name matches a seat not occupied by a human (a bot
      // currently covering it), give them that seat back — covers expired tokens,
      // cleared storage, or rejoining from a different device. Case/space-insensitive.
      const norm = (x) => ('' + (x || '')).trim().toLowerCase();
      if (seat < 0 && norm(msg.name)) {
        for (let i = 0; i < 4; i++) {
          if (!room.seats[i] && norm(room.names[i]) === norm(msg.name)) {
            seat = i;
            if (room.reserved[i]) { clearTimeout(room.reserved[i].timer); room.reserved[i] = null; }
            break;
          }
        }
      }
      // Fresh join: requested-if-free, else first seat that is neither taken nor held.
      if (seat < 0) {
        seat = (msg.seat != null && !room.seats[msg.seat] && !room.reserved[msg.seat]) ? msg.seat
             : room.seats.findIndex((s, i) => !s && !room.reserved[i]);
      }
      if (seat < 0) { send(ws, { type: 'error', error: 'room full' }); return; }
      room.seats[seat] = ws;
      if (msg.name) room.names[seat] = msg.name;
      const token = msg.token || (Math.random().toString(36).slice(2) + Date.now().toString(36));
      ws.meta = { roomId, seat, token };
      send(ws, { type: 'joined', roomId, seat, seats: room.names, token });
      if (room.chat.length) send(ws, { type: 'chatHistory', messages: room.chat });
      if (!room.game) { room.game = T.createGame({ seats: room.names, aiLevel: room.aiLevel }); room.game.aiLabel = (room.aiLevels && !room.aiLevels.every((x) => x === room.aiLevels[0])) ? 'mixed' : room.aiLevel; }
      // reflect any updated name
      room.game.players[seat].name = room.names[seat];
      // Auto-deal the first hand as soon as someone joins an idle room
      // (empty seats play as bots). Clients may also send {type:'start'}.
      if (room.game.phase === 'idle') { startHand(room); }
      else { broadcast(room); pumpBots(room); }
      broadcastTables();
      break;
    }
    case 'chat': {
      const { roomId, seat } = ws.meta;
      const room = rooms.get(roomId);
      if (!room || seat == null) return;
      const text = ('' + (msg.text || '')).slice(0, 300).trim();
      if (!text) return;
      const entry = { seat, name: room.names[seat], text, ts: Date.now() };
      room.chat.push(entry); if (room.chat.length > 50) room.chat.shift();
      for (const c of room.seats) if (c && c.readyState === c.OPEN) send(c, { type: 'chat', message: entry });
      break;
    }
    case 'leave': {
      // Deliberate exit: vacate the seat (a bot covers it) but KEEP the player's
      // name on it, so the name-fallback in 'join' returns them to this seat if
      // they come back and it's still bot-covered. No reservation — others may take it.
      const { roomId, seat } = ws.meta;
      const room = rooms.get(roomId);
      if (room && seat != null && room.seats[seat] === ws) {
        room.seats[seat] = null;
        if (room.reserved[seat]) { clearTimeout(room.reserved[seat].timer); room.reserved[seat] = null; }
        cleanupRoom(room);
        if (rooms.has(roomId) && room.game) { broadcast(room); pumpBots(room); }
      }
      ws.meta = { roomId: null, seat: null, token: null };
      send(ws, { type: 'left' });
      send(ws, { type: 'tables', tables: tableList(), leaderboard: leaderboard() });
      broadcastTables();
      break;
    }
    case 'resetElo': {
      // { type:'resetElo', name, playerPw } — only the owner of a protected name may reset
      const name = ('' + (msg.name || '')).trim();
      const r = ratings[name];
      if (!r || !r.pwh) { send(ws, { type: 'error', error: 'only password-protected names can reset Elo' }); return; }
      if (hashPw(('' + (msg.playerPw || '')).trim(), r.salt) !== r.pwh) {
        if (++ws.pwFails >= 5) { try { ws.close(); } catch (e) {} return; }
        send(ws, { type: 'error', error: 'wrong player password' }); return;
      }
      r.elo = 1200; r.deals = 0;
      saveRatings();
      send(ws, { type: 'info', message: 'Elo reset to 1200 for ' + name });
      broadcastTables();
      send(ws, { type: 'tables', tables: tableList(), leaderboard: leaderboard() });
      break;
    }
    case 'adminUnlock': {
      // { type:'adminUnlock', name, adminKey } — forgot-password recovery, admin only.
      // Set an ADMIN_KEY env var on the server (Railway: service -> Variables). Removes the
      // password from a claimed name (Elo/deals kept) so its owner can re-claim with a new one.
      const key = process.env.ADMIN_KEY;
      if (!key || ('' + (msg.adminKey || '')) !== key) {
        if (++ws.pwFails >= 5) { try { ws.close(); } catch (e) {} return; }
        send(ws, { type: 'error', error: 'bad admin key' }); return;
      }
      const name = ('' + (msg.name || '')).trim();
      const r = ratings[name];
      if (!r || !r.pwh) { send(ws, { type: 'error', error: 'no protected entry for that name' }); return; }
      delete r.pwh; delete r.salt;
      saveRatings();
      send(ws, { type: 'info', message: 'Password removed for ' + name + ' — they can re-claim with a new one.' });
      break;
    }
    case 'list': {
      send(ws, { type: 'tables', tables: tableList(), leaderboard: leaderboard() });
      break;
    }
    case 'ping': {
      // app-level keepalive from browsers (some proxies only count real data frames)
      send(ws, { type: 'pong' });
      break;
    }
    case 'start': {
      // (re)deal a hand — any player in the room may start when idle/scoring
      const room = rooms.get(ws.meta.roomId);
      if (!room || !room.game) return;
      if (room.game.phase === 'idle' || room.game.phase === 'scoring') startHand(room);
      break;
    }
    case 'action': {
      // { type:'action', action:{...} }  — applied as the sender's seat
      const room = rooms.get(ws.meta.roomId);
      if (!room || !room.game) return;
      const seat = ws.meta.seat;
      const res = T.applyAction(room.game, seat, msg.action);
      if (!res.ok) { send(ws, { type: 'reject', error: res.error, action: msg.action }); return; }
      broadcast(room);
      pumpBots(room);
      break;
    }
    default:
      send(ws, { type: 'error', error: 'unknown message ' + msg.type });
  }
}

server.listen(PORT, () => console.log('Taroky server on ws://localhost:' + PORT));
