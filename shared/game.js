import { generateTickets } from './tickets.js';
import { PATTERNS, completionDraw } from './patterns.js';

// Patterns a host can enable, plus full-house which is governed by the houses array.
export const CLAIMABLE_PATTERNS = ['earlyFive', 'topLine', 'midLine', 'bottomLine', 'corners', 'star', 'pyramid'];

export const DEFAULT_CONFIG = {
  ticketPrice: 10,
  drawIntervalSec: 15,
  voiceDefault: true,
  penalty: 'disqualify', // 'disqualify' | 'none'
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

export function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function createGame(config = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    patterns: { ...(config.patterns || {}) }, // patternId -> { enabled, reward:{type,value} }
    houses: (config.houses || [{ reward: { type: 'amount', value: 500 } }]).map(h => ({ reward: h.reward })),
  };
  // normalize pattern entries
  for (const id of CLAIMABLE_PATTERNS) {
    const p = cfg.patterns[id] || {};
    cfg.patterns[id] = { enabled: p.enabled !== false, reward: p.reward || { type: 'amount', value: 50 } };
  }
  return {
    code: makeCode(),
    hostToken: uid(),
    status: 'lobby', // lobby | playing | finished
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    config: cfg,
    players: [],
    draws: [],
    drawOrder: [], // shuffled 1..90, consumed in order
    nextDrawAt: null,
    paused: false,
    claims: [],   // every claim attempt, for the feed
    wins: [],     // { key, patternId, tier, drawIndex, claims: [claimId] }
  };
}

export function findPlayer(game, token) {
  return game.players.find(p => p.token === token) || null;
}

export function addPlayer(game, name) {
  const player = {
    id: uid(),
    name: String(name).trim().slice(0, 20) || 'Player',
    token: uid(),
    tickets: [], // { id, rows, marks: [], retired: false }
    disqualified: false,
    joinedAt: Date.now(),
  };
  game.players.push(player);
  return player;
}

export function buyTickets(game, player, n) {
  if (game.status !== 'lobby') return { ok: false, error: 'Tickets can only be bought in the lobby' };
  n = Math.floor(Number(n));
  if (!(n >= 1 && n <= 20)) return { ok: false, error: 'Buy 1-20 tickets at a time' };
  if (player.tickets.length + n > 50) return { ok: false, error: 'Max 50 tickets per player' };
  const fresh = generateTickets(n).map(t => ({ id: uid(), rows: t.rows, marks: [], retired: false }));
  player.tickets.push(...fresh);
  return { ok: true, tickets: fresh };
}

