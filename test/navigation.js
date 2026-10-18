import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';

const target = databaseFixture();
const app = await createApp({ ...target.options, countdownMs: 80 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
mkdirSync('test-results', { recursive: true });
const nav = (page, route) => page.locator(`.app-menu [data-route="${route}"]`).click();
try {
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1440, height: 1050 } }),
    browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
  ]);
  const pages = [];
  for (const [i, context] of contexts.entries()) {
    const response = await context.request.post(`${base}/api/register`, { headers: { Origin: base }, data: { username: `Navigation${i}`, password: 'Navigation-test-123' } });
    assert.equal(response.status(), 201);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?source=pwa`);
    await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
    assert.equal(await page.locator('#home-view').isVisible(), true);
    for (const id of ['play-view', 'stats-view', 'history-view']) assert.equal(await page.locator(`#${id}`).isVisible(), false);
    await page.screenshot({ path: `test-results/navigation-home-${i ? 'mobile' : 'desktop'}.png`, fullPage: true });
    const origin = await page.evaluate(() => performance.timeOrigin);
    await nav(page, 'solo');
    assert.equal(await page.locator('.menu-link[aria-current]').getAttribute('data-route'), 'solo');
    assert.equal(await page.locator('#play-title').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-size="7"]').click(); await page.locator('#solo-laps').fill('2');
    await nav(page, 'stats');
    await page.goBack();
    assert.equal(await page.locator('#solo-settings').isVisible(), true);
    assert.equal(await page.locator('#solo-laps').inputValue(), '2');
    assert.equal(await page.locator('[data-size="7"]').getAttribute('aria-pressed'), 'true');
    await page.goForward();
    assert.equal(await page.locator('#stats-view').isVisible(), true);
    await nav(page, 'history');
    assert.equal(await page.locator('#history-view').isVisible(), true);
    assert.equal(await page.locator('#run-ranking').isVisible(), false);
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'Menu and history navigation must preserve the document and connection');
  }
  const [a, b] = pages;
  // A copied section link opens directly, including the old statistics bookmark.
  await a.goto(`${base}/#run-ranking`);
  await a.locator('#stats-view').waitFor();
  assert.match(a.url(), /#\/stats$/);
  await a.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  for (const width of [320, 768, 820, 1024, 1440]) {
    await a.setViewportSize({ width, height: 1050 });
    for (const route of ['home', 'solo', 'championship', 'stats', 'history']) {
      await nav(a, route);
      assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} must fit at ${width}px`);
    }
  }

  // Browser Back and hash navigation cannot silently abandon a running session.
  await nav(b, 'solo');
  await b.setViewportSize({ width: 320, height: 740 });
  await b.locator('#start-button').click();
  await b.locator('[data-number="1"]').waitFor();
  assert.equal(await b.locator('.app-menu').isVisible(), false);
  assert.equal(await b.locator('.topbar').isVisible(), false);
  assert.equal(await b.locator('#race-details').getAttribute('open'), null);
  const board = await b.locator('#number-board').boundingBox();
  assert.ok(board.y >= 0 && board.y + board.height <= 740, 'All 49 cells must be visible without scrolling at 320×740');
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await b.screenshot({ path: 'test-results/navigation-focused-race-320.png' });
  await b.goBack();
  await b.locator('#leave-dialog').waitFor();
  assert.match(b.url(), /#\/race$/);
  await b.locator('[data-action="cancel-leave"]').click();
  await b.locator('[data-number="1"]').tap();
  await b.evaluate(() => { location.hash = '#/stats'; });
  await b.locator('#leave-dialog').waitFor();
  await b.keyboard.press('Escape');
  await b.waitForFunction(() => document.querySelector('#next-number')?.textContent === '2');
  for (let n = 2; n <= 48; n++) await b.locator(`[data-number="${n}"]`).tap();
  await b.locator('#race-details summary').click();
  await b.locator('[data-number="49"]').tap();
  await b.waitForFunction(() => document.querySelector('#solo-lap-label')?.textContent === 'Okrążenie 2/2');
  assert.equal(await b.locator('#race-details').evaluate(el => el.open), true, 'A new lap preserves the timing panel preference');
  await b.evaluate(() => { location.hash = '#/stats'; });
  await b.locator('#leave-dialog').waitFor();
  await b.locator('[data-action="confirm-leave"]').click();
  await b.locator('#stats-view').waitFor();
  assert.equal(await b.locator('#resume-session').isVisible(), false);
  const runs = (await (await b.request.get(`${base}/api/runs?mode=solo&size=7`)).json()).rows;
  assert.equal(runs.length, 1, 'Confirmed departure must preserve the completed lap');
  assert.equal(await b.locator('.app-menu').isVisible(), true);

  // Reading a report after the championship preserves the shared room and rematch.
  for (const page of [a, b]) await nav(page, 'championship');
  await a.locator('#duel-track-5').uncheck(); await a.locator('#duel-laps-4').fill('1');
  await a.locator('#start-button').click();
  const code = await a.locator('#display-code').textContent();
  await b.locator('#room-code').fill(code); await b.locator('#join-form button').click();
  await a.locator('#ready-button').click(); await b.locator('#ready-button').click();
  for (const page of [a, b]) {
    await page.locator('[data-number="1"]').waitFor();
    for (let n = 1; n <= 16; n++) await page.locator(`[data-number="${n}"]`).click();
  }
  for (const page of [a, b]) {
    await page.locator('.result-time').waitFor();
    await nav(page, 'history');
    await page.locator('#duel-history [data-duel-report]').waitFor();
    assert.equal(await page.locator('#game').isVisible(), false);
    await page.locator('#duel-history [data-duel-report]').click();
    await page.locator('#duel-report-dialog').waitFor();
    await page.locator('#duel-report-close').click();
    await page.locator('#resume-session').click();
    assert.equal(await page.locator('[data-action="rematch"]').isEnabled(), true);
  }
  await a.locator('[data-action="rematch"]').click();
  await nav(a, 'history');
  await a.locator('#duel-history [data-duel-report]').first().click();
  await a.locator('#duel-report-dialog').waitFor();
  await b.locator('[data-action="rematch"]').click();
  await a.locator('[data-number="1"]').waitFor();
  assert.match(a.url(), /#\/race$/);
  assert.equal(await a.locator('#history-view').isVisible(), false);
  assert.equal(await a.locator('#duel-report-dialog').isVisible(), false, 'The report must not obscure an automatically started rematch');
  assert.equal(await a.locator('.game-top').textContent().then(text => text.includes(code)), true);
  await a.locator('[data-action="leave"]').click();
  await a.locator('[data-action="confirm-leave"]').click();
  await a.locator('#setup').waitFor();
  await b.locator('.result-time').waitFor();
  await nav(a, 'history');
  await a.locator('[data-action="logout"]').click();
  await a.waitForFunction(() => document.querySelector('#duel-history').textContent.includes('Zaloguj się'));
  assert.equal(await a.locator('#ranking-rows tr').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Navigation passed: distinct screens, deep links, back/forward, persistent settings, protected race exit, complete 7×7 board at 320px, lap details, saved partial session, reports and same-room rematch.');
} finally { await browser.close(); await app.close(); await target.cleanup(); }
