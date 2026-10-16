import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { postgresOptions, openDatabase } from '../database.js';
import { databaseFixture } from './database-fixture.js';

test('hosted PostgreSQL uses verified TLS even when the connection URL says require', () => {
  const secure = postgresOptions('postgresql://user:password@example.neon.tech/db?sslmode=require');
  assert.deepEqual(secure.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(secure.connectionString).searchParams.has('sslmode'), false);
  assert.throws(() => postgresOptions('postgresql://u:p@example.neon.tech/db?sslmode=disable'), /TLS/);
  assert.throws(() => postgresOptions('postgresql://u:p@example.neon.tech/db?sslmode=no-verify'), /TLS/);
  assert.equal(postgresOptions('postgresql://postgres@127.0.0.1:55432/test').ssl, false);
});

test('HTTPS reverse-proxy origin supports accounts and websockets with Secure cookies', async t => {
  const target = databaseFixture();
  const publicOrigin = 'https://race-focus.example';
  const app = await createApp({ ...target.options, publicOrigin, cookieSecure: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await target.cleanup(); });
  const address = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(address + '/api/register', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'HostedDriver', password: 'Test-password-123' }) });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self' wss:\/\/race-focus\.example;/);
  assert.ok(!response.headers.get('content-security-policy').includes('ws://'));
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.match(response.headers.get('set-cookie'), /; HttpOnly/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws', { origin: publicOrigin, headers: { Cookie: 'theme=dark;' + cookie } });
  assert.equal((await new Promise((resolve, reject) => { ws.once('message', raw => resolve(JSON.parse(raw))); ws.once('error', reject); })).type, 'connected');
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  const logout = await fetch(address + '/api/logout', { method: 'POST', headers: { Origin: publicOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal(await closed, 1000);
  const denied = await fetch(address + '/api/register', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
});

test('existing accounts and stats survive reopening the configured database', async t => {
  const target = databaseFixture();
  if (target.options.database === ':memory:') { t.skip('PostgreSQL persistence check; SQLite restart is covered in game.test.js'); return; }
  t.after(target.cleanup);
  const first = await openDatabase(target.options.database, { schema: target.options.databaseSchema });
  const { id } = await first.get('INSERT INTO users(username,salt,password,created_at) VALUES (?,?,?,?) RETURNING id', 'PersistentPg', 'test-salt', 'test-hash', Date.now());
  await first.transaction(async tx => {
    const match = await tx.get('INSERT INTO matches(mode,size,finished_at,reason,save_key) VALUES (?,?,?,?,?) RETURNING id', 'solo', 4, Date.now(), 'finished', 'persistence-test');
    await tx.run('INSERT INTO results VALUES (?,?,?,?,?,?)', match.id, id, 12000, 1, 1300, 'solo');
  });
  await first.close();
  const second = await openDatabase(target.options.database, { schema: target.options.databaseSchema });
  try {
    assert.equal((await second.get('SELECT username FROM users WHERE id=?', id)).username, 'PersistentPg');
    assert.equal((await second.get('SELECT score FROM results WHERE user_id=?', id)).score, 1300);
  } finally { await second.close(); }
});