export function shufflePool() {
  const pool = Array.from({ length: 90 }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export function startGame(game) {
  if (game.status !== 'lobby') return { ok: false, error: 'Already started' };
  const total = game.players.reduce((s, p) => s + p.tickets.length, 0);
  if (total === 0) return { ok: false, error: 'Nobody has bought a ticket yet' };
  game.status = 'playing';
  game.startedAt = Date.now();
  game.drawOrder = shufflePool();
  game.paused = false;
  return { ok: true };
}

export function drawNext(game, force = false) {
  if (game.status !== 'playing' || (game.paused && !force)) return null;
  if (game.drawOrder.length === 0) { finishGame(game); return null; }
  const number = game.drawOrder.pop();
  game.draws.push(number);
  game.nextDrawAt = Date.now() + game.config.drawIntervalSec * 1000;
  if (game.drawOrder.length === 0) finishGame(game);
  return number;
}

export function finishGame(game) {
  game.status = 'finished';
  game.endedAt = Date.now();
  game.nextDrawAt = null;
  game.paused = false;
}

export function callIndexOf(game) {
  const map = {};
  game.draws.forEach((n, i) => { map[n] = i; });
  return map;
}

// A pattern's live status for the feed/UI.
export function patternStatus(game, patternId) {
  if (patternId === 'fullHouse') {
    const tiers = game.wins.filter(w => w.patternId === 'fullHouse');
    return { wonCount: tiers.length, houseCount: game.config.houses.length };
  }
  return { won: game.wins.some(w => w.patternId === patternId) };
}

// Core claim. Returns { ok, result, message } and mutates game when accepted.
// Rules:
//  - claim names exactly ONE ticket
//  - a ticket may win unlimited patterns, but is retired after a successful Full House
//  - a player may hold many claims, but at most ONE per pattern (across all their tickets)
//  - a claim is valid only if the LAST drawn number completed that pattern (claim-before-next-draw)
//  - correct-but-late -> rejected (no penalty); not-complete -> wrong (penalty per config)
export function submitClaim(game, player, patternId, ticketId) {
  if (game.status !== 'playing') return { ok: false, result: 'rejected', message: 'Game is not running' };
  if (player.disqualified) return { ok: false, result: 'rejected', message: 'You are disqualified' };

  const isHouse = patternId === 'fullHouse';
  if (!isHouse && !CLAIMABLE_PATTERNS.includes(patternId)) return { ok: false, result: 'rejected', message: 'Unknown pattern' };
  // a pattern the host switched off must not be playable, or players can claim (and be
  // paid for) patterns the host explicitly excluded from the game
  if (!isHouse && game.config.patterns?.[patternId] && game.config.patterns[patternId].enabled === false) {
    return { ok: false, result: 'rejected', message: 'That pattern is not enabled in this game' };
  }
  const pat = PATTERNS[patternId];

  const ticket = player.tickets.find(t => t.id === ticketId);
  if (!ticket) return { ok: false, result: 'rejected', message: 'That ticket is not yours' };
  if (ticket.retired) return { ok: false, result: 'rejected', message: 'That ticket already won Full House' };

  // one claim per player per pattern (houses collapse to the fullHouse pattern)
  const prior = game.claims.find(c => c.playerId === player.id && c.patternId === patternId && c.result === 'won');
  if (prior) return { ok: false, result: 'rejected', message: 'You already claimed this pattern' };

  const claim = {
    id: uid(), playerId: player.id, playerName: player.name,
    ticketId, patternId, at: Date.now(), drawIndex: game.draws.length - 1,
    result: 'pending', message: '', penaltyApplied: false,
  };
  game.claims.push(claim);

  const callIdx = callIndexOf(game);
  const completed = completionDraw(ticket, pat.rule, callIdx);

  if (completed === null) {
    return penalize(game, player, claim, 'Wrong claim — pattern is not complete');
  }
  if (completed < game.draws.length - 1) {
    claim.result = 'rejected';
    claim.message = 'Late claim — number was called earlier';
    return { ok: false, result: 'rejected', claim, message: claim.message };
  }

  // accepted
  if (isHouse) {
    const usedTiers = game.wins.filter(w => w.patternId === 'fullHouse');
    let group = usedTiers.find(w => w.drawIndex === completed);
    if (!group) {
      if (usedTiers.length >= game.config.houses.length) {
        claim.result = 'rejected';
        claim.message = 'No house tier left — ask the host to add one';
        return { ok: false, result: 'rejected', claim, message: claim.message };
      }
      group = { key: uid(), patternId: 'fullHouse', tier: usedTiers.length, drawIndex: completed, claims: [] };
      game.wins.push(group);
    }
    group.claims.push(claim.id);
    ticket.retired = true; // ticket is over once it wins a house
  } else {
    let group = game.wins.find(w => w.patternId === patternId);
    if (group && group.drawIndex !== completed) {
      claim.result = 'rejected';
      claim.message = 'Pattern already won on an earlier number';
      return { ok: false, result: 'rejected', claim, message: claim.message };
    }
    if (!group) {
      group = { key: uid(), patternId, tier: null, drawIndex: completed, claims: [] };
      game.wins.push(group);
    }
    group.claims.push(claim.id);
  }
  claim.result = 'won';
  claim.message = 'Won!';
  return { ok: true, result: 'won', claim, message: 'Claim accepted' };
}

function penalize(game, player, claim, message) {
  claim.result = 'wrong';
  claim.message = message;
  if (game.config.penalty === 'disqualify') {
    player.disqualified = true;
    claim.penaltyApplied = true;
    message += ' — disqualified';
  }
  return { ok: false, result: 'wrong', claim, message };
}

// Resolve a reward (fixed amount or % of pot) into rupees.
function resolveReward(reward, pot) {
  if (reward.type === 'percent') return Math.round((pot * reward.value) / 100);
  return Number(reward.value) || 0;
}

export function computeLedger(game) {
  const price = game.config.ticketPrice;
  let ticketsSold = 0;
  for (const p of game.players) ticketsSold += p.tickets.length;
  const pot = ticketsSold * price;

  const claimById = {};
  for (const c of game.claims) claimById[c.id] = c;

  const perPlayer = new Map();
  for (const p of game.players) perPlayer.set(p.id, { id: p.id, name: p.name, tickets: p.tickets.length, disqualified: p.disqualified, owed: p.tickets.length * price, won: 0, net: 0 });

  const winSummaries = [];
  for (const w of game.wins) {
    const reward = w.patternId === 'fullHouse'
      ? (game.config.houses[w.tier]?.reward ?? { type: 'amount', value: 0 })
      : (game.config.patterns[w.patternId]?.reward ?? { type: 'amount', value: 0 });
    const value = resolveReward(reward, pot);
    const winners = w.claims.map(id => claimById[id]).filter(Boolean);
    const n = winners.length || 1;
    const share = Math.floor(value / n);
    const remainder = value - share * n;
    winners.forEach((c, i) => {
      const rec = perPlayer.get(c.playerId);
      if (rec) rec.won += share + (i === 0 ? remainder : 0);
    });
    winSummaries.push({
      patternId: w.patternId,
      tier: w.tier,
      patternName: w.patternId === 'fullHouse' ? `House ${w.tier + 1}` : PATTERNS[w.patternId].name,
      value, share, winners: winners.map(c => ({ playerId: c.playerId, name: c.playerName, ticketId: c.ticketId })),
    });
  }

  const players = [...perPlayer.values()].map(r => ({ ...r, net: r.won - r.owed }));
  players.sort((a, b) => b.net - a.net);
  return { pot, ticketsSold, price, players, wins: winSummaries };
}
