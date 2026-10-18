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
  const users = [];
  for (const [index, context] of contexts.entries()) {
    const response = await context.request.post(`${base}/api/register`, { headers: { Origin: base }, data: { username: index ? 'CircuitB' : 'CircuitA', password: 'Circuit-test-123' } });
    assert.equal(response.status(), 201); users.push((await response.json()).user);
  }
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of [a, b]) { page.on('pageerror', e => errors.push(e.message)); await page.goto(base); await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy')); await page.locator('[data-mode="duel"]').click(); }
  for (const size of [4, 5]) await a.locator(`#duel-track-${size}`).uncheck();
  await a.locator('#start-button').click();
  await a.waitForFunction(() => document.querySelector('#toast').textContent.includes('przynajmniej jeden tor'));
  for (const size of [4, 5, 6, 7]) { await a.locator(`#duel-track-${size}`).check(); await a.locator(`#duel-laps-${size}`).fill(size === 5 ? '2' : '1'); }
  assert.match(await a.locator('#duel-config-summary').textContent(), /5 rund · pula 8,5 pkt/);
  await a.screenshot({ path: 'test-results/match-configuration.png', fullPage: true });
  await a.locator('#start-button').click();
  const code = await a.locator('#display-code').textContent();
  await b.locator('#room-code').fill(code); await b.locator('#join-form button').click();
  await b.locator('#ready-button').waitFor();
  assert.deepEqual(await a.locator('.duel-plan li').allTextContents(), await b.locator('.duel-plan li').allTextContents());
  assert.equal(await b.locator('.duel-plan li').count(), 4);
  await b.locator('.training-panel').screenshot({ path: 'test-results/match-plan-mobile.png' });
  await a.locator('#ready-button').click(); await b.locator('#ready-button').tap();
  const sizes = [4, 5, 5, 6, 7];
  let aPoints = 0, bPoints = 0;
  for (const [index, size] of sizes.entries()) {
    await Promise.all([a.locator('[data-number="1"]').waitFor(), b.locator('[data-number="1"]').waitFor()]);
    assert.equal(await a.locator('[data-number]').count(), size ** 2);
    assert.equal(await b.locator('[data-number]').count(), size ** 2);
    assert.match(await b.locator('.duel-progress').textContent(), new RegExp(`Runda ${index + 1} / 5.*Tor ${size}×${size}`));
    assert.deepEqual(await a.locator('[data-number]').allTextContents(), await b.locator('[data-number]').allTextContents());
    const winner = index % 2 ? b : a, loser = winner === a ? b : a;
    await loser.locator('[data-number="2"]').click();
    await loser.waitForFunction(() => document.querySelector('#race-errors').textContent === '+1 s');
    await loser.locator('[data-number="2"]').click();
    await loser.waitForFunction(() => document.querySelector('#race-errors').textContent === '+2 s');
    for (const page of [winner, loser]) {
      for (let n = 1; n <= size ** 2; n++) await page.locator(`[data-number="${n}"]`).click();
      if (page === winner) await page.waitForFunction(() => document.querySelector('#game-hint').textContent.startsWith('Meta!'));
    }
    await Promise.all([a.locator('.result-time').waitFor(), b.locator('.result-time').waitFor()]);
    if (winner === a) aPoints += 1 + (size - 4) / 2; else bPoints += 1 + (size - 4) / 2;
    await a.locator('#current-duel-report').waitFor();
    assert.equal(await a.locator('.duel-laps tbody tr').count(), (index + 1) * 2);
    if (index === 4) break;
    assert.match(await a.locator('#rematch-status').textContent(), new RegExp(`tor ${sizes[index + 1]}×${sizes[index + 1]}`));
    await a.locator('[data-action="rematch"]').click();
    await a.waitForFunction(() => document.querySelector('#rematch-status').textContent.includes('Czekamy na rywala'));
    assert.equal(await b.locator('.result-time').isVisible(), true);
    await b.locator('[data-action="rematch"]').click();
  }
  assert.equal(aPoints, 5); assert.equal(bPoints, 3.5);
  assert.match(await a.locator('.result-time').textContent(), /5 : 3,5/);
  assert.match(await a.locator('.result-header h3').textContent(), /Wygrywasz mecz/);
  await a.locator('#duel-history [data-duel-report]').waitFor();
  const eventId = await a.locator('#duel-history [data-duel-report]').getAttribute('data-duel-report');
  const report = (await (await a.request.get(`${base}/api/duels/${eventId}`)).json()).report;
  assert.equal(report.status, 'complete'); assert.equal(report.winner, users[0].id);
  assert.equal(report.rounds.length, 5); assert.equal(report.tracks.length, 4);
  assert.equal(report.players.find(p => p.id === users[0].id).points, 5);
  assert.equal(report.players.find(p => p.id === users[1].id).points, 3.5);
  assert.ok(report.rounds.every(r => r.players.some(p => p.errors === 2 && p.gap > 0)));
  await a.locator('#duel-history [data-duel-report]').click();
  await a.locator('#duel-report-dialog').waitFor();
  assert.equal(await a.locator('#duel-report-content .duel-laps tbody tr').count(), 10);
  await a.screenshot({ path: 'test-results/match-report-desktop.png' });
  await b.locator('#duel-history [data-duel-report]').click();
  await b.locator('#duel-report-dialog').waitFor();
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await b.locator('#duel-report-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), 'Report tables scroll within the phone dialog');
  await b.screenshot({ path: 'test-results/match-report-mobile.png' });
  await a.reload();
  await a.locator('#duel-history [data-duel-report]').waitFor();
  await a.locator('#duel-history [data-duel-report]').click();
  assert.deepEqual((await (await a.request.get(`${base}/api/duels/${eventId}`)).json()).report, report);
  await a.locator('#duel-report-close').click();
  await a.locator('[data-action="logout"]').click();
  await a.waitForFunction(() => document.querySelector('#duel-history').textContent.includes('Zaloguj się'));
  assert.equal(await a.locator('#duel-report-content').textContent(), '');
  assert.deepEqual(errors, []);
  console.log('Planned match passed: validated configuration, five rounds over four tracks, automatic size changes after mutual readiness, 5:3.5 points, penalties, full report, mobile layout, history after reload and private data cleared on logout.');
} finally { await browser.close(); await app.close(); await target.cleanup(); }
