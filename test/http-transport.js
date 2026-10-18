import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';

const target = databaseFixture();
const app = await createApp({ ...target.options, countdownMs: 50 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
let blockedSockets = 0, streams = 0, authQueries = 0, blockStreams = false, allowSockets = false, acceptedSockets = 0;
const originalGet = app.db.get;
app.db.get = (sql, ...args) => { if (sql.includes('FROM sessions s')) authQueries++; return originalGet(sql, ...args); };
const proxy = createServer((req, res) => {
  if (req.url.startsWith('/api/events')) { streams++; if (blockStreams) { res.writeHead(503); res.end(); return; } }
  app.server.emit('request', req, res);
});
proxy.on('upgrade', (req, socket, head) => {
  if (allowSockets) { acceptedSockets++; app.server.emit('upgrade', req, socket, head); }
  else { blockedSockets++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })]);
  await contexts[1].addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native { constructor() { throw new DOMException('WebSocket blocked by browser policy', 'SecurityError'); } };
  });
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  let lastCommand;
  a.on('request', request => { if (new URL(request.url()).pathname === '/api/play') lastCommand = request.postDataJSON(); });
  for (const [index, page] of [a, b].entries()) {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('[data-action="auth"]').click();
    await page.locator('[data-action="switch-auth"]').click();
    await page.locator('#username').fill(index ? 'HttpDriverB' : 'HttpDriverA');
    await page.locator('#password').fill('Browser-password-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
    assert.equal(await page.locator('#connection-banner').isVisible(), false);
    await page.locator('.app-menu [data-route="championship"]').click();
    await page.locator('#duel-track-5').uncheck();
    await page.locator('#duel-laps-4').fill('1');
  }
  assert.ok(blockedSockets >= 1 && streams >= 2, 'Both a rejected WS upgrade and a synchronous browser SecurityError must fall back to HTTPS');
  let roomCode;
  async function playRound(round, rematch = false) {
    if (rematch) {
      await a.locator('[data-action="rematch"]').click();
      await a.waitForFunction(() => document.querySelector('#rematch-status').textContent.includes('Czekamy na rywala'));
      await b.locator('[data-action="rematch"]').tap();
    } else {
      roomCode = await a.locator('#display-code').textContent();
      await b.locator('#room-code').fill(roomCode); await b.locator('#join-form button').click();
      await a.locator('#ready-button').click(); await b.locator('#ready-button').click();
    }
    await Promise.all([a.locator('[data-number="1"]').waitFor(), b.locator('[data-number="1"]').waitFor()]);
    assert.ok((await a.locator('.game-top').textContent()).includes(roomCode));
    assert.deepEqual(await a.locator('[data-number]').allTextContents(), await b.locator('[data-number]').allTextContents());
    const queriesBefore = authQueries;
    // Burst clicks deliberately: HTTP commands must remain in sequence.
    await a.evaluate(() => { for (let n = 1; n <= 15; n++) document.querySelector(`[data-number="${n}"]`).click(); });
    await a.waitForFunction(() => document.querySelector('#next-number').textContent === '16');
    assert.equal(authQueries, queriesBefore, 'No database authentication query is allowed per timed HTTPS click');
    await a.locator('[data-number="16"]').click();
    for (let n = 1; n <= 16; n++) await b.locator(`[data-number="${n}"]`).tap();
    await Promise.all([a.locator('.result-time').waitFor(), b.locator('.result-time').waitFor()]);
    const totals = await a.evaluate(async () => (await (await fetch('/api/stats')).json()).totals);
    assert.equal(totals.games, round);
    assert.equal(totals.wins + totals.losses + totals.draws, round);
    const history = await a.evaluate(async () => (await (await fetch('/api/stats')).json()).history);
    assert.equal(history[0].errors, 0, 'Queued HTTPS clicks must arrive in order');
  }
  await a.locator('#start-button').click(); await playRound(1);
  await playRound(2, true);
  const oldStream = { ...lastCommand };
  await contexts[0].setOffline(true); await a.locator('#connection-banner').waitFor();
  await contexts[0].setOffline(false);
  await a.locator('[data-action="again"]').click(); await a.locator('#display-code').waitFor();
  const stale = await a.request.post(base + '/api/play', { data: { ...oldStream, action: 'hit', number: 1 } });
  assert.equal(stale.status(), 409, 'Commands from the old connection must never affect the next game');
  await b.locator('.result-actions [data-action="leave"]').click();
  await playRound(3);
  const denied = await a.request.post(base + '/api/play', { headers: { Origin: 'https://attacker.example' }, data: { action: 'create', client: 'wrong' } });
  assert.equal(denied.status(), 403);
  const anonymous = await contexts[1].request.post(base + '/api/play', { data: { client: 'not-a-real-stream', action: 'hit', number: 1 } });
  assert.equal(anonymous.status(), 409);
  blockStreams = true;
  await a.reload();
  await a.waitForFunction(() => document.querySelector('#connection-message').textContent.includes('Nie udało się połączyć.'), undefined, { timeout: 20000 });
  assert.ok(!(await a.locator('#setup-footnote').textContent()).includes('Łączenie'));
  assert.equal(await a.locator('[data-action="reconnect"]').isEnabled(), true);
  blockStreams = false;
  await a.locator('[data-action="reconnect"]').click();
  await a.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  allowSockets = true;
  await a.reload();
  await a.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  assert.ok(acceptedSockets >= 1);
  await a.locator('.app-menu [data-route="championship"]').click(); await a.locator('#duel-track-5').uncheck(); await a.locator('#duel-laps-4').fill('1');
  await a.locator('#start-button').click();
  await b.locator('.result-actions [data-action="leave"]').click();
  await playRound(4);
  assert.deepEqual(errors, []);
  console.log('PASS: HTTPS fallback, rematch in the same room, four duels including mixed WS/HTTP, ordered clicks, no per-click DB reads, offline recovery, bounded failures and manual retry.');
} finally {
  await browser.close();
  await new Promise(resolve => proxy.close(resolve));
  await app.close();
  await target.cleanup();
}
