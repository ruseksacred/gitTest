import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

const app = await createApp({ database: ':memory:', countdownMs: 50 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })]);
  for (const context of contexts) await context.addInitScript(() => {
    const Native = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.__testSockets.push(this); }
    };
  });
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  for (const [index, page] of [a, b].entries()) {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('[data-action="auth"]').click();
    await page.locator('[data-action="switch-auth"]').click();
    await page.locator('#username').fill(index ? 'ReconnectB' : 'ReconnectA');
    await page.locator('#password').fill('Browser-password-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
    await page.locator('[data-mode="duel"]').click();
    await page.locator('[data-size="3"]').click();
  }
  async function play() {
    const code = await a.locator('#display-code').textContent();
    await b.locator('#room-code').fill(code);
    await b.locator('#join-form button').click();
    await a.locator('#ready-button').click(); await b.locator('#ready-button').click();
    await Promise.all([a.locator('[data-number="1"]').waitFor(), b.locator('[data-number="1"]').waitFor()]);
    assert.deepEqual(await a.locator('[data-number]').allTextContents(), await b.locator('[data-number]').allTextContents());
    for (let n = 1; n <= 9; n++) await a.locator(`[data-number="${n}"]`).click();
    for (let n = 1; n <= 9; n++) await b.locator(`[data-number="${n}"]`).tap();
    await Promise.all([a.locator('.result-time').waitFor(), b.locator('.result-time').waitFor()]);
  }
  await a.locator('#start-button').click();
  await play();
  // A phone can suspend/lose its socket while looking at completed results.
  await contexts[0].setOffline(true);
  await a.locator('#connection-banner').waitFor();
  await contexts[0].setOffline(false);
  await a.locator('[data-action="again"]').click();
  await a.locator('#display-code').waitFor({ timeout: 10000 });
  await b.locator('.result-actions [data-action="leave"]').click();
  await play();
  const totals = await a.evaluate(async () => (await (await fetch('/api/stats')).json()).totals);
  assert.equal(totals.games, 2);
  assert.equal(totals.wins + totals.losses + totals.draws, 2);
  // Simulate a half-open mobile transport: readyState still says OPEN, but
  // application pings are lost and closing the old socket does not reach it.
  await a.evaluate(() => {
    const ws = window.__testSockets.at(-1), send = ws.send.bind(ws);
    ws.send = raw => { if (JSON.parse(raw).action !== 'ping') send(raw); };
    ws.close = () => {};
  });
  await a.locator('[data-action="again"]').click();
  await a.locator('#display-code').waitFor({ timeout: 10000 });
  await b.locator('.result-actions [data-action="leave"]').click();
  await play();
  assert.equal((await a.evaluate(async () => (await (await fetch('/api/stats')).json()).totals)).games, 3);
  assert.equal(await a.locator('#connection-banner').isVisible(), false);
  const duplicate = await contexts[0].newPage();
  duplicate.on('pageerror', error => errors.push(error.message));
  await duplicate.goto(base);
  await duplicate.waitForFunction(() => document.querySelector('#connection-message').textContent.includes('innej karcie'));
  assert.equal(await a.locator('#connection-banner').isVisible(), false);
  await a.locator('[data-action="again"]').click();
  await a.locator('#display-code').waitFor();
  await duplicate.close();
  assert.deepEqual(errors, []);
  console.log('PASS: three consecutive duels, offline recovery, a half-open socket, and duplicate-tab protection; no reload or repeated login.');
} finally { await browser.close(); await app.close(); }
