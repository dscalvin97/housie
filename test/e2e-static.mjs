// E2E for the STATIC (GitHub Pages) build: the hub runs in the host tab over
// BroadcastChannel, no server. Drives a real host + player across two tabs.
// Usage: BASE=http://localhost:8899 node test/e2e-static.mjs  (server must serve dist/)
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8899';
const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// ---- host creates a game ----
const host = await ctx.newPage();
const errors = [];
host.on('pageerror', (e) => errors.push('host: ' + e.message));
await host.goto(BASE, { waitUntil: 'networkidle' });
ok((await host.evaluate(() => window.HOUSIE_STATIC)) === true, 'static flag is on');

await host.fill('#name', 'Calvin');
await host.click('#createBtn');
await host.waitForSelector('#createGame', { timeout: 5000 });
await host.click('#createGame');
await host.waitForSelector('.codebig', { timeout: 8000 });
const code = (await host.locator('.codebig').textContent()).trim();
ok(code.length === 6, `host created a room (${code})`);

// ---- player joins via deep link ----
const player = await ctx.newPage();
player.on('pageerror', (e) => errors.push('player: ' + e.message));
await player.goto(`${BASE}/?join=${code}`, { waitUntil: 'networkidle' });
try {
  await player.waitForSelector('text=buy your tickets', { timeout: 6000 });
  ok(true, 'player joined the in-browser hub via deep link');
} catch {
  ok(false, 'player join — stuck on: ' + (await player.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 60));
}

// player buys a ticket
await player.click('#buy');
await player.waitForTimeout(500);

// host should see 1 ticket
await host.waitForFunction(() => document.body.innerText.includes('1 ticket'), null, { timeout: 5000 }).catch(() => {});
ok((await host.locator('#players').innerText()).includes('1 ticket'), 'host sees the player ticket');

// ---- start + draw ----
await host.click('#start');
await host.waitForSelector('.board', { timeout: 6000 });
ok(true, 'game started');

await host.click('#pause');
await host.waitForTimeout(300);
// the just-called number renders as `.last`, earlier calls as `.on` (see boardHtml)
const countCalled = async (p) => p.locator('.board .n.on, .board .n.last').count();
const before = await countCalled(host);
await host.click('#skip');
await host.waitForTimeout(600);
const after = await countCalled(host);
ok(after > before, `manual draw marks a number (before=${before} after=${after})`);

// player sees the same board state
await player.waitForSelector('.board', { timeout: 5000 });
const playerOn = await player.locator('.board .n.on, .board .n.last').count().catch(() => 0);
ok(playerOn === after, `player board matches host (host=${after} player=${playerOn})`);

// ---- player claims (should be wrong: nothing complete) ----
const claimBtn = player.locator('[data-claim]').first();
if (await claimBtn.count()) {
  await claimBtn.click();
  await player.waitForTimeout(500);
  ok(true, 'claim sent to in-browser hub without throwing');
}

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\nstatic-e2e: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
