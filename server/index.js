import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createHub } from '../shared/hub.js';
import { saveGame, loadGame, allCodes } from './db.js';

const PORT = Number(process.env.PORT) || 3909;
const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const SHARED_ROOT = fileURLToPath(new URL('../shared', import.meta.url));

const games = new Map(); // code -> game object (live)
const timers = new Map(); // code -> interval
const clients = new Map(); // code -> Set<ws>

// ---- load persisted games that were in progress ----
for (const code of allCodes()) {
  const g = loadGame(code);
  if (g && g.status !== 'finished') games.set(code, g);
}

const hub = createHub({
  games,
  save: saveGame,
  broadcast: (game) => {
    const set = clients.get(game.code);
    if (!set) return;
    const payload = JSON.stringify({ type: 'state', game: hub.publicState(game) });
    for (const ws of set) if (ws.readyState === 1) ws.send(payload);
  },
  setTimer: (game, fn) => timers.set(game.code, setInterval(fn, game.config.drawIntervalSec * 1000)),
  clearTimer: (code) => { const t = timers.get(code); if (t) { clearInterval(t); timers.delete(code); } },
});

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
  // the browser imports the pure shared modules directly (no Node APIs inside them)
  if (path.startsWith('/shared/')) {
    const file = normalize(join(SHARED_ROOT, path.slice('/shared/'.length)));
    if (!file.startsWith(SHARED_ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
    return res.end(readFileSync(file));
  }
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback for client routes like /?join=CODE
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

wss.on('connection', (ws) => {
  const client = {
    role: null, playerId: null, code: null,
    send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    join: (code) => {
      client.code = code;
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(ws);
    },
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { hub.handle(client, msg); } catch (err) { console.error('handler error', err); client.send({ type: 'error', message: 'Server error' }); }
  });

  ws.on('close', () => {
    const set = clients.get(client.code);
    if (set) { set.delete(ws); if (set.size === 0) clients.delete(client.code); }
  });
});

hub.resumeGames();
server.listen(PORT, () => console.log(`housie listening on :${PORT}`));
