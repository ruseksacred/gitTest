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
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 1050 } }), browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })]);
  // Race a WebSocket driver against an HTTPS driver, including automatic laps.
  await contexts[1].addInitScript(() => { const Native = window.WebSocket; window.WebSocket = class extends Native { constructor() { throw new DOMException('Test HTTPS fallback', 'SecurityError'); } }; });
  const users = [];
  for (const [index, context] of contexts.entries()) {
    const response = await context.request.post(`${base}/api/register`, { headers: { Origin: base }, data: { username: index ? 'CircuitB' : 'CircuitA', password: 'Circuit-test-123' } });
    assert.equal(response.status(), 201); users.push((await response.json()).user);
  }
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of [a, b]) { page.on('pageerror', e => errors.push(e.message)); await page.goto(base); await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy')); await page.locator('.app-menu [data-route="championship"]').click(); }
  for (const size of [4, 5]) await a.locator(`#duel-track-${size}`).uncheck();
  await a.locator('#start-button').click();
  await a.waitForFunction(() => document.querySelector('#toast').textContent.includes('przynajmniej jeden tor'));
  for (const size of [4, 5, 6, 7]) { await a.locator(`#duel-track-${size}`).check(); await a.locator(`#duel-laps-${size}`).fill(size === 5 ? '2' : '1'); }
  assert.match(await a.locator('#duel-config-summary').textContent(), /4 wyścigi · 5 okrążeń/);
  await a.screenshot({ path: 'test-results/championship-configuration.png', fullPage: true });
  await a.locator('#start-button').click();
  const code = await a.locator('#display-code').textContent();
  await b.locator('#room-code').fill(code); await b.locator('#join-form button').click();
  await b.locator('#ready-button').waitFor();
  assert.deepEqual(await a.locator('.duel-plan li').allTextContents(), await b.locator('.duel-plan li').allTextContents());
  await a.locator('#ready-button').click(); await b.locator('#ready-button').tap();
  let totalLaps = 0;
  for (const [index, size] of [4, 5, 6, 7].entries()) {
    const laps = size === 5 ? 2 : 1;
    await Promise.all([a.locator('[data-number="1"]').waitFor(), b.locator('[data-number="1"]').waitFor()]);
    const winner = index === 1 ? b : a, loser = winner === a ? b : a, layouts = [];
    for (const page of [winner, loser]) {
      for (let lap = 1; lap <= laps; lap++) {
        await page.waitForFunction(({ lap, laps }) => document.querySelector('#champ-lap-label')?.textContent === `Okrążenie ${lap}/${laps}`, { lap, laps });
        if (page === winner) layouts.push(await page.locator('[data-number]').allTextContents());
        else assert.deepEqual(await page.locator('[data-number]').allTextContents(), layouts[lap - 1]);
        if (page === loser && lap === 1) { await page.locator('[data-number="2"]').click(); await page.waitForFunction(() => document.querySelector('#race-errors').textContent === '+1 s'); }
        await page.locator('[data-number="1"]').click();
        if (lap === 2) {
          await page.waitForFunction(() => document.querySelector('#pb-delta').textContent !== '—');
          assert.match(await page.locator('#delta-meta').textContent(), /po liczbie 1/);
        }
        if (page === loser) {
          await page.waitForFunction(() => document.querySelector('#gap-time').textContent !== '—');
          assert.match(await page.locator('#gap-meta').textContent(), new RegExp(`okr. ${lap}, liczba 1`));
          if (size === 5 && lap === 2) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.locator('.training-panel').screenshot({ path: 'test-results/championship-live-timing.png' }); }
        }
        for (let n = 2; n <= size ** 2; n++) await page.locator(`[data-number="${n}"]`).click();
        if (lap < laps) assert.equal(await page.locator('.result-time').count(), 0, 'No readiness screen may interrupt a lap');
      }
      if (page === winner) { await page.locator('.champ-finished').waitFor(); assert.match(await loser.locator('#champ-lap-label').textContent(), /Okrążenie 1/); }
    }
    await Promise.all([a.locator('.result-time').waitFor(), b.locator('.result-time').waitFor()]);
    totalLaps += laps;
    assert.equal(await a.locator('#current-championship-report .championship-laps tbody tr').count(), totalLaps * 2);
    await a.locator('#current-championship-report [data-lap-driver]').selectOption(String(users[1].id));
    assert.equal(await a.locator('#current-championship-report .championship-laps tbody tr:visible').count(), totalLaps);
    if (index === 3) break;
    await a.locator('[data-action="rematch"]').click();
    await a.waitForFunction(() => document.querySelector('#rematch-status').textContent.includes('Czekamy na rywala'));
    assert.equal(await a.locator('#current-championship-report [data-lap-driver]').inputValue(), String(users[1].id));
    assert.equal(await b.locator('.result-time').isVisible(), true);
    await b.locator('[data-action="rematch"]').click();
  }
  assert.match(await a.locator('.result-time').textContent(), /7 : 5/);
  assert.match(await a.locator('.result-header h3').textContent(), /Wygrywasz mistrzostwa/);
  for (const page of [a, b]) await page.locator('.app-menu [data-route="history"]').click();
  await a.locator('#duel-history [data-duel-report]').waitFor();
  const id = await a.locator('#duel-history [data-duel-report]').getAttribute('data-duel-report');
  const report = (await (await a.request.get(`${base}/api/duels/${id}`)).json()).report;
  assert.equal(report.format, 'championship-v1'); assert.equal(report.status, 'complete'); assert.equal(report.winner, users[0].id);
  assert.equal(report.races.length, 4); assert.equal(report.players[0].points, 7); assert.equal(report.players[1].points, 5);
  for (const page of [a, b]) { await page.locator('#duel-history [data-duel-report]').click(); await page.locator('#duel-report-dialog').waitFor(); }
  assert.equal(await a.locator('#duel-report-content .championship-laps tbody tr').count(), 10);
  for (const [page, me, rival] of [[a, users[0], users[1]], [b, users[1], users[0]]]) {
    const filter = page.locator('#duel-report-content [data-lap-driver]');
    assert.equal(await filter.inputValue(), String(page === a ? users[1].id : me.id));
    assert.equal(await page.locator('#duel-report-content .championship-laps tbody tr:visible').count(), 5);
    await filter.selectOption(String(rival.id));
    const names = await page.locator('#duel-report-content .championship-laps tbody tr:visible th').allTextContents();
    assert.deepEqual(names, Array(5).fill(rival.username));
    // Selecting a driver only filters lap detail; standings remain complete.
    assert.equal(await page.locator('#duel-report-content .duel-standings article:visible').count(), 2);
  }
  assert.ok(report.races.every(race => race.players.every(p => p.laps.every(lap => lap.deltaScope === 'session'))));
  assert.ok(await b.locator('#duel-report-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
  await a.screenshot({ path: 'test-results/championship-report-desktop.png' }); await b.screenshot({ path: 'test-results/championship-report-mobile.png' });
  await a.reload(); await a.locator('#duel-history [data-duel-report]').waitFor();
  assert.deepEqual((await (await a.request.get(`${base}/api/duels/${id}`)).json()).report, report);
  await a.locator('[data-action="logout"]').click(); await a.waitForFunction(() => document.querySelector('#duel-history').textContent.includes('Zaloguj się'));
  assert.deepEqual(errors, []);
  console.log('Championship passed: continuous independent laps, current-race deltas, four races, 7:5 points, WS/HTTPS, per-driver lap filters, preserved selection, saved report and responsive layout.');
} finally { await browser.close(); await app.close(); await target.cleanup(); }
