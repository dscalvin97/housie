// Static transport for the GitHub Pages build: swaps the WebSocket for a BroadcastChannel
// so a game runs entirely in the browser with no server.
//
// Model: the tab that creates a game becomes the HUB — it owns the game state and runs the
// same shared/hub.js the server runs. Every other tab on the same device talks to that hub
// over one BroadcastChannel. Cross-device play is impossible here (no server), which is why
// the self-hosted server build still exists.
import { createHub } from './shared/hub.js';

const channel = new BroadcastChannel('housie');
const clientId = Math.random().toString(36).slice(2);

// ---- hub state: lives only in the tab that created a game ----
let isHub = false;
const games = new Map();
const timers = new Map();

// hoisted: setTimer below references this before the object literal is assigned
function clearTimer(code) { const t = timers.get(code); if (t) { clearInterval(t); timers.delete(code); } }

const hub = createHub({
  games,
  save: () => {}, // in-memory only: refreshing the hub tab ends its games (documented limit)
  // BroadcastChannel never delivers a tab's own posts, so the owning tab must get the
  // state locally or it would never see changes other players cause (e.g. a ticket buy).
  broadcast: (game) => {
    const payload = { type: 'state', game: hub.publicState(game) };
    if (isHub) deliver(payload);
    post({ to: 'clients', payload });
  },
  setTimer: (game, fn) => {
    clearTimer(game.code);
    timers.set(game.code, setInterval(fn, game.config.drawIntervalSec * 1000));
  },
  clearTimer,
});

function post(msg) {
  channel.postMessage({ __housie: true, from: clientId, ...msg });
}

// One client view per sending tab, kept so role/playerId/code survive across messages.
// (A fresh object per message would forget who the sender is on every action.)
const clientsByTab = new Map();

function clientFor(replyTo) {
  let c = clientsByTab.get(replyTo);
  if (!c) {
    c = {
      role: null, playerId: null, code: null,
      // reply locally when the requester is this tab; post otherwise
      send: (obj) => (replyTo === clientId ? deliver(obj) : post({ to: 'clients', replyTo, payload: obj })),
      join(code) { c.code = code; },
    };
    clientsByTab.set(replyTo, c);
  }
  return c;
}

let socket = null; // the LocalSocket of this tab, set on construction

function deliver(obj) {
  if (socket) socket._emit('message', { data: JSON.stringify(obj) });
}

function handleHubMessage(payload, replyTo) {
  const client = clientFor(replyTo);
  try { hub.handle(client, payload); } catch (err) { console.error('hub error', err); client.send({ type: 'error', message: 'Server error' }); }
}

channel.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || !msg.__housie || msg.from === clientId) return;

  if (msg.to === 'hub') {
    // only the owning tab answers; a create claim makes this tab the owner
    if (!isHub && msg.payload?.type !== 'create') return;
    if (msg.payload?.type === 'create') isHub = true;
    handleHubMessage(msg.payload, msg.from);
    return;
  }
  if (msg.to === 'clients' && socket && (!msg.replyTo || msg.replyTo === clientId)) {
    deliver(msg.payload);
  }
};

// a socket that looks like a WebSocket to app.js (readyState/send/addEventListener/close)
class LocalSocket {
  constructor() {
    this.readyState = 0; // CONNECTING, then OPEN
    this._listeners = {};
    this._outbox = []; // frames sent before open — a real WebSocket buffers these
    setTimeout(() => {
      this.readyState = 1;
      this._emit('open', {});
      // flush anything the caller sent while we were still CONNECTING
      for (const data of this._outbox) this._post(data);
      this._outbox = [];
    }, 0);
  }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  _emit(type, ev) { for (const fn of this._listeners[type] || []) fn(ev); }
  send(data) {
    if (this.readyState === 3) return; // CLOSED: drop, like a dead socket
    if (this.readyState !== 1) { this._outbox.push(data); return; }
    this._post(data);
  }
  _post(data) {
    // app.js sends JSON strings, same as WebSocket frames
    const payload = JSON.parse(data);
    if (payload.type === 'create') isHub = true; // creating a game makes this tab the owner
    if (isHub) {
      // this tab owns the hub: handle in-process, never round-trip through the channel
      // (BroadcastChannel does not deliver a tab's own posts)
      if (!games.size && payload.type !== 'create') return; // not in a game yet
      handleHubMessage(payload, clientId);
      return;
    }
    post({ to: 'hub', payload });
  }
  close() { this.readyState = 3; this._outbox = []; this._emit('close', {}); }
}

export function makeLocalSocket() {
  socket = new LocalSocket();
  return socket;
}
