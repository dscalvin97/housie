// Housie PWA client. Vanilla JS, single file. Talks to /ws.
import { PATTERNS } from '/patterns.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ---------- tiny helpers ----------
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast ' + kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

const fmtMoney = (n) => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN');
const patternName = (id) => (id === 'fullHouse' ? 'Full House' : (PATTERNS[id]?.name ?? id));

// ---------- session persistence ----------
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('housie:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('housie:' + k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem('housie:' + k); } catch {} },
};

// ---------- WebSocket ----------
let ws = null;
let wsHostToken = null; // set when we are the host of wsCode
let wsCode = null;
let wsRole = null; // 'host' | 'player'
let reconnectDelay = 500;
let wantReconnect = true;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect(onOpen) {
  wantReconnect = true;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) { onOpen?.(); return; }
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    // re-authenticate after a reconnect so a phone waking from sleep rejoins its room
    if (wsCode) rejoin();
    onOpen?.();
  });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  });
  ws.addEventListener('close', () => {
    if (!wantReconnect) return;
    setTimeout(() => connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else { connect(() => ws.send(JSON.stringify(obj))); }
}

// ---------- global state ----------
let state = { you: null, game: null };
let lastDrawCount = 0;
let view = 'home'; // 'home' | 'host' | 'player'
let selectedTicketIdx = 0;
let highlightPattern = null; // patternId to highlight on tickets
let claimSheetFor = null; // patternId when the ticket-picker sheet is open

// reconnection identity
function rejoin() {
  if (wsRole === 'host' && wsCode && wsHostToken) {
    send({ type: 'joinHost', code: wsCode, hostToken: wsHostToken });
  } else if (wsRole === 'player' && wsCode) {
    const tok = store.get('token:' + wsCode);
    if (tok) send({ type: 'join', code: wsCode, token: tok, name: store.get('name', 'Player') });
    else send({ type: 'join', code: wsCode, name: store.get('name', 'Player') });
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'created':
      wsCode = msg.game.code; wsRole = 'host'; wsHostToken = msg.hostToken;
      store.set('hostToken:' + msg.game.code, msg.hostToken);
      state = { you: msg.you, game: msg.game };
      lastDrawCount = state.game.draws.length;
      view = 'host'; render();
      break;
    case 'joined':
      wsCode = msg.game.code; wsRole = 'player';
      store.set('token:' + msg.game.code, msg.token);
      state = { you: msg.you, game: msg.game };
      lastDrawCount = state.game.draws.length;
      view = 'player'; render();
      break;
    case 'state':
      if (msg.game.code !== wsCode) return;
      if (msg.you) state.you = msg.you;
      state.game = msg.game;
      onNewDraws();
      render();
      break;
    case 'you':
      state.you = msg.you;
      render();
      break;
    case 'claimResult':
      state.you = msg.you;
      toast(msg.message, msg.ok ? 'good' : (msg.result === 'wrong' ? 'bad' : ''));
      render();
      break;
    case 'error':
      toast(msg.message, 'bad');
      break;
  }
}

function onNewDraws() {
  const n = state.game?.draws?.length ?? 0;
  if (n > lastDrawCount) {
    const num = state.game.draws[n - 1];
    speakNumber(num);
    if (n - lastDrawCount === 1) flashBoard(num);
  }
  lastDrawCount = n;
}

// ---------- text-to-speech ----------
let voiceOn = store.get('voiceOn', null); // null = use game default
function voiceEnabled() {
  if (voiceOn !== null) return voiceOn;
  return state.game?.config?.voiceDefault !== false;
}
let lastSpoken = -1;
function speakNumber(n) {
  if (!voiceEnabled()) return;
  if (lastSpoken === n) return;
  lastSpoken = n;
  try {
    const u = new SpeechSynthesisUtterance(`${n}`);
    u.rate = 0.95; u.pitch = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
function primeSpeech() {
  // iOS requires a user gesture before audio; unlock on first tap.
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
}
document.addEventListener('touchstart', primeSpeech, { once: true, passive: true });
document.addEventListener('click', primeSpeech, { once: true });

function flashBoard(n) {
  const el = $(`.board .n[data-n="${n}"]`);
  if (el) { el.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 400, easing: 'ease-out' }); }
}

// ============================================================ HOME / CREATE / JOIN
function viewHome() {
  app.innerHTML = '';
  const el = h(`<div>
    <h1 class="center">🎟️ Housie</h1>
    <p class="center dim small">Indian Tambola, live with friends</p>
    <div class="card">
      <div class="field"><label>Your name</label>
        <input id="name" placeholder="e.g. Ravi" value="${esc(store.get('name', ''))}" maxlength="20"></div>
      <button class="primary block" id="createBtn">Create a game</button>
    </div>
    <div class="card">
      <div class="field"><label>Join code</label>
        <input id="code" placeholder="6 letters" maxlength="6" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:4px;font-family:ui-monospace,monospace"></div>
      <button class="block" id="joinBtn">Join game</button>
    </div>
    <p class="center dim small">Install: your browser menu → “Add to Home Screen”</p>
  </div>`);
  app.appendChild(el);

  const nameInput = $('#name', el);
  const saveName = () => store.set('name', nameInput.value.trim());
  nameInput.addEventListener('input', saveName);

  $('#createBtn', el).addEventListener('click', () => {
    if (!nameInput.value.trim()) return toast('Enter your name first', 'bad');
    saveName();
    view = 'create'; render();
  });
  $('#joinBtn', el).addEventListener('click', () => {
    const code = $('#code', el).value.trim().toUpperCase();
    if (!nameInput.value.trim()) return toast('Enter your name first', 'bad');
    if (code.length !== 6) return toast('Enter the 6-letter code', 'bad');
    saveName();
    wsRole = 'player'; wsCode = code;
    connect(); // open handler rejoin()s with the right token/name
  });
}

// ---------- create form ----------
const CLAIMABLE = ['earlyFive', 'topLine', 'midLine', 'bottomLine', 'corners', 'star', 'pyramid'];
function defaultConfig() {
  const patterns = {};
  for (const id of CLAIMABLE) patterns[id] = { enabled: true, reward: { type: 'amount', value: 50 } };
  return {
    ticketPrice: 10, drawIntervalSec: 15, voiceDefault: true, penalty: 'disqualify',
    patterns, houses: [{ reward: { type: 'amount', value: 500 } }],
  };
}

let draft = null;
function viewCreate() {
  draft = defaultConfig();
  const draw = () => {
    app.innerHTML = '';
    const el = h(`<div>
      <div class="row"><button class="mini ghost" id="back">‹ Back</button><h1 class="grow" style="font-size:20px">New game</h1></div>

      <div class="card">
        <div class="row">
          <div class="field grow"><label>Ticket price (₹)</label>
            <input id="price" type="number" min="0" value="${draft.ticketPrice}"></div>
          <div class="field grow"><label>Draw every (sec)</label>
            <input id="interval" type="number" min="3" max="300" value="${draft.drawIntervalSec}"></div>
        </div>
        <div class="field"><label>Wrong-claim penalty</label>
          <select id="penalty">
            <option value="disqualify" ${draft.penalty === 'disqualify' ? 'selected' : ''}>Disqualify player</option>
            <option value="none" ${draft.penalty === 'none' ? 'selected' : ''}>Reject claim only</option>
          </select></div>
        <div class="field"><label>Voice calling</label>
          <select id="voice">
            <option value="1" ${draft.voiceDefault ? 'selected' : ''}>Announce numbers aloud (default on)</option>
            <option value="0" ${!draft.voiceDefault ? 'selected' : ''}>Silent (default off)</option>
          </select></div>
      </div>

      <h2>Prizes — patterns</h2>
      <div class="card" id="patterns"></div>

      <h2>Houses (full house tiers)</h2>
      <div class="card" id="houses"></div>

      <button class="primary block" id="createGame" style="margin-top:14px">Create game</button>
    </div>`);
    app.appendChild(el);
    renderPatterns($('.card#patterns', el));
    renderHouses($('.card#houses', el));

    $('#price', el).addEventListener('change', (e) => { draft.ticketPrice = Math.max(0, Number(e.target.value) || 0); });
    $('#interval', el).addEventListener('change', (e) => { draft.drawIntervalSec = Math.min(300, Math.max(3, Number(e.target.value) || 15)); });
    $('#penalty', el).addEventListener('change', (e) => { draft.penalty = e.target.value; });
    $('#voice', el).addEventListener('change', (e) => { draft.voiceDefault = e.target.value === '1'; });
    $('#back', el).addEventListener('click', () => { view = 'home'; render(); });
    $('#createGame', el).addEventListener('click', () => {
      wsRole = 'host';
      connect(() => send({ type: 'create', config: draft }));
    });
  };

  const renderPatterns = (box) => {
    box.innerHTML = '';
    for (const id of CLAIMABLE) {
      const p = draft.patterns[id];
      const row = h(`<div class="field">
        <div class="row">
          <label class="grow" style="margin:0;align-self:center">${esc(PATTERNS[id].name)}</label>
          <select data-en="${id}" style="width:110px">
            <option value="1" ${p.enabled ? 'selected' : ''}>On</option>
            <option value="0" ${!p.enabled ? 'selected' : ''}>Off</option>
          </select>
          <input data-rv="${id}" type="number" min="0" value="${p.reward.value}" style="width:90px" ${p.enabled ? '' : 'disabled'}>
          <select data-rt="${id}" style="width:80px">
            <option value="amount" ${p.reward.type === 'amount' ? 'selected' : ''}>₹</option>
            <option value="percent" ${p.reward.type === 'percent' ? 'selected' : ''}>% pot</option>
          </select>
        </div></div>`);
      box.appendChild(row);
      $(`[data-en="${id}"]`, row).addEventListener('change', (e) => {
        p.enabled = e.target.value === '1';
        $(`[data-rv="${id}"]`, row).disabled = !p.enabled;
      });
      $(`[data-rv="${id}"]`, row).addEventListener('change', (e) => { p.reward.value = Math.max(0, Number(e.target.value) || 0); });
      $(`[data-rt="${id}"]`, row).addEventListener('change', (e) => { p.reward.type = e.target.value; });
    }
  };

  const renderHouses = (box) => {
    box.innerHTML = '';
    draft.houses.forEach((house, i) => {
      const row = h(`<div class="field"><div class="row">
        <span class="grow dim">House ${i + 1}</span>
        <input data-hv="${i}" type="number" min="0" value="${house.reward.value}" style="width:90px">
        <select data-ht="${i}" style="width:80px">
          <option value="amount" ${house.reward.type === 'amount' ? 'selected' : ''}>₹</option>
          <option value="percent" ${house.reward.type === 'percent' ? 'selected' : ''}>% pot</option>
        </select>
        <button class="mini bad" data-hdel="${i}">✕</button>
      </div></div>`);
      box.appendChild(row);
      $(`[data-hv="${i}"]`, row).addEventListener('change', (e) => { house.reward.value = Math.max(0, Number(e.target.value) || 0); });
      $(`[data-ht="${i}"]`, row).addEventListener('change', (e) => { house.reward.type = e.target.value; });
      $(`[data-hdel="${i}"]`, row).addEventListener('click', () => { if (draft.houses.length > 1) { draft.houses.splice(i, 1); renderHouses(box); } else toast('Keep at least one house', 'bad'); });
    });
    const add = h(`<button class="mini block ghost" id="addHouse">+ Add another house</button>`);
    box.appendChild(add);
    $('#addHouse', box).addEventListener('click', () => { draft.houses.push({ reward: { type: 'amount', value: 500 } }); renderHouses(box); });
  };

  draw();
}

// ============================================================ SHARED RENDERERS
function boardHtml(game) {
  const called = new Set(game.draws);
  const last = game.lastDraw;
  let cells = '';
  for (let n = 1; n <= 90; n++) {
    const cls = n === last ? 'n last' : (called.has(n) ? 'n on' : 'n');
    cells += `<div class="${cls}" data-n="${n}">${n}</div>`;
  }
  return `<div class="board">${cells}</div>`;
}

function ticketHtml(ticket, game, { highlight = null, marks = [] } = {}) {
  const called = new Set(game.draws);
  const markSet = new Set(marks);
  let hl = new Set();
  if (highlight && PATTERNS[highlight]) {
    // highlight the pattern's cells using the same selector math as the server
    hl = highlightCells(ticket, PATTERNS[highlight].rule);
  }
  let cells = '';
  ticket.rows.forEach((row, r) => row.forEach((num, c) => {
    if (num == null) { cells += `<div class="cell blank"></div>`; return; }
    const key = `${r}-${c}`;
    const cls = ['cell'];
    if (markSet.has(num) || called.has(num)) cls.push('marked');
    if (hl.has(key)) cls.push('hl');
    cells += `<div class="${cls.join(' ')}">${num}</div>`;
  }));
  return `<div class="ticket"><div class="tlabel">Ticket ${ticket.index + 1}</div><div class="tgrid">${cells}</div></div>`;
}

// client-side mirror of the server's patternCellKeys, for highlight overlays
const CELLSEL = { first: 0, mid: 2, last: 4 };
function highlightCells(ticket, rule) {
  const keys = new Set();
  const rowNums = (r) => ticket.rows[r].filter(Boolean);
  const add = (r, num) => { const c = ticket.rows[r].indexOf(num); if (c >= 0) keys.add(`${r}-${c}`); };
  if (rule.type === 'row') rowNums(rule.row).forEach((n) => add(rule.row, n));
  else if (rule.type === 'corners') { [rowNums(0)[0], rowNums(0).at(-1)].forEach((n) => add(0, n)); [rowNums(2)[0], rowNums(2).at(-1)].forEach((n) => add(2, n)); }
  else if (rule.type === 'cells') for (const [r, k] of rule.cells) { const list = rowNums(r); const idx = typeof k === 'string' ? CELLSEL[k] : k; if (list[idx] != null) add(r, list[idx]); }
  else if (rule.type === 'all') ticket.rows.forEach((row, r) => row.forEach((n) => { if (n != null) add(r, n); }));
  return keys;
}

function countdownText(game) {
  if (game.status !== 'playing') return '';
  if (game.paused) return 'Paused';
  if (!game.nextDrawAt) return '';
  const ms = game.nextDrawAt - Date.now();
  if (ms <= 0) return '…';
  return Math.ceil(ms / 1000) + 's';
}

function feedHtml(game) {
  const items = [...game.claims].reverse();
  if (!items.length) return `<p class="dim small">No claims yet</p>`;
  return `<div class="feed">` + items.map((c) => {
    const kind = c.result === 'won' ? 'won' : (c.result === 'wrong' ? 'wrong' : '');
    const tag = c.result === 'won' ? '<span class="tag good">WON</span>'
      : c.result === 'wrong' ? '<span class="tag bad">WRONG</span>'
      : '<span class="tag info">REJECTED</span>';
    return `<div class="ev ${kind}"><strong>${esc(c.playerName)}</strong> · ${esc(patternName(c.patternId))} ${tag}<span class="dim small">${esc(c.message || '')}</span></div>`;
  }).join('') + `</div>`;
}

// ============================================================ HOST VIEW
function viewHost() {
  const game = state.game;
  app.innerHTML = '';
  if (game.status === 'lobby') return hostLobby(game);
  return hostGame(game);
}

function hostLobby(game) {
  const totalTickets = game.players.reduce((s, p) => s + p.tickets, 0);
  const el = h(`<div>
    <div class="row"><h1 class="grow" style="font-size:20px">Hosting</h1><span class="tag info">LOBBY</span></div>
    <div class="card center">
      <div class="dim small">Share this code</div>
      <div class="codebig">${esc(game.code)}</div>
      <button class="mini" id="copyLink">Copy join link</button>
    </div>
    <h2>Players (${game.players.length}) — ${totalTickets} tickets</h2>
    <div class="card" id="players"></div>
    <button class="primary block" id="start" ${totalTickets === 0 ? 'disabled' : ''}>Start game</button>
    <p class="dim small center">Players join and buy tickets, then you start.</p>
  </div>`);
  app.appendChild(el);

  const box = $('#players', el);
  if (!game.players.length) box.appendChild(h(`<p class="dim">Waiting for players…</p>`));
  for (const p of game.players) {
    box.appendChild(h(`<div class="row" style="padding:6px 0"><span class="grow">${esc(p.name)}</span><span class="pill">${p.tickets} ticket${p.tickets === 1 ? '' : 's'}</span></div>`));
  }

  $('#copyLink', el).addEventListener('click', async () => {
    const link = `${location.origin}/?join=${game.code}`;
    try { await navigator.clipboard.writeText(link); toast('Link copied', 'good'); } catch { prompt('Copy this link:', link); }
  });
  $('#start', el).addEventListener('click', () => send({ type: 'start' }));
}

function hostGame(game) {
  const ledger = game.ledger;
  const finished = game.status === 'finished';
  const el = h(`<div>
    <div class="row">
      <div class="grow"><span class="dim small">Room</span> <strong style="letter-spacing:2px">${esc(game.code)}</strong></div>
      ${finished ? '<span class="tag warn">FINISHED</span>' : (game.paused ? '<span class="tag warn">PAUSED</span>' : '<span class="tag good pulse">LIVE</span>')}
    </div>
    ${finished ? '' : `<div class="lastnum"><div class="lbl">Called</div><div class="big" id="lastBig">${game.lastDraw ?? '–'}</div><div class="dim small" id="cd">${countdownText(game)}</div></div>`}
    ${boardHtml(game)}
    ${finished ? `<div class="card center"><h2 style="margin-top:0">Final tally</h2><p class="dim small">Everyone can see the ledger below.</p></div>` : `
    <div class="row wrap" style="margin:8px 0">
      <button class="grow" id="pause">${game.paused ? 'Resume' : 'Pause'}</button>
      <button class="grow" id="skip">Draw now</button>
      <button class="grow" id="interval">Every ${game.config.drawIntervalSec}s</button>
      <button class="grow bad" id="end">End game</button>
    </div>`}
    <h2>Houses & prizes</h2>
    <div class="card" id="prizeCfg"></div>
    <h2>Claims</h2>
    <div class="card">${feedHtml(game)}</div>
    <h2>Ledger</h2>
    <div class="card" id="ledger">${ledgerHtml(game)}</div>
  </div>`);
  app.appendChild(el);

  if (!finished) {
    $('#pause', el).addEventListener('click', () => send({ type: game.paused ? 'resume' : 'pause' }));
    $('#skip', el).addEventListener('click', () => send({ type: 'skip' }));
    $('#interval', el).addEventListener('click', () => {
      const v = prompt('Draw interval in seconds (3-300):', game.config.drawIntervalSec);
      if (v == null) return;
      const n = Math.floor(Number(v));
      if (n >= 3 && n <= 300) send({ type: 'setInterval', seconds: n }); else toast('3-300 seconds', 'bad');
    });
    $('#end', el).addEventListener('click', () => { if (confirm('End the game now?')) send({ type: 'end' }); });
  }

  // live prize config (houses + pattern rewards editable mid-game)
  const cfg = $('#prizeCfg', el);
  game.config.houses.forEach((house, i) => {
    const won = game.wins.filter((w) => w.patternId === 'fullHouse')[i];
    const row = h(`<div class="field"><div class="row">
      <span class="grow">House ${i + 1} ${won ? '<span class="tag good">WON</span>' : ''}</span>
      <input data-hv="${i}" type="number" min="0" value="${house.reward.value}" style="width:80px">
      <select data-ht="${i}" style="width:76px">
        <option value="amount" ${house.reward.type === 'amount' ? 'selected' : ''}>₹</option>
        <option value="percent" ${house.reward.type === 'percent' ? 'selected' : ''}>% pot</option>
      </select></div></div>`);
    cfg.appendChild(row);
    $(`[data-hv="${i}"]`, row).addEventListener('change', (e) => send({ type: 'setHouseReward', index: i, reward: { type: house.reward.type, value: Math.max(0, Number(e.target.value) || 0) } }));
    $(`[data-ht="${i}"]`, row).addEventListener('change', (e) => send({ type: 'setHouseReward', index: i, reward: { type: e.target.value, value: house.reward.value } }));
  });
  const addHouse = h(`<button class="mini block ghost">+ Add house tier</button>`);
  cfg.appendChild(addHouse);
  addHouse.addEventListener('click', () => send({ type: 'addHouse', reward: { type: 'amount', value: 500 } }));

  for (const p of game.config.patterns) {
    const won = game.wins.some((w) => w.patternId === p.id);
    const row = h(`<div class="field"><div class="row">
      <span class="grow">${esc(patternName(p.id))} ${won ? '<span class="tag good">WON</span>' : (p.enabled ? '' : '<span class="tag">OFF</span>')}</span>
      <input data-pv="${p.id}" type="number" min="0" value="${p.reward.value}" style="width:80px" ${p.enabled ? '' : 'disabled'}>
      <select data-pt="${p.id}" style="width:76px" ${p.enabled ? '' : 'disabled'}>
        <option value="amount" ${p.reward.type === 'amount' ? 'selected' : ''}>₹</option>
        <option value="percent" ${p.reward.type === 'percent' ? 'selected' : ''}>% pot</option>
      </select></div></div>`);
    cfg.appendChild(row);
    $(`[data-pv="${p.id}"]`, row).addEventListener('change', (e) => send({ type: 'setPattern', patternId: p.id, reward: { type: p.reward.type, value: Math.max(0, Number(e.target.value) || 0) } }));
    $(`[data-pt="${p.id}"]`, row).addEventListener('change', (e) => send({ type: 'setPattern', patternId: p.id, reward: { type: e.target.value, value: p.reward.value } }));
  }
}

function ledgerHtml(game) {
  const L = game.ledger;
  if (!L) return `<p class="dim small">Ledger appears once the game starts.</p>`;
  const rows = L.players.map((p) => `<tr class="${p.id === state.you?.id ? 'me' : ''}">
    <td>${esc(p.name)}${p.disqualified ? ' <span class="tag bad">DQ</span>' : ''}</td>
    <td>${p.tickets}</td><td>${fmtMoney(p.owed)}</td><td>${fmtMoney(p.won)}</td>
    <td class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : ''}${fmtMoney(p.net)}</td></tr>`).join('');
  return `<div class="row small dim" style="margin-bottom:6px"><span>Pot <strong style="color:var(--text)">${fmtMoney(L.pot)}</strong></span><span>·</span><span>${L.ticketsSold} tickets × ${fmtMoney(L.price)}</span></div>
    <table class="ledger"><thead><tr><th>Player</th><th>Tix</th><th>Owes</th><th>Won</th><th>Net</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ============================================================ PLAYER VIEW
function viewPlayer() {
  const game = state.game;
  const you = state.you;
  app.innerHTML = '';
  if (game.status === 'lobby') return playerLobby(game, you);
  return playerGame(game, you);
}

function playerLobby(game, you) {
  const el = h(`<div>
    <div class="row"><h1 class="grow" style="font-size:20px">Room ${esc(game.code)}</h1><span class="tag info">LOBBY</span></div>
    <p class="dim">Hi <strong style="color:var(--text)">${esc(you.name)}</strong> — buy your tickets. The host will start soon.</p>
    <div class="card center">
      <div style="font-size:34px;font-weight:800">${you.tickets.length}</div>
      <div class="dim small">ticket${you.tickets.length === 1 ? '' : 's'} · ${fmtMoney(game.config.ticketPrice)} each</div>
      <div class="row" style="margin-top:10px">
        <button id="minus">−</button>
        <span class="grow" id="buyN" style="font-size:22px;font-weight:800">1</span>
        <button id="plus">+</button>
      </div>
      <button class="primary block" id="buy" style="margin-top:10px">Buy ticket</button>
    </div>
    <h2>Players</h2>
    <div class="card" id="players"></div>
  </div>`);
  app.appendChild(el);

  let n = 1;
  const nEl = $('#buyN', el);
  $('#plus', el).addEventListener('click', () => { n = Math.min(20, n + 1); nEl.textContent = n; });
  $('#minus', el).addEventListener('click', () => { n = Math.max(1, n - 1); nEl.textContent = n; });
  $('#buy', el).addEventListener('click', () => send({ type: 'buy', n }));

  const box = $('#players', el);
  for (const p of game.players) box.appendChild(h(`<div class="row" style="padding:6px 0"><span class="grow">${esc(p.name)}${p.id === you.id ? ' (you)' : ''}</span><span class="pill">${p.tickets} 🎟️</span></div>`));
}

function playerGame(game, you) {
  const finished = game.status === 'finished';
  const tickets = you.tickets;
  if (selectedTicketIdx >= tickets.length) selectedTicketIdx = 0;
  const myClaims = new Set(game.claims.filter((c) => c.playerId === you.id && c.result === 'won').map((c) => c.patternId));
  const retiredTickets = new Set(tickets.filter((t) => t.retired).map((t) => t.id));

  // claimable pattern buttons
  const pbtns = game.config.patterns.filter((p) => p.enabled).map((p) => {
    const done = myClaims.has(p.id);
    return `<button class="pbtn ${done ? 'done won' : ''}" data-claim="${p.id}" ${done || finished ? 'disabled' : ''}>
      <div class="pname">${esc(patternName(p.id))}</div>
      <div class="pmeta">${fmtMoney(p.reward.value)}${p.reward.type === 'percent' ? ' of pot' : ''}</div></button>`;
  }).join('');
  const houseWonCount = game.wins.filter((w) => w.patternId === 'fullHouse').length;
  const houseBtns = game.config.houses.map((house, i) => {
    const taken = i < houseWonCount;
    const iClaimed = game.claims.some((c) => c.playerId === you.id && c.patternId === 'fullHouse' && c.result === 'won');
    const off = finished || iClaimed;
    return `<button class="pbtn ${taken ? 'done won' : ''}" data-claim="fullHouse" data-tier="${i}" ${off ? 'disabled' : ''}>
      <div class="pname">House ${i + 1}</div>
      <div class="pmeta">${taken ? 'Claimed' : fmtMoney(house.reward.value) + (house.reward.type === 'percent' ? ' of pot' : '')}</div></button>`;
  }).join('');

  const el = h(`<div>
    <div class="row">
      <div class="grow"><span class="dim small">${esc(you.name)} · Room</span> <strong style="letter-spacing:2px">${esc(game.code)}</strong></div>
      ${finished ? '<span class="tag warn">FINISHED</span>' : (game.paused ? '<span class="tag warn">PAUSED</span>' : '<span class="tag good pulse">LIVE</span>')}
      <button class="mini ghost" id="voice">${voiceEnabled() ? '🔊' : '🔇'}</button>
    </div>
    ${you.disqualified ? `<div class="banner">You were disqualified for a wrong claim. You can still watch.</div>` : ''}
    ${finished ? '' : `<div class="lastnum"><div class="lbl">Last called</div><div class="big">${game.lastDraw ?? '–'}</div><div class="dim small" id="cd">${countdownText(game)}</div></div>`}
    ${boardHtml(game)}

    <h2>Claim</h2>
    <div class="pgrid">${pbtns || '<p class="dim small">No patterns enabled</p>'}${houseBtns}</div>

    <h2>Your ticket${tickets.length === 1 ? '' : 's'}</h2>
    ${tickets.length > 1 ? `<div class="pillrow">${tickets.map((t, i) => `<span class="pill ${i === selectedTicketIdx ? 'on' : ''}" data-tsel="${i}">#${i + 1}${t.retired ? ' ✓' : ''}</span>`).join('')}</div>` : ''}
    <div id="ticketBox">${tickets.length ? ticketHtml(tickets[selectedTicketIdx], game, {}) : '<p class="dim">No ticket yet — buy in the lobby.</p>'}</div>
    ${finished ? `<h2>Final tally</h2>` : ''}
    <div class="card" id="ledger">${ledgerHtml(game)}</div>
  </div>`);
  app.appendChild(el);

  $('#voice', el).addEventListener('click', () => { voiceOn = !voiceEnabled(); store.set('voiceOn', voiceOn); render(); });
  $$('[data-tsel]', el).forEach((pill) => pill.addEventListener('click', () => { selectedTicketIdx = Number(pill.dataset.tsel); render(); }));
  $$('[data-claim]', el).forEach((btn) => btn.addEventListener('click', () => {
    const patternId = btn.dataset.claim;
    const mine = tickets.filter((t) => !t.retired);
    if (!mine.length) return toast('No claimable ticket', 'bad');
    if (mine.length === 1) return send({ type: 'claim', patternId, ticketId: mine[0].id });
    // multiple tickets: pick which one claims
    openTicketSheet(patternId, mine);
  }));
}

function openTicketSheet(patternId, tickets) {
  claimSheetFor = patternId;
  const backdrop = h(`<div class="sheet-backdrop"><div class="sheet">
    <h2 style="margin-top:0">Which ticket claims ${esc(patternName(patternId))}?</h2>
    ${tickets.map((t) => `<button class="block" data-pick="${t.id}" style="margin-bottom:8px">Ticket ${t.index + 1}</button>`).join('')}
    <button class="block ghost" data-pick="">Cancel</button>
  </div></div>`);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.dataset.pick === '') { backdrop.remove(); claimSheetFor = null; return; }
    const id = e.target.dataset?.pick;
    if (id) { send({ type: 'claim', patternId, ticketId: id }); backdrop.remove(); claimSheetFor = null; }
  });
}

// ============================================================ ROUTER + BOOT
function render() {
  if (view === 'create') { viewCreate(); return; }
  if (!state.game) { viewHome(); return; }
  if (view === 'host') { viewHost(); return; }
  viewPlayer();
}

function tickCountdown() {
  const el = $('#cd');
  if (el && state.game) el.textContent = countdownText(state.game);
}
setInterval(tickCountdown, 500);

function boot() {
  // deep link: ?join=CODE
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode && joinCode.length === 6) {
    const name = store.get('name', '');
    if (!name) { viewHome(); toast('Enter your name to join'); return; }
    wsRole = 'player'; wsCode = joinCode.toUpperCase();
    connect();
    return;
  }
  // resume a host session
  const lastHost = store.get('lastHost', null);
  if (lastHost?.code && lastHost?.hostToken) {
    wsRole = 'host'; wsCode = lastHost.code; wsHostToken = lastHost.hostToken;
    connect();
    return;
  }
  viewHome();
}

// persist host session so a refresh resumes hosting the same room
setInterval(() => {
  if (wsRole === 'host' && wsCode && wsHostToken) store.set('lastHost', { code: wsCode, hostToken: wsHostToken });
}, 2000);

// clear lastHost when host room finishes? keep it — rejoining a finished room shows the tally.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

connect(() => boot());
window.addEventListener('online', () => { toast('Back online', 'good'); connect(() => rejoin()); });
