import { generateTicket, generateTickets } from '../server/tickets.js';
import { PATTERNS, completionDraw, patternNumbers } from '../server/patterns.js';
import {
  createGame, addPlayer, buyTickets, startGame, drawNext, submitClaim,
  computeLedger, finishGame,
} from '../server/game.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; console.error('  FAIL:', name); }
}
function section(name) { console.log('—', name); }

// ---- deterministic helpers ----
// Seeded RNG so tickets (and therefore drawn numbers) are reproducible across runs.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let SEED = 1;
function gen() { return generateTicket(mulberry32(SEED++)); }
function fixedTicket(rows) { return { id: 'T' + Math.random().toString(36).slice(2, 8), rows, marks: [], retired: false }; }

// drawNext pops from the END of drawOrder. Set drawOrder so that popping yields `seq`
// front-to-back, with filler afterward so the pool never empties mid-test.
function prime(game, seq) {
  const used = new Set(seq);
  const filler = [];
  for (let n = 1; n <= 90 && filler.length < 30; n++) {
    if (!used.has(n) && !game.draws.includes(n)) filler.push(n);
  }
  game.drawOrder = [...filler, ...[...seq].reverse()]; // pop() -> seq[0], seq[1], ...
}
// Draw exactly the numbers in `seq`, in order (prime must have been called with the same seq).
function drawTo(game, seq) { for (let i = 0; i < seq.length; i++) drawNext(game, true); }

// Draw `n` filler numbers (not from `skip`) to advance the game past a completion point.
function drawFiller(game, n) {
  const seq = game.drawOrder.slice(-n).reverse(); // peek what pop() would give
  drawTo(game, seq);
}

// Build a game whose first draws are exactly `seq`, returns { g, p, t }.
function gameWithTicket(rows, seq, opts = {}) {
  const g = createGame({ ticketPrice: 10, ...opts });
  const p = addPlayer(g, 'P');
  const t = fixedTicket(rows);
  p.tickets.push(t);
  startGame(g);
  prime(g, seq);
  drawTo(g, seq);
  return { g, p, t };
}

section('ticket generation invariants');
{
  const tickets = generateTickets(20000);
  let allGood = true;
  for (const t of tickets) {
    const nums = t.rows.flat().filter(Boolean);
    if (nums.length !== 15) { allGood = false; break; }
    for (const row of t.rows) {
      const filled = row.filter(Boolean);
      if (filled.length !== 5) { allGood = false; break; }
      for (let i = 1; i < filled.length; i++) if (filled[i] <= filled[i - 1]) { allGood = false; break; }
    }
    for (let c = 0; c < 9; c++) {
      const col = t.rows.map(r => r[c]).filter(Boolean);
      const lo = c < 8 ? c * 10 + 1 : 81, hi = c < 8 ? c * 10 + 9 : 90;
      if (col.length < 1 || col.length > 3) { allGood = false; break; }
      if (!col.every(n => n >= lo && n <= hi)) { allGood = false; break; }
      for (let i = 1; i < col.length; i++) if (col[i] <= col[i - 1]) { allGood = false; break; }
    }
  }
  ok(allGood, '20000 tickets satisfy tambola invariants');
}

section('pattern completion on generated tickets');
{
  const t = gen();
  const nums = t.rows.flat().filter(Boolean);
  const callIndex = {}; nums.forEach((n, i) => { callIndex[n] = i; });
  ok(completionDraw(t, PATTERNS.topLine.rule, callIndex) === 4, 'top line completes at index 4');
  ok(completionDraw(t, PATTERNS.corners.rule, callIndex) === 14, 'corners completes at last of its 4 numbers');
  ok(completionDraw(t, PATTERNS.fullHouse.rule, callIndex) === 14, 'full house completes at last');
  ok(completionDraw(t, PATTERNS.earlyFive.rule, callIndex) === 4, 'early five completes at 5th call');
  ok(patternNumbers(t, PATTERNS.corners.rule).length === 4, 'corners = 4 numbers');
  ok(patternNumbers(t, PATTERNS.star.rule).length === 7, 'star = 7 numbers');
  ok(patternNumbers(t, PATTERNS.pyramid.rule).length === 6, 'pyramid = 6 numbers');
  ok(completionDraw(t, PATTERNS.fullHouse.rule, { [nums[0]]: 0 }) === null, 'partial call -> not complete');
}

