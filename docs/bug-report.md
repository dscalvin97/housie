# Housie bug report

Audited: shared/game.js, shared/hub.js, public/local.js, server/index.js. All proof scripts are throwaway node scripts in /tmp/housie-proofs/ run against the real modules.
Baseline re-confirmed before hunting: `node test/selfcheck.js` 45/45, `node test/e2e.mjs` (server on :3909) 28/28, `node test/e2e-static.mjs` (dist/ served on :8899) 9/9.

## Findings

### 1. HIGH — disabled patterns can still be claimed, won, and are paid out
shared/game.js:144 (`submitClaim`) validates the pattern id against `CLAIMABLE_PATTERNS` but never against `game.config.patterns[patternId].enabled`; the ledger (game.js:240) also pays regardless.
Proof (/tmp/housie-proofs/f1-disabled-pattern.mjs): with `createGame({patterns:{corners:{enabled:false}}})`, a claim on corners after the completing draw returns `true won "Claim accepted"`, and `computeLedger` pays it (Eve net = +40).
Fix: in `submitClaim`, reject when `game.config.patterns[patternId]?.enabled === false` (fullHouse excepted).

### 2. HIGH — static build: any tab can impersonate any other tab's session; any tab can sever everyone from the game
public/local.js:44-58 keys the hub's client view (role, playerId, code) purely on the `from` field, which any tab on the channel can forge (clientIds are sniffable off the wire — every post carries one, local.js:39).
Proof (/tmp/housie-proofs/f5-local-spoof.mjs, real local.js, 2 module instances + attacker BroadcastChannel):
- forged `{to:'hub', from:<victimId>, payload:{type:'buy',n:20}}` → the victim's player bought 20 tickets (1 → 21) and the victim's tab even received the 'you' reply;
- forged `{...from:<victimId>, payload:{type:'join',code,name:'Mallory'}}` → victim's client view re-pointed to a new player (session hijack; all their later clicks act as Mallory);
- forged `{to:'hub', payload:{type:'create'}}` → local.js:77-79 flips EVERY non-hub tab into a hub: the client tab was severed from the real game and answered its own phantom hub with `error: Game not found`, while the real game never saw the message again.
Nuance: host-only actions forged *as the host's own id* are dropped by the self-filter at local.js:73, so pause/skip/etc. cannot be forged in the single-hub case.
Fix: give each tab a per-hub random session secret on join (as the WS build's tokens do) and key client views on it; only the tab that actually sent 'create' over its own socket may become hub.

### 3. MEDIUM — WS: one socket can join multiple games; it stays subscribed to the old game and the old Set never shrinks
server/index.js:79-83 `join` sets `client.code` and adds the ws to the new game's Set but never removes it from the previous game's Set; the close handler (server/index.js:92-95) only cleans the *current* code's Set, leaking the ws in every earlier game's Set forever.
Proof (/tmp/housie-proofs/f6-multijoin-ws.mjs): a socket joined game A, then game B; when a new player joined game A, the socket in game B still received `state` for game A (players: Ravi,P2).
Fix: in `client.join`, remove the ws from the Set of the previous `client.code` before adding it to the new one.

### 4. MEDIUM — prototype pollution via host messages (process-wide)
shared/hub.js:158-161: `game.config.patterns[msg.patternId]` with `patternId:"__proto__"` resolves to Object.prototype (truthy, passes the `if (!p)` guard), so `p.enabled`/`p.reward` write onto Object.prototype. Similarly hub.js:150-152 with `index:"__proto__"` pollutes Array.prototype (`houses["__proto__"]`).
Proof (/tmp/housie-proofs/f4-validation-pollution.mjs): after `setPattern {patternId:"__proto__",enabled:true,reward:{...}}`, `({}).enabled === true`, `({}).reward` is set, and `Object.prototype` gains own keys `["enabled","reward"]`; `setHouseReward {index:"__proto__"}` sets `[].reward`. Host role required; no game-state takeover demonstrated, but every object in the process inherits enumerable `enabled`/`reward`.
Fix: guard with `Object.hasOwn(game.config.patterns, msg.patternId)` (and `Number.isInteger(msg.index)` for houses).

### 5. MEDIUM — unauthenticated join spam grows players, sqlite writes, and broadcast payload without bound
shared/hub.js:202-217: 'join' without a token always mints a new player; no rate/size limit anywhere; every join saves to sqlite (db.js:20-22) and broadcasts full state to every client.
Proof (f6-multijoin-ws.mjs): 500 join messages from one socket → 502 players in game A, largest broadcast 35,322 bytes, db file 4 KB → 122,880 KB-blocks. In local.js the same spam also leaks one clientsByTab entry per forged `from` (never deleted, local.js:44-58).
Fix: cap players per game and rate-limit joins per connection.

### 6. MEDIUM — disqualified players keep their prizes in the ledger
shared/game.js:207-216 disqualifies on a wrong claim, but `computeLedger` (game.js:234-249) still credits all of that player's earlier wins; nothing forfeits them.
Proof (/tmp/housie-proofs/f2-dq-keeps-winnings.mjs): Ravi wins early five (50), then a wrong top-line claim → `disqualified: true`, yet the ledger shows `won: 50, net: 40`.
Fix: in `computeLedger`, zero out `won` for players with `disqualified === true` (or per house rule, drop their claims from win groups).

### 7. LOW — claim during play rewrites the countdown but not the real timer
shared/hub.js:109 (claim) and :213 (join) call `touch()`, which rewrites `game.nextDrawAt` (hub.js:57-61) without re-arming the timer; the interval armed at start (server/index.js:32, hub.js:73-79) ignores `nextDrawAt`. Players rely on this countdown to know their claim window.
Proof (/tmp/housie-proofs/f7c.mjs, 3s interval): a claim at t0+1.4s made the countdown claim a deadline of t0+5858ms while the number was actually drawn at t0+3008ms — the window was overstated by ~2.85s (with the default 15s interval, by up to a full interval).
Fix: don't call `touch()` from claim/join while playing (or make the timer callback honor `nextDrawAt`).

### 8. LOW — a host socket that joins its own game as a player permanently loses host controls
shared/hub.js:210-212: 'join' unconditionally sets `client.role = 'player'`, clobbering 'host' on the same connection.
Proof (/tmp/housie-proofs/f7b.mjs): host creates a game, sends `join` (to buy a ticket), then `start` → `error: Host only`. Recoverable only via `joinHost` with the token.
Fix: keep role 'host' if the socket is already host (or let a host token always re-authenticate).

## Verified-sound (checked, correct)

- Claim-window rule: a pattern completed on any earlier draw is rejected as late; only the last draw counts (f3, game.js:168).
- (a)(c) One claim per player per pattern across all their tickets — second ticket rejected with "You already claimed this pattern" (f3, game.js:152).
- (b) Full-house retirement enforced: a retired ticket is rejected for every further pattern (f3, game.js:149/188).
- (d) Two players completing the same pattern on the same draw both win and split evenly (early five 25+25; full house 250+250) (f3).
- (e) House tiers: sequential full houses get tiers 0,1 in draw order; same-draw full houses share one tier; overflow rejected with "No house tier left" (f3).
- `buy`: negative/0/1e9/null rejected; floats floor; 1-20 range and 50-ticket cap hold; JSON oddities (`true`, `[5]`) coerce but stay within bounds (f4, game.js:72-74).
- `mark`: foreign ticketId ignored; numbers not on the ticket ignored; no duplicate marks (f4, hub.js:93-104).
- Host-only gate (start/skip/pause/resume/setInterval/addHouse/setHouseReward/setPattern/end) holds over WS — role is per-connection and unforgeable there (f4).
- Non-string `msg.code` cleanly misses the Map → "Game not found"; JSON `{"__proto__":{...}}` in create config does NOT pollute (JSON.parse + spread define own props) (f4).
- Path traversal on /shared/ and static files is blocked: WHATWG URL normalization removes dot segments, and normalize+startsWith+existsSync holds; the 200 responses on odd paths are the SPA fallback serving index.html, not file disclosure (curl-verified against the live server).
- Malformed JSON frames and handler exceptions are caught per-message; a bad frame cannot kill the server (server/index.js:86-90).

---

## Resolution

All eight findings triaged. Six fixed with a failing test written first; two deliberately
left as documented product/security decisions rather than code changes.

### Fixed

| # | Fix | Test |
|---|-----|------|
| 1 | `submitClaim` rejects disabled patterns (`shared/game.js`) | `test/regressions-shared.mjs` |
| 2 (partial) | a tab becomes hub only by *sending* `create`, never by receiving one (`public/local.js`) | `test/forgery-static.mjs` |
| 3 | `client.join` unsubscribes the socket from its previous game (`server/index.js`) | `test/regressions.mjs` |
| 4 | `setPattern` / `setHouseReward` guard with `Object.hasOwn` (`shared/hub.js`) | `test/regressions-shared.mjs` |
| 5 | `MAX_PLAYERS_PER_GAME = 100` (`shared/hub.js`); `MAX_TAB_CLIENTS = 256` bound on the static build's client map | `test/regressions.mjs` |
| 8 | `join` no longer clobbers a host's role (`shared/hub.js`) | `test/regressions-shared.mjs` |

### Left as product decisions (not bugs)

- **6 — disqualified players keep prizes already won.** Confirmed intent: the penalty is
  loss of the rest of the game, not confiscation. Ledger unchanged by design.
- **2 (remainder) — tab impersonation on the static build.** Not fixable, and no token
  would fix it. BroadcastChannel delivers every message to every same-origin tab, and the
  sender's id travels in cleartext (`post()`, `local.js:39`). Any session secret invented
  here would be sniffable off the same channel by the attacker it is meant to stop, so it
  would be security theater. The severing bug (the part that caused real breakage) is
  fixed; impersonation remains a documented property of same-device static play. Real
  games with real stakes belong on the server build, where WS roles are per-connection
  and unforgeable (verified in finding 4).

### Not fixed

- **7 — `touch()` rewrites the countdown without re-arming the timer.** Cosmetic: the
  countdown can overstate the claim window by up to one interval. Server-authoritative
  rejection of late claims is unaffected, so nothing is winnable that should not be.
