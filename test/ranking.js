import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';
import { seedRun } from './run-fixture.js';

const target = databaseFixture();
const app = await createApp({ ...target.options, countdownMs: 100 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
mkdirSync('test-results', { recursive: true });
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  async function register(context, username) {
    const response = await context.request.post(`${base}/api/register`, { headers: { Origin: base }, data: { username, password: 'Ranking-browser-123' } });
    assert.equal(response.status(), 201);
    return (await response.json()).user;
  }
  const a = await register(desktop, 'RankingPilot'), b = await register(mobile, 'MobilePilot');
  for (let i = 0; i < 22; i++) await seedRun(app.db, a.id, { elapsed: 100, finishedAt: i + 1 });
  await seedRun(app.db, a.id, { mode: 'duel', opponent: b.id, elapsed: 10000, errors: 3 });
  await seedRun(app.db, a.id, { size: 3, elapsed: 5000 });
  await seedRun(app.db, b.id, { size: 3, elapsed: 5000, errors: 2 });
  await seedRun(app.db, b.id, { size: 3, elapsed: 6000 });
  const page = await desktop.newPage(), phone = await mobile.newPage();
  for (const p of [page, phone]) p.on('pageerror', error => errors.push(error.message));
  await Promise.all([page.goto(base), phone.goto(base)]);
  await page.waitForFunction(() => document.querySelector('#ranking-status').textContent.startsWith('23 przejazdy'));
  assert.equal(await page.locator('#ranking-rows tr').count(), 20);
  await page.locator('#ranking-next').click();
  await page.waitForFunction(() => document.querySelector('#ranking-page').textContent === '2 / 2');
  assert.equal(await page.locator('#ranking-rows tr').count(), 3);
  assert.match(await page.locator('#ranking-rows tr').last().textContent(), /vs MobilePilot/);
  assert.match(await page.locator('#ranking-rows tr').last().textContent(), /13.00 s/);
  await page.locator('#ranking-mode').selectOption('duel');
  await page.waitForFunction(() => document.querySelector('#ranking-status').textContent.startsWith('1 przejazd'));
  assert.equal(await page.locator('#ranking-rows .ranking-place').textContent(), '1');

  // A slow response for a previous filter must not overwrite the newer choice.
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  const pattern = '**/api/runs?**';
  await page.route(pattern, async route => {
    if (new URL(route.request().url()).searchParams.get('size') === '3') {
      const response = await route.fetch(); started(); await blocked;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator('#ranking-size').selectOption('3');
  await intercepted;
  await page.locator('#ranking-size').selectOption('5');
  await page.waitForFunction(() => document.querySelector('#run-ranking').getAttribute('aria-busy') === 'false');
  const lateResponse = page.waitForResponse(r => r.url().includes('/api/runs?') && new URL(r.url()).searchParams.get('size') === '3');
  release(); await lateResponse;
  await page.waitForFunction(() => document.querySelector('#ranking-size').value === '5' && document.querySelector('#ranking-status').textContent.startsWith('Brak ukończonych'));
  await page.unroute(pattern);

  // A real saved run switches category and opens page two at its ranked position.
  await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  await page.locator('[data-action="start"]').click();
  await page.locator('[data-number="1"]').waitFor();
  await page.locator('[data-number="2"]').click();
  await page.waitForFunction(() => document.querySelector('#race-errors').textContent === '+1 s');
  for (let n = 1; n <= 16; n++) await page.locator(`[data-number="${n}"]`).click();
  await page.locator('.result-time').waitFor();
  await page.locator('#ranking-rows .ranking-new').waitFor();
  assert.equal(await page.locator('#ranking-mode').inputValue(), 'solo');
  assert.equal(await page.locator('#ranking-size').inputValue(), '4');
  assert.equal(await page.locator('#ranking-page').textContent(), '2 / 2');
  assert.match(await page.locator('.ranking-new .ranking-place').textContent(), /^23/);
  assert.match(await page.locator('.ranking-new').textContent(), /\+1 s/);
  const latest = await app.db.get('SELECT match_id FROM results WHERE user_id=? ORDER BY match_id DESC LIMIT 1', a.id);
  assert.equal(await page.locator('.ranking-new').getAttribute('data-run-id'), String(latest.match_id));
  await page.locator('#run-ranking').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/ranking-desktop.png', fullPage: true });

  await phone.locator('#ranking-size').selectOption('3');
  await phone.waitForFunction(() => document.querySelector('#ranking-status').textContent.startsWith('2 przejazdy'));
  assert.equal(await phone.locator('.ranking-score').first().textContent(), '6.00 s');
  assert.equal(await phone.locator('.ranking-score').last().textContent(), '7.00 s');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page must not overflow');
  await phone.locator('#run-ranking').scrollIntoViewIfNeeded();
  await phone.screenshot({ path: 'test-results/ranking-mobile.png', fullPage: true });
  await phone.locator('[data-action="logout"]').click();
  await phone.waitForFunction(() => document.querySelector('#ranking-status').textContent.startsWith('Zaloguj się'));
  assert.equal(await phone.locator('#ranking-rows tr').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Ranking browser checks passed: filters, pagination, stale responses, penalties, new run on page two, mobile layout, private history cleared after logout.');
} finally {
  await browser.close(); await app.close(); await target.cleanup();
}