section('valid claim on the completing draw');
{
  const t = gen();
  const topRow = t.rows[0].filter(Boolean);
  const { g, p } = gameWithTicket(t.rows, topRow);
  const r = submitClaim(g, p, 'topLine', p.tickets[0].id);
  ok(r.ok && r.result === 'won', 'top line claim accepted on completing draw');
  ok(g.wins.length === 1 && g.wins[0].patternId === 'topLine', 'win recorded');
}

section('wrong claim -> penalty (disqualify by default)');
{
  const t = gen();
  const first3 = t.rows.flat().filter(Boolean).slice(0, 3);
  const { g, p } = gameWithTicket(t.rows, first3);
  const r = submitClaim(g, p, 'fullHouse', p.tickets[0].id);
  ok(r.result === 'wrong', 'incomplete full house = wrong');
  ok(p.disqualified === true, 'default penalty disqualifies');
}

section('wrong claim -> no penalty when configured');
{
  const t = gen();
  const { g, p } = gameWithTicket(t.rows, [], { penalty: 'none' });
  const r = submitClaim(g, p, 'fullHouse', p.tickets[0].id);
  ok(r.result === 'wrong', 'wrong claim detected');
  ok(p.disqualified === false, 'penalty:none leaves player in');
}

section('late claim rejected without penalty');
{
  const t = gen();
  const topRow = t.rows[0].filter(Boolean);
  const { g, p } = gameWithTicket(t.rows, topRow); // top line completes on the last draw
  drawFiller(g, 3); // 3 more numbers -> the claim is now late
  const r = submitClaim(g, p, 'topLine', p.tickets[0].id);
  ok(!r.ok && r.result === 'rejected', 'late claim rejected');
  ok(p.disqualified === false, 'late claim carries no penalty');
}

section('one ticket wins multiple patterns');
{
  const t = gen();
  const topRow = t.rows[0].filter(Boolean);
  const { g, p } = gameWithTicket(t.rows, topRow); // 5 draws -> earlyFive AND topLine both complete at index 4
  let r = submitClaim(g, p, 'earlyFive', p.tickets[0].id);
  ok(r.ok, 'ticket wins early five');
  r = submitClaim(g, p, 'topLine', p.tickets[0].id);
  ok(r.ok, 'same ticket also wins top line (multi-pattern OK)');
  ok(g.wins.length === 2, 'two separate wins recorded');
}

section('one claim per player per pattern across tickets');
{
  const g = createGame({ ticketPrice: 10 });
  const p = addPlayer(g, 'P');
  const t1 = gen(), t2 = gen();
  p.tickets.push(fixedTicket(t1.rows), fixedTicket(t2.rows));
  startGame(g);
  const topRow = t1.rows[0].filter(Boolean);
  prime(g, topRow);
  drawTo(g, topRow);
  let r = submitClaim(g, p, 'topLine', p.tickets[0].id);
  ok(r.ok, 'first ticket wins top line');
  r = submitClaim(g, p, 'topLine', p.tickets[1].id);
  ok(!r.ok, 'same player cannot claim same pattern with a second ticket');
}

section('split: later completion on an already-won pattern is refused');
{
  const g = createGame({ ticketPrice: 10, patterns: { earlyFive: { enabled: true, reward: { type: 'amount', value: 90 } } } });
  const x = addPlayer(g, 'X'), y = addPlayer(g, 'Y');
  const tx = gen(), ty = gen();
  x.tickets.push(fixedTicket(tx.rows)); y.tickets.push(fixedTicket(ty.rows));
  startGame(g);
  const nx = tx.rows.flat().filter(Boolean).slice(0, 5);
  const ny = ty.rows.flat().filter(Boolean).slice(0, 5);
  prime(g, [...nx, ...ny]);
  drawTo(g, nx); // X's early five completes now
  const rx = submitClaim(g, x, 'earlyFive', x.tickets[0].id);
  drawTo(g, ny); // Y completes on a LATER draw
  const ry = submitClaim(g, y, 'earlyFive', y.tickets[0].id);
  ok(rx.ok, 'X wins early five');
  ok(!ry.ok, 'later completion on an already-won pattern is refused (no free split)');
}

