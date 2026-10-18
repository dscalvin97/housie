// UI smoke: drive the real app in headless Chromium, host + player, screenshot both.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://housie.makes.fyi';
const OUT = '/tmp/opus';
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('console', (m) => console.log('  [host:' + m.type() + ']', m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('websocket', (ws) => {
  console.log('  [host ws] created', ws.url());
  ws.on('framereceived', (f) => { const s = String(f.payload).slice(0, 90); if (s.includes('"type"')) console.log('  [host ws recv]', s); });
  ws.on('framesent', (f) => console.log('  [host ws send]', String(f.payload).slice(0, 90)));
  ws.on('close', () => console.log('  [host ws] CLOSED'));
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
console.log('title:', await page.title());
console.log('h1:', await page.locator('h1').first().textContent().catch(() => '(none)'));

// PWA manifest + SW registered?
const manifest = await page.evaluate(async () => {
  const r = await fetch('/manifest.webmanifest'); return { status: r.status, name: (await r.json()).name };
});
console.log('manifest:', manifest.status, manifest.name);
const swReady = await page.evaluate(async () => {
  if (!navigator.serviceWorker) return 'no-sw-api';
  const reg = await navigator.serviceWorker.ready; return reg.active ? 'active' : 'installed';
});
console.log('service worker:', swReady);

// ---- host flow ----
await page.fill('#name', 'Calvin');
await page.click('#createBtn');
await page.waitForSelector('text=New game', { timeout: 5000 });
await shot(page, '02-create-form');

// tweak a setting to prove the form is interactive
await page.selectOption('#penalty', 'none');
await page.click('#createGame');
await page.waitForSelector('.codebig', { timeout: 5000 });
const code = (await page.locator('.codebig').textContent()).trim();
console.log('room code:', code);
await shot(page, '03-host-lobby');

// host token persisted for resume?
const hostKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('hostToken')));
console.log('host token saved:', hostKeys.length > 0);

// ---- player flow in a second context (separate storage) ----
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => console.log('  [p2 PAGEERROR]', e.message));
p2.on('console', (m) => console.log('  [p2:' + m.type() + ']', m.text()));
p2.on('requestfailed', (r) => console.log('  [p2 reqfail]', r.url(), r.failure()?.errorText));
p2.on('websocket', (ws) => {
  console.log('  [p2 ws] created', ws.url());
  ws.on('framereceived', (f) => { const s = String(f.payload).slice(0, 90); if (s.includes('"type"')) console.log('  [p2 ws recv]', s); });
  ws.on('framesent', (f) => console.log('  [p2 ws send]', String(f.payload).slice(0, 90)));
  ws.on('close', () => console.log('  [p2 ws] CLOSED'));
});
await p2.goto(BASE, { waitUntil: 'networkidle' });
await p2.fill('#name', 'Ravi');
await p2.fill('#code', code);
console.log('  [p2] filled code=', JSON.stringify(code), 'input value=', JSON.stringify(await p2.inputValue('#code')));
p2.on('console', (m) => { if (m.text().includes('toast')) console.log('  [p2 toast]', m.text()); });
await p2.click('#joinBtn');
await p2.waitForTimeout(600);
console.log('  [p2] toast after join click:', JSON.stringify(await p2.locator('#toast').textContent().catch(() => '(none)')), 'hidden=', await p2.locator('#toast').isHidden().catch(() => '?'));
try {
  await p2.waitForSelector('text=buy your tickets', { timeout: 8000 });
  console.log('player joined, lobby shown');
} catch {
  console.log('JOIN FAILED — player page body:', (await p2.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200));
  await p2.screenshot({ path: `${OUT}/join-failed.png`, fullPage: true });
  await browser.close();
  process.exit(1);
}
await p2.click('#buy'); // buy 1
await p2.waitForTimeout(700);
await p2.screenshot({ path: `${OUT}/04-player-lobby.png`, fullPage: true });
console.log('player bought ticket, lobby shown');

// host should now see 1 player
await page.waitForTimeout(700);
const hostText = await page.locator('#players').textContent().catch(() => '');
console.log('host sees players:', JSON.stringify(hostText.trim().slice(0, 40)));

// ---- start game ----
await page.click('#start');
await page.waitForSelector('.board', { timeout: 5000 });
await page.waitForTimeout(600);
await shot(page, '05-host-game');
await p2.waitForSelector('.board', { timeout: 5000 });
await p2.waitForTimeout(400);
await p2.screenshot({ path: `${OUT}/06-player-game.png`, fullPage: true });

const lastNum = await page.locator('.lastnum .big').textContent().catch(() => '(none)');
console.log('host last number:', lastNum.trim());
const claimBtns = await p2.locator('[data-claim]').count();
console.log('player claim buttons:', claimBtns);

// ---- pause + manual draw (host pacing) ----
await page.click('#pause');
await page.waitForTimeout(300);
const pausedTag = await page.locator('.tag.warn').first().textContent().catch(() => '');
console.log('after pause tag:', pausedTag.trim());
await page.click('#skip');
await page.waitForTimeout(500);
const lastNum2 = await page.locator('.lastnum .big').textContent().catch(() => '(none)');
console.log('after manual draw:', lastNum2.trim(), '(changed:', lastNum.trim() !== lastNum2.trim(), ')');

await browser.close();
console.log('\nconsole/page errors:', errors.length ? errors : 'none');
process.exit(errors.length ? 1 : 0);
