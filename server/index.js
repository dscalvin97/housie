import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  createGame, addPlayer, buyTickets, startGame, drawNext, finishGame,
  findPlayer, submitClaim, computeLedger, CLAIMABLE_PATTERNS,
} from './game.js';
import { saveGame, loadGame, allCodes } from './db.js';

const PORT = Number(process.env.PORT) || 3909;
const ROOT = fileURLToPath(new URL('../public', import.meta.url));

const games = new Map(); // code -> game object (live)
const timers = new Map(); // code -> interval
const clients = new Map(); // code -> Set<ws>

// ---- load persisted games that were in progress ----
for (const code of allCodes()) {
  const g = loadGame(code);
  if (g && g.status !== 'finished') games.set(code, g);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = url.pathname;
  if (path === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }

  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback for client routes like /#/join or deep links
    const html = join(ROOT, 'index.html');
    if (existsSync(html) && !extname(path)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(readFileSync(html));
    }
    res.writeHead(404); return res.end('not found');
  }
  const mime = MIME[extname(file)] || 'application/octet-stream';
  const cache = extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'content-type': mime, 'cache-control': cache });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server, path: '/ws' });

// ---- per-game broadcast + state shaping ----
function broadcast(game) {
  const set = clients.get(game.code);
  if (!set) return;
  const payload = JSON.stringify({ type: 'state', game: publicState(game) });
  for (const ws of set) if (ws.readyState === 1) ws.send(payload);
}

function publicState(game) {
  return {
    code: game.code,
    status: game.status,
    config: {
      ticketPrice: game.config.ticketPrice,
      drawIntervalSec: game.config.drawIntervalSec,
      penalty: game.config.penalty,
      patterns: CLAIMABLE_PATTERNS.map(id => ({
        id, enabled: game.config.patterns[id].enabled, reward: game.config.patterns[id].reward,
      })),
      houses: game.config.houses,
    },
    draws: game.draws,
    lastDraw: game.draws[game.draws.length - 1] ?? null,
    nextDrawAt: game.nextDrawAt,
    paused: game.paused,
    players: game.players.map(p => ({
      id: p.id, name: p.name, tickets: p.tickets.length, disqualified: p.disqualified,
    })),
    claims: game.claims.slice(-40).map(c => ({
      id: c.id, playerName: c.playerName, patternId: c.patternId, result: c.result,
      message: c.message, penaltyApplied: c.penaltyApplied, at: c.at,
    })),
    wins: game.wins.map(w => ({ patternId: w.patternId, tier: w.tier, drawIndex: w.drawIndex })),
    ledger: game.status === 'lobby' ? null : computeLedger(game),
  };
}

// private state for one player (includes their tickets + marks)
function playerState(game, player) {
  return {
    you: {
      id: player.id, name: player.name, disqualified: player.disqualified,
      isHost: false,
      tickets: player.tickets.map((t, i) => ({
        index: i, id: t.id, rows: t.rows, marks: t.marks, retired: t.retired,
      })),
    },
    game: publicState(game),
  };
}

function hostState(game) {
  return { you: { isHost: true, hostToken: game.hostToken, code: game.code }, game: publicState(game) };
}

// ---- auto-draw timer ----
function ensureTimer(game) {
  clearTimer(game.code);
  if (game.status !== 'playing') return;
  const interval = setInterval(() => {
    const g = games.get(game.code);
    if (!g || g.status !== 'playing' || g.paused) return;
    drawNext(g);
    if (g.status === 'finished') { clearTimer(g.code); saveGame(g); broadcast(g); return; }
    saveGame(g);
    broadcast(g);
  }, game.config.drawIntervalSec * 1000);
  timers.set(game.code, interval);
}
function clearTimer(code) {
  const t = timers.get(code);
  if (t) { clearInterval(t); timers.delete(code); }
}

function touch(game) {
  game.nextDrawAt = game.status === 'playing' && !game.paused
    ? Date.now() + game.config.drawIntervalSec * 1000
    : null;
}

// ---- message handling ----
wss.on('connection', (ws) => {
  ws.code = null;
  ws.role = null; // 'host' | 'player'
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { handle(ws, msg); } catch (err) { console.error('handler error', err); send(ws, { type: 'error', message: 'Server error' }); }
  });

  ws.on('close', () => {
    const set = clients.get(ws.code);
    if (set) { set.delete(ws); if (set.size === 0) clients.delete(ws.code); }
  });
});

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function joinClients(ws, code) {
  ws.code = code;
  if (!clients.has(code)) clients.set(code, new Set());
  clients.get(code).add(ws);
}

