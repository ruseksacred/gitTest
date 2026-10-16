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
  await b.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout must not overflow horizontally');
  await a.locator('[data-size="3"]').click();
  await a.locator('[data-action="start"]').click();
  await a.locator('[data-number="1"]').waitFor();
  await a.locator('[data-number="2"]').click();
  await a.waitForFunction(() => document.querySelector('#race-errors').textContent === '+1 s');
  for (let n = 1; n <= 9; n++) { await a.locator(`[data-number="${n}"]`).click(); await a.waitForFunction(n => !document.querySelector('#next-number') || document.querySelector('#next-number').textContent === String(n + 1), n); }
  await a.locator('.result-time').waitFor();
  assert.match(await a.locator('.result-header h3').textContent(), /Dobry przejazd/);
  await a.waitForFunction(() => document.querySelector('#best-time').textContent !== '—');
  await a.locator('.result-actions [data-action="leave"]').click();
  await a.locator('[data-mode="duel"]').click();
  await a.locator('[data-size="4"]').click();
  await a.locator('[data-action="start"]').click();
  const code = await a.locator('#display-code').textContent();
  await b.locator('[data-mode="duel"]').click();
  await b.locator('#room-code').fill(code);
  await b.locator('#join-form button').click();
  await a.locator('#ready-button').click();
  await b.locator('#ready-button').click();
  await a.locator('[data-number="1"]').waitFor();
  await b.locator('[data-number="1"]').waitFor();
  assert.deepEqual(await a.locator('[data-number]').allTextContents(), await b.locator('[data-number]').allTextContents());
  await a.screenshot({ path: 'test-results/duel-desktop.png', fullPage: true });
  await b.screenshot({ path: 'test-results/duel-mobile.png', fullPage: true });
  for (let n = 1; n <= 16; n++) await a.locator(`[data-number="${n}"]`).click();
  await a.waitForFunction(() => document.querySelector('#game-hint').textContent.startsWith('Meta!'));
  for (let n = 1; n <= 16; n++) await b.locator(`[data-number="${n}"]`).tap();
  await a.locator('.result-time').waitFor(); await b.locator('.result-time').waitFor();
  await a.waitForFunction(() => document.querySelector('#total-wins').textContent === '1');
  await b.waitForFunction(() => document.querySelector('#total-losses').textContent === '1');
  await a.screenshot({ path: 'test-results/results-desktop.png', fullPage: true });
  await a.locator('[data-action="logout"]').click();
  await a.locator('[data-action="auth"]').click();
  // The dialog retains registration mode after the first successful registration.
  await a.locator('[data-action="switch-auth"]').click();
  await a.locator('#username').fill('ApexDriver');
  await a.locator('#password').fill('Browser-password-123');
  await a.locator('#auth-submit').click();
  await a.waitForFunction(() => document.querySelector('#total-wins').textContent === '1');
  await a.locator('[data-size="3"]').click();
  assert.notEqual(await a.locator('#best-time').textContent(), '—');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: registration, solo with penalty, desktop/mobile duel, same board, stats after login, responsive layout, no JS errors.');
} finally {
  await browser.close(); await app.close(); await target.cleanup(); rmSync(directory, { recursive: true, force: true });
}
