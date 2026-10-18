// E2E: real WebSocket game — host creates, players join+buy, start, draws, claims, ledger.
// Pattern: register `fresh` waiters BEFORE the action that triggers them, since the
// server broadcasts state before/around per-client replies.
import WebSocket from 'ws';

const URL = 'ws://localhost:3909/ws';
const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name = 'anon') {
  const ws = new WebSocket(URL);
  ws.__name = name;
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.findIndex((x) => x.pred(msg));
    if (w >= 0) { const { pred, resolve, to } = waiters.splice(w, 1)[0]; clearTimeout(to); resolve(msg); }
  });
  const open = () => new Promise((res) => ws.on('open', res));
  const fresh = (pred, timeout = 4000) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting on ${name}`)), timeout);
    waiters.push({ pred, resolve, to });
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const close = () => ws.close();
  // send + await a response in one call, waiter armed first
  const ask = (o, pred, timeout) => { const p = fresh(pred, timeout); send(o); return p; };
  return { ws, open, send, fresh, ask, close };
}

// ---- setup: host + two players, all tickets bought in the lobby ----
const host = client('host');
await host.open();
const created = await host.ask({ type: 'create', config: { ticketPrice: 20, drawIntervalSec: 300, voiceDefault: true, penalty: 'disqualify',
  patterns: { earlyFive: { enabled: true, reward: { type: 'amount', value: 60 } }, topLine: { enabled: true, reward: { type: 'percent', value: 25 } } },
  houses: [{ reward: { type: 'amount', value: 500 } }] } }, (m) => m.type === 'created');
const code = created.game.code;
ok(code?.length === 6, 'host got 6-char room code');
ok(created.game.status === 'lobby', 'game starts in lobby');

const player = client('ravi'); // 3 tickets, will claim wrong & get disqualified
await player.open();
const joined = await player.ask({ type: 'join', code, name: 'Ravi' }, (m) => m.type === 'joined');
ok(joined.token?.length > 8, 'player got token');
const bought = await player.ask({ type: 'buy', n: 3 }, (m) => m.type === 'you' && m.you.tickets.length === 3);
ok(bought.you.tickets.length === 3, 'player bought 3 tickets');

const p2 = client('sunita'); // 1 ticket, will win early five
await p2.open();
await p2.ask({ type: 'join', code, name: 'Sunita' }, (m) => m.type === 'joined');
// arm the host's waiter BEFORE the buy, since its state broadcast fires with the buy
const hostSeesBoth = host.fresh((m) => m.type === 'state' && m.game.players.length === 2 && m.game.players[1]?.tickets === 1);
const j2 = await p2.ask({ type: 'buy', n: 1 }, (m) => m.type === 'you' && m.you.tickets.length === 1);
const t2 = j2.you.tickets[0].id;
const five = j2.you.tickets[0].rows.flat().filter(Boolean).slice(0, 5);
ok(true, 'second player bought 1 ticket');

const state1 = await hostSeesBoth;
ok(state1.game.players[0].tickets === 3 && state1.game.players[1].tickets === 1, 'host sees both ticket counts');
ok(state1.game.config.patterns.find((p) => p.id === 'topLine').reward.type === 'percent', 'config carries percent reward');

// ---- start + host pacing ----
const started = await host.ask({ type: 'start' }, (m) => m.type === 'state' && m.game.status === 'playing');
ok(started.game.status === 'playing', 'game started by host');

await host.ask({ type: 'pause' }, (m) => m.type === 'state' && m.game.paused === true);
ok(true, 'host paused');
const before = started.game.draws.length;
const skipped = await host.ask({ type: 'skip' }, (m) => m.type === 'state' && m.game.draws.length === before + 1);
ok(skipped.game.draws.length === before + 1, 'manual draw works while paused');

// ---- wrong claim -> disqualified, blocked from further claims ----
const ticketId = bought.you.tickets[0].id;
const wrong = await player.ask({ type: 'claim', patternId: 'fullHouse', ticketId }, (m) => m.type === 'claimResult');
ok(wrong.result === 'wrong', 'wrong full-house claim detected');
ok(wrong.you.disqualified === true, 'player disqualified by penalty');
const dq = await player.ask({ type: 'claim', patternId: 'earlyFive', ticketId }, (m) => m.type === 'claimResult');
ok(dq.ok === false, 'disqualified player blocked from claiming');

// ---- Sunita wins early five deterministically ----
// Early five completes when the 5th number OF ANY of the ticket's 15 is called
// (server uses 5th-smallest call index over all 15) — mirror that exactly.
const allNums = j2.you.tickets[0].rows.flat().filter(Boolean);
let lastState = skipped;
const base = skipped.game.draws.length;
const completionAt = (draws) => {
  const idx = new Map(draws.map((n, j) => [n, j]));
  return allNums.map((n) => idx.get(n)).filter((x) => x !== undefined).sort((a, b) => a - b)[4] ?? null;
};
for (let i = 0; i < 89 && completionAt(lastState.game.draws) !== lastState.game.draws.length - 1; i++) {
  lastState = await host.ask({ type: 'skip' },
    (m) => m.type === 'state' && m.game.paused === true && m.game.draws.length === base + i + 1);
}
ok(completionAt(lastState.game.draws) === lastState.game.draws.length - 1, 'early five completes on the latest draw');
const won = await p2.ask({ type: 'claim', patternId: 'earlyFive', ticketId: t2 }, (m) => m.type === 'claimResult');
ok(won.ok === true && won.result === 'won', `early five won (${won.message})`);
const again = await p2.ask({ type: 'claim', patternId: 'earlyFive', ticketId: t2 }, (m) => m.type === 'claimResult');
ok(again.ok === false, 'same player cannot re-claim same pattern');

// ---- end + ledger ----
const finished = await host.ask({ type: 'end' }, (m) => m.type === 'state' && m.game.status === 'finished');
ok(!!finished.game.ledger, 'ledger present at game end');
ok(finished.game.ledger.players.length === 2, 'ledger has both players');
ok(finished.game.ledger.price === 20, 'ledger uses ticket price 20');
const sunita = finished.game.ledger.players.find((p) => p.name === 'Sunita');
const ravi = finished.game.ledger.players.find((p) => p.name === 'Ravi');
ok(sunita.owed === 20, 'Sunita owes 1 ticket x 20');
ok(ravi.owed === 60, 'Ravi owes 3 tickets x 20');
ok(sunita.won === 60 && sunita.net === 40, `Sunita net = 60-20 = 40 (got ${sunita.net})`);
ok(ravi.disqualified === true, 'Ravi marked disqualified in ledger');
ok(finished.game.ledger.pot === 80, 'pot = 4 tickets x 20 = 80');

// ---- mid-game house add on a fresh game ----
const host2 = client('host2');
await host2.open();
await host2.ask({ type: 'create', config: { houses: [{ reward: { type: 'amount', value: 100 } }] } }, (m) => m.type === 'created');
const st2 = await host2.ask({ type: 'addHouse', reward: { type: 'percent', value: 50 } }, (m) => m.type === 'state' && m.game.config.houses.length === 2);
ok(st2.game.config.houses.length === 2, 'host added a house tier');
ok(st2.game.config.houses[1].reward.type === 'percent', 'new house uses percent reward');

// ---- host reconnection with token ----
host.close();
await sleep(300);
const host3 = client('host3');
await host3.open();
const re = await host3.ask({ type: 'joinHost', code, hostToken: created.you.hostToken }, (m) => m.type === 'state');
ok(re.game.code === code, 'host rejoined with token after reconnect');
const bad = await host3.ask({ type: 'joinHost', code, hostToken: 'bogus' }, (m) => m.type === 'error');
ok(/authorized/i.test(bad.message), 'bogus host token rejected');

player.close(); p2.close(); host2.close(); host3.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\nE2E: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
