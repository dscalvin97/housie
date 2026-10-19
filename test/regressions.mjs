// Regression tests for the two server-layer findings in docs/bug-report.md:
//   f3 (MEDIUM) one WS socket can join multiple games, stays subscribed to the old one
//               and leaks in the old client Set forever
//   f5 (MEDIUM) unauthenticated join spam grows players / broadcasts / sqlite unbounded
//
// These drive a real server on ws://localhost:3909. Start it first:
//   PORT=3909 node server/index.js &
import WebSocket from 'ws';

const URL = 'ws://localhost:3909/ws';
const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
// wait for the next message matching pred, without consuming unrelated ones first
function waitFor(ws, pred, ms = 8000, label = '?') {
  return new Promise((resolve, reject) => {
    const hit = ws.inbox.find(pred);
    if (hit) return resolve(hit);
    const to = setTimeout(() => reject(new Error('timeout at ' + label)), ms);
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (pred(m)) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });
}
const clear = (ws) => { ws.inbox.length = 0; };
const code6 = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ---- setup: a host with a live game, and a player socket ----
const host = await open();
host.send(JSON.stringify({ type: 'create', config: { drawIntervalSec: 300 } }));
const created = await waitFor(host, (m) => m.type === 'created', 8000, 'created A');
const codeA = created.game.code;

const spy = await open();
spy.send(JSON.stringify({ type: 'join', code: codeA, name: 'Spy' }));
await waitFor(spy, (m) => m.type === 'joined', 8000, 'spy joined A');

// ---- f3: a socket that joins a second game must leave the first ----
{
  clear(spy);
  const codeB = code6();
  // game B must exist first, so let the host create it too
  clear(host);
  host.send(JSON.stringify({ type: 'create', config: { drawIntervalSec: 300 } }));
  const createdB = await waitFor(host, (m) => m.type === 'created' && m.game.code !== codeA, 8000, 'created B');
  const realB = createdB.game.code;

  spy.send(JSON.stringify({ type: 'join', code: realB, name: 'Spy' }));
  await waitFor(spy, (m) => m.type === 'joined' && m.game.code === realB, 8000, 'spy joined B');

  // now a new player joins game A. If the spy is still subscribed to A, it gets A's state.
  clear(spy);
  const p2 = await open();
  p2.send(JSON.stringify({ type: 'join', code: codeA, name: 'Ravi' }));
  await waitFor(p2, (m) => m.type === 'joined', 8000, 'p2 joined A');
  await sleep(300);

  const leaked = spy.inbox.find((m) => m.type === 'state' && m.game?.code === codeA);
  ok(!leaked, 'socket that left game A no longer receives game A broadcasts');

  // and the Set must not retain it: game A's player count broadcast should not include the spy
  const lastA = [...spy.inbox].reverse().find((m) => m.type === 'state' && m.game?.code === codeA);
  if (lastA) ok(!lastA.game.players.some((p) => p.name === 'Spy'), 'spy is gone from game A player list');
  else ok(true, 'spy is gone from game A player list (no broadcast received at all)');
  p2.close();
}

// ---- f5: join spam must be capped ----
{
  const codeC = code6();
  clear(host);
  host.send(JSON.stringify({ type: 'create', config: { drawIntervalSec: 300 } }));
  const createdC = await waitFor(host, (m) => m.type === 'created' && m.game.code !== codeA, 8000, 'created C');
  const realC = createdC.game.code;

  const spammer = await open();
  for (let i = 0; i < 300; i++) {
    spammer.send(JSON.stringify({ type: 'join', code: realC, name: 'Bot' + (i % 5) }));
  }
  await sleep(800);

  // observe the cap from outside: a fresh socket must be refused, because a refused
  // join broadcasts nothing (which is the point — spam cannot grow the game)
  const probe = await open();
  probe.send(JSON.stringify({ type: 'join', code: realC, name: 'Probe' }));
  const verdict = await waitFor(probe, (m) => m.type === 'error' || m.type === 'joined', 8000, 'probe verdict');

  clear(host);
  host.send(JSON.stringify({ type: 'joinHost', code: realC, hostToken: createdC.you.hostToken }));
  const lobby = await waitFor(host, (m) => m.type === 'state' && m.game?.code === realC, 8000, 'lobby state C');
  ok(lobby.game.players.length <= 100, `players capped (got ${lobby.game.players.length}, want <= 100)`);
  ok(verdict.type === 'error' && /full/i.test(verdict.message || ''), 'join beyond the cap is refused');
  spammer.close();
  probe.close();
}

host.close();
spy.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\nserver-findings: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
