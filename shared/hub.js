// Protocol hub: the single implementation of the message handling, state shaping and
// validation shared by every transport (WebSocket server on the host box, BroadcastChannel
// on GitHub Pages). Transport-agnostic by construction — it never touches sockets.
import {
  createGame, addPlayer, buyTickets, startGame, drawNext, finishGame,
  findPlayer, submitClaim, computeLedger, CLAIMABLE_PATTERNS,
} from './game.js';

// ---- state shaping ----
export function publicState(game) {
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
export function playerState(game, player) {
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

export function hostState(game) {
  return { you: { isHost: true, hostToken: game.hostToken, code: game.code }, game: publicState(game) };
}

export function touch(game) {
  game.nextDrawAt = game.status === 'playing' && !game.paused
    ? Date.now() + game.config.drawIntervalSec * 1000
    : null;
}

// Create a hub bound to a transport. Dependencies:
//   games     Map<code, game> — the live game store
//   save(game)               — persist a game (no-op is fine)
//   broadcast(game)          — push public state to every client of the game
//   setTimer(game, fn)       — schedule auto-draw; MUST replace any previous timer
//   clearTimer(code)         — cancel a scheduled auto-draw
export function createHub({ games, save, broadcast, setTimer, clearTimer }) {
  function ensureTimer(game) {
    clearTimer(game.code);
    if (game.status !== 'playing') return;
    setTimer(game, () => {
      const g = games.get(game.code);
      if (!g || g.status !== 'playing' || g.paused) return;
      drawNext(g);
      save(g);
      broadcast(g);
    });
  }

  function handleAction(client, game, player, msg) {
    const isHost = client.role === 'host';
    switch (msg.type) {
      case 'buy': {
        if (!player) return client.send({ type: 'error', message: 'Only players can buy' });
        const r = buyTickets(game, player, msg.n);
        if (!r.ok) return client.send({ type: 'error', message: r.error });
        touch(game); save(game); broadcast(game);
        client.send({ type: 'you', you: playerState(game, player).you });
        break;
      }
      case 'mark': {
        if (!player) return;
        const t = player.tickets.find(x => x.id === msg.ticketId);
        if (!t) return;
        // marks are cosmetic (the server verifies claims itself) but keep them honest:
        // a number that is not on this ticket is not a valid mark
        if (!t.rows.flat().includes(msg.number)) return;
        const i = t.marks.indexOf(msg.number);
        if (i >= 0) t.marks.splice(i, 1); else t.marks.push(msg.number);
        save(game);
        client.send({ type: 'you', you: playerState(game, player).you });
        break;
      }
      case 'claim': {
        if (!player) return client.send({ type: 'error', message: 'Only players can claim' });
        const r = submitClaim(game, player, msg.patternId, msg.ticketId);
        touch(game); save(game); broadcast(game);
        client.send({ type: 'claimResult', ok: r.ok, result: r.result, message: r.message, you: playerState(game, player).you });
        break;
      }
      case 'pause':
      case 'resume': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        game.paused = msg.type === 'pause';
        if (!game.paused && game.status === 'playing') { touch(game); ensureTimer(game); }
        else { game.nextDrawAt = null; clearTimer(game.code); }
        save(game); broadcast(game);
        break;
      }
      case 'skip': { // draw one number immediately (works while paused — host-paced mode)
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        if (game.status !== 'playing') return;
        drawNext(game, true);
        touch(game);
        if (game.status !== 'finished') ensureTimer(game);
        save(game); broadcast(game);
        break;
      }
      case 'setInterval': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        const n = Math.floor(Number(msg.seconds));
        if (!(n >= 3 && n <= 300)) return client.send({ type: 'error', message: 'Interval 3-300s' });
        game.config.drawIntervalSec = n;
        touch(game);
        if (game.status === 'playing' && !game.paused) ensureTimer(game);
        save(game); broadcast(game);
        break;
      }
      case 'addHouse': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        if (game.config.houses.length >= 10) return client.send({ type: 'error', message: 'Max 10 houses' });
        game.config.houses.push({ reward: msg.reward || { type: 'amount', value: 500 } });
        save(game); broadcast(game);
        break;
      }
      case 'setHouseReward': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        const h = game.config.houses[msg.index];
        if (!h) return client.send({ type: 'error', message: 'No such house' });
        h.reward = msg.reward;
        save(game); broadcast(game);
        break;
      }
      case 'setPattern': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        const p = game.config.patterns[msg.patternId];
        if (!p) return client.send({ type: 'error', message: 'No such pattern' });
        if (msg.enabled !== undefined) p.enabled = !!msg.enabled;
        if (msg.reward) p.reward = msg.reward;
        save(game); broadcast(game);
        break;
      }
      case 'start': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        const r = startGame(game);
        if (!r.ok) return client.send({ type: 'error', message: r.error });
        touch(game); ensureTimer(game); save(game); broadcast(game);
        break;
      }
      case 'end': {
        if (!isHost) return client.send({ type: 'error', message: 'Host only' });
        finishGame(game); clearTimer(game.code); save(game); broadcast(game);
        break;
      }
      default:
        client.send({ type: 'error', message: 'Unknown message' });
    }
  }

  function handle(client, msg) {
    switch (msg.type) {
      case 'create': {
        const game = createGame(msg.config || {});
        games.set(game.code, game);
        client.join(game.code);
        client.role = 'host';
        touch(game);
        save(game);
        client.send({ type: 'created', ...hostState(game) });
        break;
      }
      case 'joinHost': {
        const game = games.get(msg.code);
        if (!game || msg.hostToken !== game.hostToken) return client.send({ type: 'error', message: 'Not authorized as host' });
        client.join(game.code);
        client.role = 'host';
        client.send({ type: 'state', ...hostState(game) });
        break;
      }
      case 'join': {
        const game = games.get(msg.code);
        if (!game) return client.send({ type: 'error', message: 'Game not found' });
        // resume: a returning player may reattach even to a finished game (to see the
        // tally); only NEW players are turned away once the game is over
        let player = msg.token ? findPlayer(game, msg.token) : null;
        if (!player && game.status === 'finished') return client.send({ type: 'error', message: 'Game already finished' });
        if (!player) player = addPlayer(game, msg.name);
        client.join(game.code);
        client.role = 'player';
        client.playerId = player.id;
        touch(game);
        save(game);
        client.send({ type: 'joined', token: player.token, ...playerState(game, player) });
        broadcast(game);
        break;
      }
      default: {
        // actions require an attached game + role
        const game = games.get(client.code);
        if (!game) return client.send({ type: 'error', message: 'Not in a game' });
        const player = client.role === 'player' ? (game.players.find(p => p.id === client.playerId) || null) : null;
        handleAction(client, game, player, msg);
      }
    }
  }

  // restart timers for any resumed playing games
  function resumeGames() {
    for (const game of games.values()) if (game.status === 'playing' && !game.paused) { touch(game); ensureTimer(game); }
  }

  return { handle, resumeGames, publicState };
}
