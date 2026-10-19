// E2E for the STATIC (GitHub Pages) build's forgery resistance — finding f2.
//
// Bug: public/local.js flipped EVERY tab into a hub the moment any tab sent a
// 'create' message. Because the channel is shared, one forged 'create' severed every
// other tab from the real game (each became its own hub and answered nothing).
//
// Scope note: same-device hardening only. A token cannot authenticate tabs here,
// because BroadcastChannel delivers every message to every same-origin tab and the
// sender's id travels in cleartext (see post() in local.js). Cross-device play on
// Pages is a separate, larger design and is deliberately out of scope.
//
// Usage: BASE=http://localhost:8899 node test/forgery-static.mjs  (server must serve dist/)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8899';
const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// ---- host creates a game, player joins ----
const host = await ctx.newPage();
const errors = [];
host.on('pageerror', (e) => errors.push('host: ' + e.message));
await host.goto(BASE, { waitUntil: 'networkidle' });
await host.fill('#name', 'Calvin');
await host.click('#createBtn');
await host.waitForSelector('#createGame', { timeout: 5000 });
await host.click('#createGame');
await host.waitForSelector('.codebig', { timeout: 8000 });
const code = (await host.locator('.codebig').textContent()).trim();

const player = await ctx.newPage();
player.on('pageerror', (e) => errors.push('player: ' + e.message));
await player.goto(`${BASE}/?join=${code}`, { waitUntil: 'networkidle' });
await player.waitForSelector('text=buy your tickets', { timeout: 6000 });
ok(true, 'player joined the in-browser hub');

// ---- attacker: a tab that only speaks raw channel protocol ----
const attacker = await ctx.newPage();
await attacker.goto(BASE, { waitUntil: 'networkidle' });
await attacker.evaluate(() => {
  const ch = new BroadcastChannel('housie');
  // forge a create claiming to come from an id that is not ours
  ch.postMessage({ __housie: true, from: 'forged-hub-' + Math.random(), to: 'hub', payload: { type: 'create', config: {} } });
});
await attacker.waitForTimeout(600);

// ---- the real game must survive ----
// Before the fix, the player tab had become its own hub, so this buy went nowhere
// and the host never saw a ticket.
await player.click('#buy');
const hostSawTicket = await host
  .waitForFunction(() => document.body.innerText.includes('1 ticket'), null, { timeout: 5000 })
  .then(() => true)
  .catch(() => false);
ok(hostSawTicket, 'forged create does not sever the player tab from the real game');

// and the host must still be able to start it
if (hostSawTicket) {
  await host.click('#start');
  const started = await host
    .waitForSelector('.board', { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  ok(started, 'host can still start the game after a forged create');
} else {
  ok(false, 'host can still start the game after a forged create (skipped: player already severed)');
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\nforgery-static: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
