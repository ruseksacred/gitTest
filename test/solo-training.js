import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';

const target = databaseFixture();
const app = await createApp({ ...target.options, countdownMs: 100 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
mkdirSync('test-results', { recursive: true });
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // The phone uses the same timing flow through the HTTPS fallback.
  await mobile.addInitScript(() => { const Native = window.WebSocket; window.WebSocket = class extends Native { constructor() { throw new DOMException('Test HTTPS fallback', 'SecurityError'); } }; });
  const pages = [];
  for (const [i, context] of [desktop, mobile].entries()) {
    const response = await context.request.post(`${base}/api/register`, { headers: { Origin: base }, data: { username: `SoloTiming${i}`, password: 'Solo-training-test-123' } });
    assert.equal(response.status(), 201);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#/solo`);
    await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
    for (const size of [4, 5, 6, 7]) {
      await page.locator(`[data-size="${size}"]`).click();
      assert.match(await page.locator('#solo-plan-summary').textContent(), new RegExp(`Tor ${size}×${size}`));
      assert.equal(await page.locator('#preview-board span').count(), size ** 2);
    }
    await page.locator('[data-size="4"]').click();
    await page.locator('#solo-laps').fill('0');
    await page.locator('#start-button').click();
    assert.equal(await page.locator('#setup').isVisible(), true);
    await page.locator('#solo-laps').fill('3');
    assert.match(await page.locator('#solo-plan-summary').textContent(), /3 okr.*9 min/);
  }
  const [a, b] = pages;
  await a.screenshot({ path: 'test-results/solo-configuration-desktop.png', fullPage: true });
  await b.screenshot({ path: 'test-results/solo-configuration-mobile.png', fullPage: true });
  await a.locator('#start-button').click();
  for (let lap = 1; lap <= 3; lap++) {
    await a.waitForFunction(lap => document.querySelector('#solo-lap-label')?.textContent === `Okrążenie ${lap}/3`, lap);
    assert.equal(await a.locator('[data-number]').count(), 16);
    assert.equal(await a.locator('[data-action="ready"]').count(), 0);
    if (lap === 1) {
      assert.equal(await a.locator('#pb-delta').textContent(), '—');
      await a.locator('[data-number="2"]').click();
      await a.waitForFunction(() => document.querySelector('#race-errors').textContent === '+1 s');
    } else {
      assert.notEqual(await a.locator('#pb-time').textContent(), '—');
      assert.equal(await a.locator('#race-errors').textContent(), '+0 s');
      assert.equal(await a.locator('[data-solo-lap="1"] td').nth(1).textContent(), '+1 s');
    }
    await a.locator('[data-number="1"]').click();
    if (lap === 2) {
      await a.waitForFunction(() => document.querySelector('#pb-delta').textContent !== '—');
      assert.match(await a.locator('#delta-meta').textContent(), /po liczbie 1/);
      assert.equal(await a.locator('.result-time').count(), 0);
      await a.locator('.training-panel').screenshot({ path: 'test-results/solo-live-timing-desktop.png' });
    }
    for (let n = 2; n <= 16; n++) await a.locator(`[data-number="${n}"]`).click();
  }
  await a.locator('#solo-save-status').waitFor();
  assert.match(await a.locator('#solo-save-status').textContent(), /Zapisano 3 \/ 3/);
  assert.match(await a.locator('.result-header h3').textContent(), /Trening ukończony/);
  assert.equal(await a.locator('[data-solo-lap]').count(), 3);
  const runs = (await (await a.request.get(`${base}/api/runs?mode=solo&size=4`)).json()).rows;
  assert.equal(runs.length, 3);
  const total = runs.reduce((n, row) => n + row.score, 0);
  assert.equal(Number((await a.locator('.result-time').textContent()).trim().split(' ')[0]), total / 100);
  assert.equal(runs.reduce((n, row) => n + row.errors, 0), 1);
  await a.locator('.training-panel').screenshot({ path: 'test-results/solo-results-desktop.png' });
  await a.locator('[data-action="again"]').click();
  await a.locator('[data-number="1"]').waitFor();
  assert.match(await a.locator('#solo-lap-label').textContent(), /1\/3/);
  assert.match(await a.locator('#pb-meta').textContent(), /Pierwsze kółko/);
  assert.equal(await a.locator('#pb-time').textContent(), '—');
  await a.locator('[data-number="1"]').click();
  await a.waitForFunction(() => document.querySelector('#next-number')?.textContent === '2');
  assert.equal(await a.locator('#pb-delta').textContent(), '—');
  await a.locator('[data-action="leave"]').click(); await a.locator('[data-action="confirm-leave"]').click();
  await a.locator('#setup').waitFor();

  // A large board and all timing instruments must fit a narrow phone.
  await b.locator('[data-size="7"]').click();
  await b.locator('#solo-laps').fill('1');
  await b.locator('#start-button').click();
  await b.locator('[data-number="1"]').waitFor();
  await b.setViewportSize({ width: 320, height: 740 });
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await b.locator('[data-number]').count(), 49);
  await b.locator('.training-panel').screenshot({ path: 'test-results/solo-live-timing-mobile.png' });
  for (let n = 1; n <= 49; n++) await b.locator(`[data-number="${n}"]`).tap();
  await b.locator('#solo-save-status').waitFor();
  assert.match(await b.locator('#solo-save-status').textContent(), /Zapisano 1 \/ 1/);
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await b.locator('.training-panel').screenshot({ path: 'test-results/solo-results-mobile.png' });
  await a.reload();
  await a.locator('[data-size="4"]').click();
  await a.waitForFunction(() => document.querySelector('#record-meta').textContent.includes('3 ukończonych okrążeń'));
  assert.deepEqual(errors, []);
  console.log('Solo training passed: track/lap selection, three continuous laps, penalties, current-session delta, per-lap ranking, repeated training, reset reference, 320px phone and HTTPS fallback.');
} finally { await browser.close(); await app.close(); await target.cleanup(); }
