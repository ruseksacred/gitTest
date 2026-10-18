import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

const directory = await mkdtemp(join(tmpdir(), 'rf-pwa-'));
const app = await createApp({ database: join(directory, 'test.sqlite'), countdownMs: 50 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
// Serve a newer worker at the same URL without editing the application's files.
const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
let workerRevision = Number(worker.match(/race-focus-offline-v(\d+)/)[1]);
const proxy = createServer((req, res) => {
  if (new URL(req.url, 'http://local.test').pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.end(worker.replace(/race-focus-offline-v\d+/, `race-focus-offline-v${workerRevision}`));
  } else app.server.emit('request', req, res);
});
proxy.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
await mkdir('test-results', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const manifest = await (await context.request.get(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/?source=pwa');
  for (const icon of manifest.icons) {
    const response = await context.request.get(base + icon.src);
    const png = await response.body();
    assert.equal(response.status(), 200);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
    assert.equal(png.readUInt32BE(20), Number(icon.sizes.split('x')[1]));
  }
  const touchIcon = await context.request.get(base + await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'));
  assert.equal((await touchIcon.body()).readUInt32BE(16), 180);
  await page.locator('#install-button').click();
  assert.match(await page.locator('#install-title').textContent(), /iPhonie/);
  assert.match(await page.locator('#install-steps').textContent(), /Safari/);
  assert.match(await page.locator('#install-steps').textContent(), /Dodaj do ekranu początkowego/);
  await page.screenshot({ path: 'test-results/pwa-iphone-instructions.png', fullPage: true });
  await page.locator('#close-install').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS: manifest, actual PNG sizes, Apple icon and iPhone installation instructions.');

  // Simulate the browser-owned install prompt; OS installation cannot be automated here.
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { document.body.dataset.installPromptShown = 'yes'; };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.locator('#install-button').click();
  assert.equal(await page.locator('body').getAttribute('data-install-prompt-shown'), 'yes');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  assert.equal(await page.locator('#install-card').isVisible(), false);

  await page.locator('[data-action="auth"]').click();
  await page.locator('[data-action="switch-auth"]').click();
  await page.locator('#username').fill('PwaDriver');
  await page.locator('#password').fill('Pwa-test-password-123');
  await page.locator('#auth-submit').click();
  await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  await page.locator('.app-menu [data-route="solo"]').click();
  await page.locator('[data-size="4"]').click();
  await page.locator('#start-button').click();
  await page.locator('[data-number="1"]').waitFor();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  workerRevision++;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  assert.equal(await page.locator('#update-notice').isVisible(), false, 'No update banner may move the board during a match');
  assert.equal(await page.locator('#update-button').isDisabled(), true);
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'An available update must not reload a running game');
  for (let n = 1; n <= 16; n++) await page.locator(`[data-number="${n}"]`).tap();
  await page.locator('.result-time').waitFor();
  await page.locator('#update-notice').waitFor();
  assert.equal(await page.locator('#update-button').isEnabled(), true);
  await page.locator('#update-button').click();
  await page.waitForFunction(origin => performance.timeOrigin !== origin, timeOrigin);
  await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  assert.equal(await page.locator('#update-notice').isVisible(), false);
  assert.deepEqual(await page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('race-focus-offline-'))), [`race-focus-offline-v${workerRevision}`]);
  console.log('PASS: real service-worker update waits during gameplay, applies on request and cleans the old cache.');

  await context.setOffline(true);
  await page.locator('#network-notice').waitFor();
  const cookieBeforeOffline = (await context.cookies()).find(c => c.name === 'rf_session')?.value;
  await page.reload();
  await page.locator('.offline-retry').waitFor();
  assert.match(await page.locator('h1').textContent(), /wróci połączenie/);
  assert.equal(await page.locator('#account').count(), 0, 'Offline fallback must not show cached account details');
  await page.screenshot({ path: 'test-results/pwa-offline-mobile.png', fullPage: true });
  const cachePaths = await page.evaluate(async () => {
    const paths = [];
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) paths.push(new URL(request.url).pathname);
    return paths;
  });
  assert.ok(!cachePaths.some(p => p.startsWith('/api/') || p === '/' || p === '/app.js'));
  await context.setOffline(false);
  await page.locator('.offline-retry').click();
  await page.waitForFunction(() => document.querySelector('#setup-footnote').textContent.includes('Gotowy'));
  assert.equal((await context.cookies()).find(c => c.name === 'rf_session')?.value, cookieBeforeOffline);
  await page.locator('.app-menu [data-route="solo"]').click();
  await page.locator('[data-size="4"]').click();
  await page.waitForFunction(() => document.querySelector('#best-time').textContent !== '—');
  assert.deepEqual(errors, []);
  console.log('PASS: offline navigation uses an informative page, never caches account/API data, and reconnect restores saved results.');
} finally {
  await browser.close();
  await new Promise(resolve => proxy.close(resolve));
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
