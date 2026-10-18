// Regression: joining a lobby when the WebSocket is ALREADY OPEN.
// Bug: connect() early-returned on an open socket without sending anything,
// so (a) the join button did nothing once the socket was warm, and
// (b) a second tab on the same device (shared localStorage -> lastHost)
//     hung forever on "Loading…" because joinHost was never sent.
import { chromium } from 'playwright';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3909';
const results = [];
const ok = (cond, name) => { results.push([cond, name]); if (!cond) console.error('  FAIL:', name); };

// create a room over a raw ws client so the browser tests get a live code
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const { code, close } = await createRoom();
console.log('room:', code);

// ---- A: join button pressed when the socket is already OPEN ----
{
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200); // socket certainly OPEN by now
  await p.fill('#name', 'Ravi');
  await p.fill('#code', code);
  await p.click('#joinBtn');
  try {
    await p.waitForSelector('text=buy your tickets', { timeout: 4000 });
    ok(true, 'join button works with a pre-opened socket');
  } catch {
    ok(false, 'join button works with a pre-opened socket (page stuck: ' + (await p.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 60) + ')');
  }
  await p.close();
}

// ---- B: second tab on the same device (shared localStorage) — the reported hang ----
{
  const host = await ctx.newPage(); // same context: shares localStorage with tab A
  await host.goto(BASE, { waitUntil: 'networkidle' });
  await host.fill('#name', 'Calvin');
  await host.click('#createBtn');
  await host.waitForSelector('#createGame', { timeout: 5000 });
  await host.click('#createGame');
  await host.waitForSelector('.codebig', { timeout: 5000 });
  const hostCode = (await host.locator('.codebig').textContent()).trim();
  ok(hostCode.length === 6, 'tab 1 creates a game');

  // lastHost is written by a 2s interval once the host session is live; wait for it
  // explicitly instead of racing the timer.
  await host.waitForFunction(() => !!localStorage.getItem('housie:lastHost'), null, { timeout: 8000 });

  const tab2 = await ctx.newPage(); // same phone, second tab
  await tab2.goto(BASE, { waitUntil: 'networkidle' });
  try {
    // after the fix: the second tab resumes the host session (room code visible), no hang
    await tab2.waitForSelector('.codebig', { timeout: 4000 });
    ok(true, 'second tab resumes host session instead of hanging on Loading');
  } catch {
    ok(false, 'second tab resumes host session (stuck on: ' + (await tab2.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 60) + ')');
  }

  // ---- C: deep link ?join= on the same device must join AS A PLAYER
  //         even though lastHost exists (that is how the host phone plays too) ----
  const tab3 = await ctx.newPage();
  await tab3.goto(`${BASE}/?join=${hostCode}`, { waitUntil: 'networkidle' });
  try {
    await tab3.waitForSelector('text=buy your tickets', { timeout: 4000 });
    ok(true, '?join= deep link becomes a player despite lastHost in storage');
  } catch {
    ok(false, '?join= deep link becomes a player (stuck on: ' + (await tab3.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 60) + ')');
  }
  await tab2.close(); await tab3.close(); await host.close();
}

close();
await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\njoin-race: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