function handle(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const game = createGame(msg.config || {});
      games.set(game.code, game);
      joinClients(ws, game.code);
      ws.role = 'host';
      touch(game);
      saveGame(game);
      send(ws, { type: 'created', ...hostState(game) });
      break;
    }
    case 'joinHost': {
      const game = games.get(msg.code);
      if (!game || msg.hostToken !== game.hostToken) return send(ws, { type: 'error', message: 'Not authorized as host' });
      joinClients(ws, game.code);
      ws.role = 'host';
      send(ws, hostState(game));
      break;
    }
    case 'join': {
      const game = games.get(msg.code);
      if (!game) return send(ws, { type: 'error', message: 'Game not found' });
      if (game.status === 'finished') return send(ws, { type: 'error', message: 'Game already finished' });
      // resume: if token given and matches, reattach
      let player = msg.token ? findPlayer(game, msg.token) : null;
      if (!player) player = addPlayer(game, msg.name);
      joinClients(ws, game.code);
      ws.role = 'player';
      ws.playerId = player.id;
      touch(game);
      saveGame(game);
      send(ws, { type: 'joined', token: player.token, ...playerState(game, player) });
      broadcast(game);
      break;
    }
    default: {
      // actions require an attached game + role
      const game = games.get(ws.code);
      if (!game) return send(ws, { type: 'error', message: 'Not in a game' });
      const player = ws.role === 'player' ? (game.players.find(p => p.id === ws.playerId) || null) : null;
      handleAction(ws, game, player, msg);
    }
  }
}

function handleAction(ws, game, player, msg) {
  const isHost = ws.role === 'host';
  switch (msg.type) {
    case 'buy': {
      if (!player) return send(ws, { type: 'error', message: 'Only players can buy' });
      const r = buyTickets(game, player, msg.n);
      if (!r.ok) return send(ws, { type: 'error', message: r.error });
      touch(game); saveGame(game); broadcast(game);
      send(ws, { type: 'you', you: playerState(game, player).you });
      break;
    }
    case 'mark': {
      if (!player) return;
      const t = player.tickets.find(x => x.id === msg.ticketId);
      if (!t) return;
      const i = t.marks.indexOf(msg.number);
      if (i >= 0) t.marks.splice(i, 1); else t.marks.push(msg.number);
      saveGame(game);
      send(ws, { type: 'you', you: playerState(game, player).you });
      break;
    }
    case 'claim': {
      if (!player) return send(ws, { type: 'error', message: 'Only players can claim' });
      const r = submitClaim(game, player, msg.patternId, msg.ticketId);
      touch(game); saveGame(game); broadcast(game);
      send(ws, { type: 'claimResult', ok: r.ok, result: r.result, message: r.message, you: playerState(game, player).you });
      break;
    }
    case 'pause':
    case 'resume': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      game.paused = msg.type === 'pause';
      if (!game.paused && game.status === 'playing') { touch(game); ensureTimer(game); }
      else { game.nextDrawAt = null; clearTimer(game.code); }
      saveGame(game); broadcast(game);
      break;
    }
    case 'skip': { // draw one number immediately (works while paused — host-paced mode)
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      if (game.status !== 'playing') return;
      drawNext(game, true);
      touch(game);
      if (game.status === 'finished') clearTimer(game.code); else ensureTimer(game);
      saveGame(game); broadcast(game);
      break;
    }
    case 'setInterval': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      const n = Math.floor(Number(msg.seconds));
      if (!(n >= 3 && n <= 300)) return send(ws, { type: 'error', message: 'Interval 3-300s' });
      game.config.drawIntervalSec = n;
      touch(game);
      if (game.status === 'playing' && !game.paused) ensureTimer(game);
      saveGame(game); broadcast(game);
      break;
    }
    case 'addHouse': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      if (game.config.houses.length >= 10) return send(ws, { type: 'error', message: 'Max 10 houses' });
      game.config.houses.push({ reward: msg.reward || { type: 'amount', value: 500 } });
      saveGame(game); broadcast(game);
      break;
    }
    case 'setHouseReward': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      const h = game.config.houses[msg.index];
      if (!h) return send(ws, { type: 'error', message: 'No such house' });
      h.reward = msg.reward;
      saveGame(game); broadcast(game);
      break;
    }
    case 'setPattern': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      const p = game.config.patterns[msg.patternId];
      if (!p) return send(ws, { type: 'error', message: 'No such pattern' });
      if (msg.enabled !== undefined) p.enabled = !!msg.enabled;
      if (msg.reward) p.reward = msg.reward;
      saveGame(game); broadcast(game);
      break;
    }
    case 'start': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      const r = startGame(game);
      if (!r.ok) return send(ws, { type: 'error', message: r.error });
      touch(game); ensureTimer(game); saveGame(game); broadcast(game);
      break;
    }
    case 'end': {
      if (!isHost) return send(ws, { type: 'error', message: 'Host only' });
      finishGame(game); clearTimer(game.code); saveGame(game); broadcast(game);
      break;
    }
    default:
      send(ws, { type: 'error', message: 'Unknown message' });
  }
}

// restart timers for any resumed playing games
for (const game of games.values()) if (game.status === 'playing' && !game.paused) { touch(game); ensureTimer(game); }

server.listen(PORT, () => console.log(`housie listening on :${PORT}`));
