import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';

async function fixture(t, options = {}) {
  const target = databaseFixture(options.database);
  const app = await createApp({ ...target.options, countdownMs: 30, roundMs: 5000, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await target.cleanup(); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, cookie) {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: url, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(username) {
    const r = await request('register', { username, password: 'Test-password-123' });
    assert.equal(r.status, 201);
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin: url, headers: { Cookie: r.cookie } });
    const messages = [], waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      messages.push(message);
      for (const waiter of [...waiters]) if (waiter.check(message)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    });
    const wait = check => {
      const match = messages.findLast(check);
      if (match) return Promise.resolve(match);
      return new Promise((resolve, reject) => {
        const waiter = { check, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(Error(`Timed out waiting for socket state. Last: ${JSON.stringify(messages.at(-1))}`)); }, 3000) };
        waiters.push(waiter);
      });
    };
    await wait(m => m.type === 'connected');
    return { ...r.body.user, cookie: r.cookie, ws, wait, messages, send(action, payload = {}) { ws.send(JSON.stringify({ action, ...payload })); } };
  }
  return { app, url, request, register };
}
const phase = name => m => m.game?.phase === name;
async function race(a, b, size = 3) {
  a.send('create', { size });
  const waiting = await a.wait(phase('waiting'));
  b.send('join', { code: waiting.game.code.toLowerCase() });
  await a.wait(m => m.game?.players.length === 2);
  await b.wait(phase('waiting'));
  a.send('ready'); b.send('ready');
  const [ar, br] = await Promise.all([a.wait(phase('racing')), b.wait(phase('racing'))]);
  assert.deepEqual(ar.game.board, br.game.board);
  assert.equal(ar.game.startAt, br.game.startAt);
  assert.deepEqual([...ar.game.board].sort((a, b) => a - b), Array.from({ length: size ** 2 }, (_, i) => i + 1));
  return ar.game;
}
async function complete(client, count) { for (let n = 1; n <= count; n++) client.send('hit', { number: n }); }

test('accounts: validation, unique case-insensitive names, login, secure cookie and logout', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('stats')).status, 401);
  assert.equal((await request('register', { username: 'x', password: 'short' })).status, 400);
  const registered = await request('register', { username: 'Driver', password: 'password-123' });
  assert.equal(registered.status, 201);
  assert.ok(registered.cookie.startsWith('rf_session='));
  assert.equal((await request('register', { username: 'driver', password: 'password-123' })).status, 409);
  assert.equal((await request('login', { username: 'Driver', password: 'bad-password' })).status, 401);
  const login = await request('login', { username: 'DRIVER', password: 'password-123' });
  assert.equal(login.status, 200);
  assert.equal((await request('me', undefined, login.cookie)).body.user.username, 'Driver');
  assert.equal((await request('logout', {}, login.cookie)).status, 200);
  assert.equal((await request('stats', undefined, login.cookie)).status, 401);
});

test('solo: hidden board before start, all sizes, ordered hits, penalty and persistent stats', async t => {
  const { request, register } = await fixture(t, { countdownMs: 400 });
  const a = await register('SoloDriver');
  for (const size of [3, 4, 5]) {
    a.messages.length = 0;
    a.send('solo', { size });
    const countdown = await a.wait(phase('countdown'));
    assert.deepEqual(countdown.game.board, []);
    a.send('hit', { number: 1 });
    const start = await a.wait(phase('racing'));
    assert.equal(start.game.players[0].next, 1);
    a.send('hit', { number: 2 });
    await a.wait(m => m.game?.players[0].errors === 1);
    await complete(a, size ** 2);
    const done = (await a.wait(phase('complete'))).game.players[0];
    assert.equal(done.next, size ** 2 + 1);
    assert.equal(done.errors, 1);
    assert.equal(done.score, Math.round((done.elapsed + 1000) / 10));
    a.send('hit', { number: 1 });
  }
  const stats = (await request('stats', undefined, a.cookie)).body;
  assert.equal(stats.records.length, 3);
  assert.equal(stats.history.length, 3);
  assert.equal(stats.totals.games, 0);
  const login = await request('login', { username: 'SoloDriver', password: 'Test-password-123' });
  assert.deepEqual((await request('stats', undefined, login.cookie)).body, stats);
});

test('duel: identical board, errors change winner, no premature result, recorded exactly once', async t => {
  const { request, register } = await fixture(t);
  const a = await register('DriverA'), b = await register('DriverB');
  await race(a, b);
  a.send('hit', { number: 9 });
  await complete(a, 9);
  await a.wait(m => m.game?.phase === 'racing' && m.game.players.find(p => p.me).score !== null);
  assert.equal((await request('stats', undefined, a.cookie)).body.totals.games, 0);
  await complete(b, 9);
  const result = (await b.wait(phase('complete'))).game;
  assert.equal(result.players.find(p => p.me).outcome, 'win');
  assert.equal(result.players.find(p => !p.me).outcome, 'loss');
  b.send('hit', { number: 9 }); b.send('leave');
  await b.wait(m => m.type === 'state' && m.game === null);
  const statsA = (await request('stats', undefined, a.cookie)).body;
  const statsB = (await request('stats', undefined, b.cookie)).body;
  assert.equal(statsA.totals.losses, 1); assert.equal(statsB.totals.wins, 1);
  assert.equal(statsA.history.length, 1); assert.equal(statsB.history.length, 1);
  assert.equal(statsA.records.length, 0);
});

test('duel: centisecond tie is recorded as draw for both players', async t => {
  const { request, register } = await fixture(t);
  const a = await register('EqualA'), b = await register('EqualB');
  const game = await race(a, b);
  t.mock.timers.enable({ apis: ['Date'], now: game.startAt + 1000 });
  await complete(a, 9); await complete(b, 9);
  const result = (await a.wait(phase('complete'))).game;
  t.mock.timers.reset();
  assert.ok(result.players.every(p => p.outcome === 'draw' && p.score === 100));
  assert.equal((await request('stats', undefined, b.cookie)).body.totals.draws, 1);
});

