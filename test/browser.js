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
  await a.locator('[data-size="7"]').click();
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
  for (let n = 1; n <= 49; n++) await a.locator(`[data-number="${n}"]`).click();
  await a.waitForFunction(() => document.querySelector('#game-hint').textContent.startsWith('Meta!'));
  for (let n = 1; n <= 49; n++) await b.locator(`[data-number="${n}"]`).tap();
  await a.locator('.result-time').waitFor(); await b.locator('.result-time').waitFor();
  await a.waitForFunction(() => document.querySelector('#total-wins').textContent === '1');
  await b.waitForFunction(() => document.querySelector('#total-losses').textContent === '1');
  await a.waitForFunction(() => document.querySelector('#ranking-size').value === '7' && document.querySelector('#ranking-status').textContent.startsWith('1 przejazd'));
  const roundIds = [];
  roundIds.push(await a.locator('.ranking-new').getAttribute('data-run-id'));
  for (const round of [2, 3]) {
    assert.equal(await a.locator('[data-action="rematch"]').isEnabled(), true);
    await a.locator('[data-action="rematch"]').click();
    await a.waitForFunction(() => document.querySelector('#rematch-status').textContent.includes('Czekamy na rywala'));
    assert.equal(await a.locator('[data-action="rematch"]').isDisabled(), true);
    assert.equal(await b.locator('.result-time').isVisible(), true, 'One player cannot start the next round alone');
    await b.locator('[data-action="rematch"]').tap();
    await Promise.all([a.locator('[data-number="1"]').waitFor(), b.locator('[data-number="1"]').waitFor()]);
    assert.match(await a.locator('.game-top').textContent(), new RegExp(`${code} · RUNDA ${round}`));
    assert.match(await b.locator('.game-top').textContent(), new RegExp(`${code} · RUNDA ${round}`));
    assert.equal(await b.locator('#race-errors').textContent(), '+0 s');
    assert.deepEqual(await a.locator('[data-number]').allTextContents(), await b.locator('[data-number]').allTextContents());
    for (let n = 1; n <= 49; n++) await a.locator(`[data-number="${n}"]`).click();
    await a.waitForFunction(() => document.querySelector('#game-hint').textContent.startsWith('Meta!'));
    for (let n = 1; n <= 49; n++) await b.locator(`[data-number="${n}"]`).tap();
    await Promise.all([a.locator('.result-time').waitFor(), b.locator('.result-time').waitFor()]);
    await a.waitForFunction(round => document.querySelector('#total-wins').textContent === String(round), round);
    await a.waitForFunction(round => document.querySelector('#ranking-status').textContent.startsWith(`${round} przejazdy`), round);
    roundIds.push(await a.locator('.ranking-new').getAttribute('data-run-id'));
  }
  assert.equal(new Set(roundIds).size, 3, 'Each round has its own ranked result');
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
  await a.waitForFunction(() => document.querySelector('#total-wins').textContent === '3');
  await a.locator('[data-size="6"]').click();
  assert.notEqual(await a.locator('#best-time').textContent(), '—');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: sizes 4–7, solo with penalty, three 7×7 rounds in one room, mutual readiness, independent rankings, departure, stats after login, narrow phone layout.');
} finally {
  await browser.close(); await app.close(); await target.cleanup(); rmSync(directory, { recursive: true, force: true });
}