section('true same-draw split shares the prize');
{
  const base = gen(); // identical tickets are legal; both complete earlyFive on the same draw
  const g = createGame({ ticketPrice: 10, patterns: { earlyFive: { enabled: true, reward: { type: 'amount', value: 90 } } } });
  const a = addPlayer(g, 'A'), b = addPlayer(g, 'B');
  a.tickets.push(fixedTicket(base.rows)); b.tickets.push(fixedTicket(base.rows));
  startGame(g);
  const five = base.rows.flat().filter(Boolean).slice(0, 5);
  prime(g, five); drawTo(g, five);
  const ra = submitClaim(g, a, 'earlyFive', a.tickets[0].id);
  const rb = submitClaim(g, b, 'earlyFive', b.tickets[0].id);
  ok(ra.ok && rb.ok, 'both win early five on the same draw');
  const ledger = computeLedger(g);
  const win = ledger.wins.find(w => w.patternId === 'earlyFive');
  ok(win.winners.length === 2, 'two winners recorded');
  ok(win.value === 90 && win.share === 45, `prize 90 split 45/45 (got ${win.value}/${win.share})`);
  ok(ledger.pot === 20, 'pot = 2 players x 1 ticket x 10');
}

section('full house retires ticket + percent reward');
{
  const t = gen();
  const all = t.rows.flat().filter(Boolean); // 15 numbers
  const g = createGame({ ticketPrice: 10, houses: [{ reward: { type: 'percent', value: 50 } }] });
  const p = addPlayer(g, 'P');
  p.tickets.push(fixedTicket(t.rows));
  startGame(g);
  prime(g, all); drawTo(g, all);
  const r = submitClaim(g, p, 'fullHouse', p.tickets[0].id);
  ok(r.ok, 'full house claim accepted');
  ok(p.tickets[0].retired === true, 'ticket retired after full house');
  const again = submitClaim(g, p, 'topLine', p.tickets[0].id);
  ok(!again.ok, 'retired ticket cannot claim other patterns');
  const ledger = computeLedger(g);
  const house = ledger.wins.find(w => w.patternId === 'fullHouse');
  ok(house.value === 5, `percent reward resolves against pot (got ${house.value})`);
  ok(ledger.pot === 10, 'pot computed');
}

section('house tiers + host adds house mid-game');
{
  const t1 = gen(), t2 = gen();
  const g = createGame({ ticketPrice: 10, houses: [{ reward: { type: 'amount', value: 100 } }] });
  const a = addPlayer(g, 'A'), b = addPlayer(g, 'B');
  a.tickets.push(fixedTicket(t1.rows)); b.tickets.push(fixedTicket(t2.rows));
  startGame(g);
  const all1 = t1.rows.flat().filter(Boolean);
  const all2 = t2.rows.flat().filter(Boolean);
  prime(g, [...all1, ...all2]);
  drawTo(g, all1); // A's full house completes
  ok(submitClaim(g, a, 'fullHouse', a.tickets[0].id).ok, 'A wins house 1');
  drawTo(g, all2); // B's full house completes on a later draw
  const rB = submitClaim(g, b, 'fullHouse', b.tickets[0].id);
  ok(!rB.ok, 'no house tier left -> refused');
  g.config.houses.push({ reward: { type: 'amount', value: 50 } });
  const rB2 = submitClaim(g, b, 'fullHouse', b.tickets[0].id);
  ok(rB2.ok, 'host adds house mid-game -> next full house claim accepted');
  const ledger = computeLedger(g);
  const houses = ledger.wins.filter(w => w.patternId === 'fullHouse');
  ok(houses.length === 2 && houses[1].tier === 1, 'second house recorded as tier 1');
  ok(houses[1].value === 50, 'second house reward 50');
}

section('buy tickets validation');
{
  const g = createGame();
  const p = addPlayer(g, 'P');
  ok(buyTickets(g, p, 5).ok, 'can buy 5 in lobby');
  ok(p.tickets.length === 5, '5 tickets added');
  startGame(g);
  ok(!buyTickets(g, p, 5).ok, 'cannot buy after start');
  const g2 = createGame();
  const p2 = addPlayer(g2, 'Q');
  ok(!buyTickets(g2, p2, 0).ok, 'cannot buy 0');
  ok(!buyTickets(g2, p2, 99).ok, 'cannot buy 99 at once');
}

section('draw pool exhaustion finishes game');
{
  const g = createGame();
  const p = addPlayer(g, 'P');
  p.tickets.push(fixedTicket(gen().rows));
  startGame(g);
  prime(g, Array.from({ length: 90 }, (_, i) => i + 1));
  for (let i = 0; i < 90; i++) drawNext(g, true);
  ok(g.status === 'finished', 'game auto-finishes when pool is empty');
  ok(g.draws.length === 90, 'all 90 numbers drawn');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
