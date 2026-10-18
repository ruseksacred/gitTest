import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'rf-browser-'));
const target = databaseFixture(process.env.TEST_DATABASE_URL ? undefined : join(directory, 'db.sqlite'));
const app = await createApp({ ...target.options, countdownMs: 150 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
mkdirSync('test-results', { recursive: true });
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await desktop.newPage(), b = await mobile.newPage();
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
  await a.goto(base);
  await a.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  async function register(page, username) {
    await page.goto(base);
    await page.locator('[data-action="auth"]').click();
    await page.locator('[data-action="switch-auth"]').click();
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('Browser-password-123');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  }
  await register(a, 'ApexDriver');
  await register(b, 'TrackPilot');
  for (const page of [a, b]) {
    assert.deepEqual(await page.locator('[data-size]').evaluateAll(buttons => buttons.map(b => +b.dataset.size)), [4, 5, 6, 7]);
    assert.deepEqual(await page.locator('#ranking-size option').evaluateAll(options => options.map(o => +o.value)), [4, 5, 6, 7]);
    for (const size of [6, 7]) {
      await page.locator(`[data-size="${size}"]`).click();
      assert.equal(await page.locator('#preview-board span').count(), size ** 2);
      assert.equal(await page.locator('#preview-board').evaluate(board => getComputedStyle(board).gridTemplateColumns.split(' ').length), size);
      assert.match(await page.locator('#size-description').textContent(), new RegExp(`${size ** 2} liczb`));
    }
  }
  await b.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout must not overflow horizontally');
  await a.locator('[data-size="6"]').click();
  await a.locator('[data-action="start"]').click();
  await a.locator('[data-number="1"]').waitFor();
  await a.locator('[data-number="2"]').click();
  await a.waitForFunction(() => document.querySelector('#race-errors').textContent === '+1 s');
  for (let n = 1; n <= 36; n++) { await a.locator(`[data-number="${n}"]`).click(); await a.waitForFunction(n => !document.querySelector('#next-number') || document.querySelector('#next-number').textContent === String(n + 1), n); }
  await a.locator('.result-time').waitFor();
  assert.match(await a.locator('.result-header h3').textContent(), /Dobry przejazd/);
  await a.waitForFunction(() => document.querySelector('#best-time').textContent !== '—');
  await a.locator('.result-actions [data-action="leave"]').click();
  await a.locator('[data-mode="duel"]').click();
  for (const size of [4, 5, 6]) await a.locator(`#duel-track-${size}`).uncheck();
  await a.locator('#duel-track-7').check();
  await a.locator('#duel-laps-7').fill('3');
  await a.locator('[data-action="start"]').click();
  const code = await a.locator('#display-code').textContent();
  await b.locator('[data-mode="duel"]').click();
  await b.locator('#room-code').fill(code);
  await b.locator('#join-form button').click();
  await a.locator('#ready-button').click();
  await b.locator('#ready-button').click();
  await a.locator('[data-number="1"]').waitFor();
  await b.locator('[data-number="1"]').waitFor();
  assert.equal(await b.locator('[data-number]').count(), 49);
  assert.equal(await b.locator('#number-board').evaluate(board => getComputedStyle(board).gridTemplateColumns.split(' ').length), 7);
  await b.setViewportSize({ width: 320, height: 740 });
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '7×7 must fit a narrow phone');
  const smallestCell = await b.locator('[data-number="49"]').boundingBox();
  assert.ok(smallestCell.width >= 24 && smallestCell.height >= 24, 'All 49 targets remain tappable');
  await b.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await a.locator('[data-number]').allTextContents(), await b.locator('[data-number]').allTextContents());
  await a.screenshot({ path: 'test-results/duel-desktop.png', fullPage: true });
  await b.screenshot({ path: 'test-results/duel-mobile.png', fullPage: true });
  const layouts = [];
  for (const [index, page] of [a, b].entries()) {
    for (let lap = 1; lap <= 3; lap++) {
      await page.waitForFunction(lap => document.querySelector('#champ-lap-label')?.textContent.includes(`Okrążenie ${lap}/3`), lap);
      if (!index) layouts.push(await page.locator('[data-number]').allTextContents());
      else assert.deepEqual(await page.locator('[data-number]').allTextContents(), layouts[lap - 1]);
      for (let n = 1; n <= 49; n++) await page.locator(`[data-number="${n}"]`).click();
    }
    if (!index) {
      await page.locator('.champ-finished').waitFor();
      assert.match(await b.locator('#champ-lap-label').textContent(), /Okrążenie 1/);
    }
  }
  await Promise.all([a.locator('.result-time').waitFor(), b.locator('.result-time').waitFor()]);
  await a.waitForFunction(() => document.querySelector('#ranking-status').textContent.startsWith('3 przejazdy'));
  const runs = await a.evaluate(async () => (await (await fetch('/api/runs?mode=duel&size=7')).json()).rows);
  assert.equal(new Set(runs.map(r => r.id)).size, 3);
  assert.match(await a.locator('.result-time').textContent(), /2 : 1/);
  await a.screenshot({ path: 'test-results/results-desktop.png', fullPage: true });
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Rematch controls fit the phone');
  await b.locator('.training-panel').screenshot({ path: 'test-results/rematch-mobile.png' });
  await b.locator('.result-actions [data-action="leave"]').click();
  await a.waitForFunction(() => document.querySelector('#rematch-status').textContent.includes('opuścił pokój'));
  assert.equal(await a.locator('[data-action="rematch"]').isDisabled(), true);
  await a.locator('[data-action="logout"]').click();
  await a.locator('[data-action="auth"]').click();
  // The dialog retains registration mode after the first successful registration.
  await a.locator('[data-action="switch-auth"]').click();
  await a.locator('#username').fill('ApexDriver');
  await a.locator('#password').fill('Browser-password-123');
  await a.locator('#auth-submit').click();
  await a.waitForFunction(async () => (await (await fetch('/api/stats')).json()).totals?.games === 3);
  await a.locator('[data-mode="solo"]').click();
  await a.locator('[data-size="6"]').click();
  assert.notEqual(await a.locator('#best-time').textContent(), '—');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: sizes 4–7, solo with penalty, three independent 7×7 laps, championship points, independent rankings, departure, stats after login, narrow phone layout.');
} finally {
  await browser.close(); await app.close(); await target.cleanup(); rmSync(directory, { recursive: true, force: true });
}
