// Regression tests for the shared-layer findings in docs/bug-report.md:
//   f1 (HIGH)   disabled patterns can still be claimed, won, and paid out
//   f4 (MEDIUM) prototype pollution via host messages (__proto__ as patternId / index)
//   f7b (LOW)   a host socket that joins as a player permanently loses host controls
//
// These run against shared/hub.js in-process — no server needed.
import { createHub } from '../shared/hub.js';

const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };

function freshHub() {
  const games = new Map();
  const broadcasts = [];
  const hub = createHub({
    games,
    save: () => {},
    broadcast: (game) => broadcasts.push(game.code),
    setTimer: () => {},
    clearTimer: () => {},
  });
  const makeClient = () => {
    const sent = [];
    const c = {
      role: null, playerId: null, code: null, sent,
      send: (obj) => sent.push(obj),
      join(code) { c.code = code; },
    };
    return c;
  };
  return { hub, games, broadcasts, makeClient };
}

// drive a game up to 'playing' with one player holding one ticket
function startPlaying(hub, makeClient, cfg = {}) {
  const host = makeClient();
  hub.handle(host, { type: 'create', config: { drawIntervalSec: 300, ...cfg } });
  const created = host.sent.find((m) => m.type === 'created');
  const code = created.game.code;
  const game = { code, hostToken: created.you.hostToken };

  const player = makeClient();
  hub.handle(player, { type: 'join', code, name: 'Ravi' });
  const joined = player.sent.find((m) => m.type === 'joined');
  player.playerId = joined.you.id;
  player.token = joined.token;

  hub.handle(player, { type: 'buy', n: 1 });
  hub.handle(host, { type: 'start' });
  return { host, player, game };
}

// pull the game object out of the hub through the Map we injected
function gameOf(harness, code) { return harness.games.get(code); }
// the last public state the hub broadcast for a game
function lastState(harness, code) {
  const g = gameOf(harness, code);
  return g ? harness.hub.publicState(g) : null;
}

// ---- f1: a disabled pattern must not be claimable, winnable, or paid ----
{
  const harness = freshHub();
  const { hub, makeClient, games } = harness;
  const { host, player, game } = startPlaying(hub, makeClient, {
    patterns: { topLine: { enabled: false, reward: { type: 'amount', value: 100 } } },
  });

  const sent = player.sent.filter((m) => m.type === 'you');
  const ticket = sent[sent.length - 1].you.tickets[0];
  const g = gameOf(harness, game.code);

  // complete topLine: every tambola row has exactly 5 filled cells, so drawing all of
  // them guarantees the pattern is complete on the last draw. That isolates the 'enabled'
  // check — without it this would be accepted as a win.
  const topLine = ticket.rows[0].filter((n) => n != null);
  ok(topLine.length === 5, `fixture top line has 5 cells (got ${topLine.length})`);
  g.draws = [...topLine];
  player.sent.length = 0;
  hub.handle(player, { type: 'claim', code: game.code, patternId: 'topLine', ticketId: ticket.id });
  const reply = player.sent.find((m) => m.type === 'claimResult' || m.type === 'error');
  ok(reply && reply.result !== 'won', `disabled pattern not claimable (got "${reply?.result}: ${reply?.message}")`);

  // and it must not appear in the payout
  const st = lastState(harness, game.code);
  const paid = (st.ledger?.wins ?? []).find((w) => w.patternId === 'topLine');
  ok(!paid, 'disabled pattern is not in the payout');
  void host;
}

// ---- f4: __proto__ as patternId must not pollute Object.prototype ----
{
  const { hub, makeClient } = freshHub();
  const { host, game } = startPlaying(hub, makeClient);
  hub.handle(host, { type: 'setPattern', code: game.code, patternId: '__proto__', enabled: true, reward: { type: 'amount', value: 1 } });
  ok(!({}).enabled, 'setPattern __proto__ does not pollute Object.prototype');
  ok(!Object.hasOwn(Object.prototype, 'reward'), 'setPattern __proto__ adds no own key to Object.prototype');

  hub.handle(host, { type: 'setHouseReward', code: game.code, index: '__proto__', reward: { type: 'amount', value: 1 } });
  ok(![].reward, 'setHouseReward __proto__ does not pollute Array.prototype');
}

// ---- f7b: a host who joins as a player must keep host controls ----
{
  const { hub, makeClient } = freshHub();
  const { host, game } = startPlaying(hub, makeClient);
  // the host socket joins its own game as a player (to buy a ticket)
  hub.handle(host, { type: 'join', code: game.code, name: 'HostAsPlayer' });
  const err = host.sent.filter((m) => m.type === 'error');
  ok(!err.some((e) => /host only/i.test(e.message)), 'host socket can join as player without losing host role');
  hub.handle(host, { type: 'skip' });
  const err2 = host.sent.filter((m) => m.type === 'error');
  ok(!err2.some((e) => /host only/i.test(e.message)), 'host socket retains skip after joining as player');
}

const failed = results.filter(([c]) => !c).length;
console.log(`\nshared-findings: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
