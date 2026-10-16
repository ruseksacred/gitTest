import assert from 'node:assert/strict';

const raw = process.argv[2];
if (!raw) { console.error('Użycie: npm run smoke -- https://nazwa-uslugi.onrender.com'); process.exit(1); }
let base;
try { base = new URL(raw); } catch { console.error('Podaj poprawny adres aplikacji.'); process.exit(1); }
if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('Podaj sam adres strony, bez danych logowania ani ścieżki.');
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw Error('Publiczna aplikacja wymaga HTTPS.');
async function get(path) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200, `${path}: oczekiwano HTTP 200`);
  return response;
}
try {
  assert.deepEqual(await (await get('/api/health')).json(), { ok: true });
  const readiness = await (await get('/api/ready')).json();
  assert.equal(readiness.ok, true);
  assert.ok(['postgres', 'sqlite'].includes(readiness.database));
  if (base.hostname.endsWith('.onrender.com')) assert.equal(readiness.database, 'postgres');
  const homepage = await get('/');
  assert.match(homepage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(await homepage.text(), /Race Focus/);
  assert.deepEqual(await (await get('/api/me')).json(), { user: null });
  console.log(`OK: strona, serwer, baza (${readiness.database}) i sesje odpowiadają. Test nie tworzył kont ani wyników.`);
} catch { console.error('Weryfikacja nie powiodła się. Sprawdź status wdrożenia i DATABASE_URL w panelu hostingu.'); process.exitCode = 1; }