test('duel: leaving waiting room is free; disconnect after start forfeits and persists', async t => {
  const { request, register } = await fixture(t);
  const a = await register('LeaveA'), b = await register('LeaveB');
  a.send('create', { size: 3 });
  const waiting = await a.wait(phase('waiting'));
  b.send('join', { code: waiting.game.code });
  await b.wait(phase('waiting'));
  b.send('leave'); await b.wait(m => m.type === 'state' && m.game === null);
  assert.equal((await request('stats', undefined, b.cookie)).body.totals.games, 0);
  a.send('leave'); await a.wait(m => m.type === 'state' && m.game === null);
  a.messages.length = 0; b.messages.length = 0;
  await race(a, b);
  b.ws.close();
  const result = (await a.wait(phase('complete'))).game;
  assert.equal(result.reason, 'forfeit');
  assert.equal(result.players.find(p => p.me).outcome, 'win');
  assert.equal((await request('stats', undefined, b.cookie)).body.totals.losses, 1);
});

test('rooms reject third player, invalid size, unknown room and competing games', async t => {
  const { register } = await fixture(t);
  const a = await register('RoomA'), b = await register('RoomB'), c = await register('RoomC');
  c.send('solo', { size: 100 }); assert.match((await c.wait(m => m.type === 'error')).message, /rozmiar/);
  c.messages.length = 0;
  c.send('join', { code: '000000' }); assert.match((await c.wait(m => m.type === 'error')).message, /znaleziono/);
  a.send('create', { size: 4 });
  const waiting = await a.wait(phase('waiting'));
  b.send('join', { code: waiting.game.code }); await b.wait(phase('waiting'));
  c.messages.length = 0;
  c.send('join', { code: waiting.game.code }); assert.match((await c.wait(m => m.type === 'error')).message, /pełny/);
  a.send('solo', { size: 3 }); assert.match((await a.wait(m => m.type === 'error')).message, /aktualną/);
});

test('timeout completes a stalled match without inventing a finish time', async t => {
  const { register, request } = await fixture(t, { roundMs: 100 });
  const a = await register('TimeoutA'), b = await register('TimeoutB');
  await race(a, b);
  await complete(a, 9);
  const result = (await a.wait(phase('complete'))).game;
  assert.equal(result.reason, 'timeout');
  assert.equal(result.players.find(p => !p.me).score, null);
  assert.equal(result.players.find(p => p.me).outcome, 'win');
  assert.equal((await request('stats', undefined, b.cookie)).body.totals.losses, 1);
});

test('stored accounts and completed results survive a server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'race-focus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'test.sqlite');
  const app = await createApp({ database, countdownMs: 5 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Persistent', password: 'password-123' }) });
  assert.equal(r.status, 201);
  const user = (await r.json()).user;
  await app.db.run("INSERT INTO matches(id,mode,size,finished_at,reason) VALUES (1,'solo',3,?,'finished')", Date.now());
  await app.db.run("INSERT INTO results VALUES (1,?,12340,0,1234,'solo')", user.id);
  await app.close();
  const second = await fixture(t, { database });
  const login = await second.request('login', { username: 'Persistent', password: 'password-123' });
  assert.equal(login.status, 200);
  assert.equal((await second.request('stats', undefined, login.cookie)).body.records[0].best, 1234);
});

test('cross-origin writes and unauthenticated websocket connections are denied', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: '{}' });
  assert.equal(response.status, 403);
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin: url });
  const code = await new Promise(resolve => { ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); }); ws.on('error', () => {}); });
  assert.equal(code, 403);
});

test('database outage: failed match save can be retried without duplicate results', async t => {
  const { app, register, request } = await fixture(t);
  const a = await register('RetryA'), b = await register('RetryB');
  await race(a, b);
  const transaction = app.db.transaction;
  app.db.transaction = async () => { throw Error('Simulated unavailable database'); };
  await complete(a, 9); await complete(b, 9);
  const failed = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false)).game;
  assert.equal(failed.saved, false);
  assert.equal((await request('stats', undefined, a.cookie)).body.totals.games, 0);
  app.db.transaction = transaction;
  // Simulate a lost acknowledgement after a successful database COMMIT.
  app.db.transaction = async callback => { await transaction(callback); throw Error('Simulated lost COMMIT acknowledgement'); };
  a.messages.length = 0;
  a.send('retry-save');
  await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false);
  assert.equal((await request('stats', undefined, a.cookie)).body.totals.games, 1);
  app.db.transaction = transaction;
  a.send('retry-save'); b.send('retry-save');
  await a.wait(m => m.game?.phase === 'complete' && m.game.saved === true);
  for (const c of [a, b]) {
    const stats = (await request('stats', undefined, c.cookie)).body;
    assert.equal(stats.totals.games, 1);
    assert.equal(stats.history.length, 1);
  }
});

test('health probes and timed clicks do not query the database', async t => {
  const { app, register, request } = await fixture(t);
  const a = await register('IdleDriver');
  const get = app.db.get;
  let reads = 0;
  app.db.get = async (...args) => { reads++; return get(...args); };
  assert.equal((await request('health')).status, 200);
  assert.equal(reads, 0);
  assert.equal((await request('ready')).body.database, app.db.dialect);
  assert.equal(reads, 1);
  a.send('solo', { size: 3 }); await a.wait(phase('racing'));
  a.send('hit', { number: 1 });
  await a.wait(m => m.game?.players[0].next === 2);
  assert.equal(reads, 1);
});
