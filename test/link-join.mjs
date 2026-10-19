// Regression: joining via a link (?join=CODE) rather than retyping the room code.
// Covers the two ways a link fails on a real phone:
//   1. first-time player has no stored name -> boot() bailed to viewHome() and
//      DISCARDED the join code, so retyping the name did nothing;
//   2. the installed PWA strips location.search on launch, so the code must also
//      survive as a pending intent and be re-applied after the home form renders.
import { chromium } from 'playwright';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3909';
const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };

function createRoom() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create', config: {} })));
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'created') resolve({ code: m.game.code, close: () => ws.close() }); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('create room timeout')), 4000);
  });
}

const browser = await chromium.launch();
const { code, close } = await createRoom();
console.log('room:', code);

// ---- A: first-time player, no stored name, opens the link ----
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/?join=${code}`, { waitUntil: 'networkidle' });
  try {
    await p.waitForSelector('text=buy your tickets', { timeout: 3000 });
    ok(true, 'link with no stored name still joins (guest name assigned)');
  } catch {
    ok(false, 'link with no stored name joins — stuck on: ' + (await p.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 50));
  }
  // the server defaults a missing name, so the lobby must show that guest name
  const joinedName = await p.locator('text=/Player|buy your tickets/').first().innerText().catch(() => '');
  ok(/Player/.test(joinedName), `guest player is named "Player" (got "${joinedName}")`);
  await ctx.close();
}

// ---- B: returning player with a stored name, opens the link ----
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#name', 'Ravi');
  await p.waitForTimeout(300); // let the input handler persist the name
  await p.goto(`${BASE}/?join=${code}`, { waitUntil: 'networkidle' });
  try {
    await p.waitForSelector('text=buy your tickets', { timeout: 4000 });
    ok(true, 'link with a stored name joins as a player');
  } catch {
    ok(false, 'link with a stored name joins — stuck on: ' + (await p.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 50));
  }
  await ctx.close();
}

// ---- C: installed-PWA simulation: the launch URL loses its query string ----
// boot() must keep the code as a pending intent, so the home form can still join.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.evaluate((c) => {
    // what an iOS standalone launch looks like: query stripped, code only in the referrer
    history.replaceState(null, '', '/');
    localStorage.setItem('housie:pendingJoin', JSON.stringify(c));
  }, code);
  await p.reload({ waitUntil: 'networkidle' });
  try {
    await p.waitForSelector('text=buy your tickets', { timeout: 4000 });
    ok(true, 'pending join intent survives a stripped launch URL (no form needed)');
  } catch {
    ok(false, 'pending join intent survives — stuck on: ' + (await p.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 50));
  }
  // and the intent must be consumed so a later plain visit lands on home
  const pending = await p.evaluate(() => localStorage.getItem('housie:pendingJoin'));
  ok(pending === null, `pending intent is cleared after joining (got ${pending})`);
  await ctx.close();
}

close();
await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\nlink-join: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
