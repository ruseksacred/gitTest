import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  async function register(username, clientId) {
    const r = await request('register', { username, password: 'Test-password-123' });
    assert.equal(r.status, 201);
    return connectSocket(r.body.user, r.cookie, clientId);
  }
  async function connectSocket(user, cookie, clientId) {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws' + (clientId ? `?client=${clientId}` : ''), { origin: url, headers: { Cookie: cookie } });
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
    return { ...user, cookie, ws, wait, messages, send(action, payload = {}) { ws.send(JSON.stringify({ action, ...payload })); } };
  }
  return { app, url, request, register, connectSocket };
}
const phase = name => m => m.game?.phase === name;
async function race(a, b, size = 4) {
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
  // Separate the burst-driven test races by a real countdown so clicks from
  // consecutive 36/49-cell boards stay within the normal per-second limit.
  const { request, register } = await fixture(t, { countdownMs: 1100 });
  const a = await register('SoloDriver');
  for (const size of [4, 5, 6, 7]) {
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
    const completed = (await a.wait(phase('complete'))).game;
    const done = completed.players[0];
    assert.equal(done.next, size ** 2 + 1);
    assert.equal(done.errors, 1);
    assert.equal(done.score, Math.round((done.elapsed + 1000) / 10));
    const ranked = (await request(`runs?mode=solo&size=${size}&highlight=${completed.matchId}`, undefined, a.cookie)).body;
    assert.equal(ranked.highlight.id, completed.matchId);
    assert.equal(ranked.rows[0].score, done.score);
    a.send('hit', { number: 1 });
  }
  const stats = (await request('stats', undefined, a.cookie)).body;
  assert.equal(stats.records.length, 4);
  assert.equal(stats.history.length, 4);
  assert.equal(stats.totals.games, 0);
  const login = await request('login', { username: 'SoloDriver', password: 'Test-password-123' });
  assert.deepEqual((await request('stats', undefined, login.cookie)).body, stats);
});

for (const size of [4, 5, 6, 7]) test(`duel ${size}×${size}: identical board, errors change winner, no premature result, recorded exactly once`, async t => {
  const { request, register } = await fixture(t);
  const a = await register('DriverA'), b = await register('DriverB');
  await race(a, b, size);
  a.send('hit', { number: 9 });
  await complete(a, size ** 2);
  await a.wait(m => m.game?.phase === 'racing' && m.game.players.find(p => p.me).score !== null);
  assert.equal((await request('stats', undefined, a.cookie)).body.totals.games, 0);
  await complete(b, size ** 2);
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
  await complete(a, 16); await complete(b, 16);
  const result = (await a.wait(phase('complete'))).game;
  t.mock.timers.reset();
  assert.ok(result.players.every(p => p.outcome === 'draw' && p.score === 100));
  assert.equal((await request('stats', undefined, b.cookie)).body.totals.draws, 1);
});

test('rematches: three rounds share a room, require both players and save independent ranked results', async t => {
  const { register, request, app } = await fixture(t, { countdownMs: 1100 });
  const a = await register('RematchA'), b = await register('RematchB'), outsider = await register('RematchC');
  let game = await race(a, b);
  const code = game.code, matchIds = [];
  for (let round = 1; round <= 3; round++) {
    assert.equal(game.round, round); assert.equal(game.code, code);
    assert.ok(game.players.every(p => p.next === 1 && p.errors === 0 && p.score === null && p.elapsed === null));
    a.send('hit', { number: 2 }); await a.wait(m => m.game?.players.find(p => p.me).errors === 1);
    await complete(a, 16); await complete(b, 16);
    const completed = (await a.wait(phase('complete'))).game;
    await b.wait(phase('complete'));
    assert.equal(completed.canRematch, true);
    assert.ok(completed.players.every(p => !p.ready));
    matchIds.push(completed.matchId);
    const stats = (await request('stats', undefined, a.cookie)).body;
    assert.equal(stats.totals.games, round); assert.equal(stats.history.length, round);
    const ranking = (await request('runs?mode=duel&size=4', undefined, a.cookie)).body;
    assert.equal(ranking.total, round);
    if (round > 1) {
      a.send('rematch', { matchId: matchIds.at(-2) });
      assert.match((await a.wait(m => m.type === 'error')).message, /runda/);
    }
    if (round === 3) break;
    outsider.messages.length = 0;
    outsider.send('join', { code });
    assert.match((await outsider.wait(m => m.type === 'error')).message, /dostępnego/);
    a.send('rematch', { matchId: completed.matchId });
    a.send('rematch', { matchId: completed.matchId });
    const ready = (await b.wait(m => m.game?.phase === 'complete' && m.game.players.find(p => !p.me).ready)).game;
    assert.equal(ready.players.find(p => p.me).ready, false);
    assert.deepEqual(ready.players.map(p => p.score), completed.players.map(p => p.score));
    a.messages.length = b.messages.length = 0;
    b.send('rematch', { matchId: completed.matchId });
    const countdown = (await a.wait(phase('countdown'))).game;
    assert.equal(countdown.round, round + 1); assert.deepEqual(countdown.board, []);
    assert.equal(countdown.matchId, null);
    b.messages.length = 0;
    b.send('rematch', { matchId: completed.matchId });
    assert.match((await b.wait(m => m.type === 'error')).message, /runda/);
    game = (await a.wait(phase('racing'))).game;
    const other = (await b.wait(phase('racing'))).game;
    assert.deepEqual(game.board, other.board); assert.equal(game.startAt, other.startAt);
  }
  assert.equal(new Set(matchIds).size, 3);
  const rows = await app.db.all('SELECT save_key FROM matches WHERE id IN (?,?,?)', ...matchIds);
  assert.equal(new Set(rows.map(r => r.save_key)).size, 3);
});

test('rematches: leaving or changing rooms cancels readiness and preserves the completed result', async t => {
  const { register, request } = await fixture(t);
  const a = await register('ExitA'), b = await register('ExitB');
  await race(a, b); await complete(a, 16); await complete(b, 16);
  const finished = (await a.wait(phase('complete'))).game;
  a.send('rematch', { matchId: finished.matchId });
  await a.wait(m => m.game?.phase === 'complete' && m.game.players.find(p => p.me).ready);
  b.messages.length = 0;
  b.send('create', { size: 7 });
  const nextRoom = (await b.wait(phase('waiting'))).game;
  assert.notEqual(nextRoom.code, finished.code);
  const closed = (await a.wait(m => m.game?.phase === 'complete' && !m.game.canRematch)).game;
  assert.ok(closed.players.every(p => !p.ready));
  assert.deepEqual(closed.players.map(p => p.score), finished.players.map(p => p.score));
  a.send('rematch', { matchId: finished.matchId });
  assert.match((await a.wait(m => m.type === 'error')).message, /opuścił/);
  assert.equal((await request('stats', undefined, a.cookie)).body.totals.games, 1);
  a.send('leave'); await a.wait(m => m.type === 'state' && m.game === null);
  a.messages.length = 0;
  a.send('join', { code: nextRoom.code });
  assert.equal((await a.wait(phase('waiting'))).game.size, 7);
});

test('rematches: same-page transport replacement keeps the completed room and clears readiness', async t => {
  const { register, connectSocket } = await fixture(t);
  const clientId = randomUUID();
  const a = await register('ResumeA', clientId), b = await register('ResumeB');
  await race(a, b); await complete(a, 16); await complete(b, 16);
  const finished = (await a.wait(phase('complete'))).game;
  a.send('rematch', { matchId: finished.matchId });
  await a.wait(m => m.game?.players.find(p => p.me).ready && m.game.phase === 'complete');
  const replacement = await connectSocket(a, a.cookie, clientId);
  const restored = (await replacement.wait(phase('complete'))).game;
  assert.equal(restored.code, finished.code); assert.equal(restored.matchId, finished.matchId);
  assert.equal(restored.canRematch, true); assert.ok(restored.players.every(p => !p.ready));
  b.messages.length = 0; replacement.messages.length = 0;
  replacement.send('rematch', { matchId: finished.matchId }); b.send('rematch', { matchId: finished.matchId });
  const next = (await replacement.wait(phase('racing'))).game;
  assert.equal(next.round, 2); assert.equal(next.code, finished.code);
});

test('planned match: chosen laps advance tracks, weighted points and private persistent reports', async t => {
  const { register, request, app } = await fixture(t, { countdownMs: 1100 });
  const a = await register('PlanA'), b = await register('PlanB'), outsider = await register('PlanC');
  a.send('create', { tracks: [{ size: 7, laps: 1 }, { size: 4, laps: 1 }, { size: 5, laps: 2 }] });
  const waiting = (await a.wait(phase('waiting'))).game;
  assert.deepEqual(waiting.duel.tracks.map(t => [t.size, t.laps, t.points]), [[4, 1, 1], [5, 2, 1.5], [7, 1, 2.5]]);
  b.send('join', { code: waiting.code }); await b.wait(phase('waiting'));
  a.send('ready'); b.send('ready');
  const sizes = [4, 5, 5, 7];
  let report;
  for (const [index, size] of sizes.entries()) {
    const game = (await a.wait(phase('racing'))).game;
    await b.wait(phase('racing'));
    assert.equal(game.size, size); assert.equal(game.round, index + 1); assert.equal(game.code, waiting.code);
    assert.deepEqual([...game.board].sort((a, b) => a - b), Array.from({ length: size ** 2 }, (_, i) => i + 1));
    b.send('hit', { number: 2 }); await b.wait(m => m.game?.players.find(p => p.me).errors === 1);
    await complete(a, size ** 2); await complete(b, size ** 2);
    const finished = (await a.wait(phase('complete'))).game;
    await b.wait(phase('complete'));
    report = finished.duel.report;
    assert.equal(report.rounds.length, index + 1); assert.equal(report.id, waiting.duel.id);
    assert.equal(report.status, index === 3 ? 'complete' : 'active');
    assert.equal(report.players.find(p => p.id === a.id).points, [1, 2.5, 4, 6.5][index]);
    assert.equal((await request(`duels/${report.id}`, undefined, outsider.cookie)).status, 404);
    assert.equal((await request(`duels/${report.id}`)).status, 401);
    assert.deepEqual((await request(`duels/${report.id}`, undefined, b.cookie)).body.report, report);
    if (index === 3) break;
    a.send('rematch', { matchId: finished.matchId });
    const ready = (await a.wait(m => m.game?.phase === 'complete' && m.game.players.find(p => p.me).ready)).game;
    assert.equal(ready.size, size, 'The current result remains until both players are ready');
    a.messages.length = b.messages.length = 0;
    b.send('rematch', { matchId: finished.matchId });
    const next = (await a.wait(phase('countdown'))).game;
    assert.equal(next.size, sizes[index + 1]); assert.deepEqual(next.board, []);
  }
  assert.equal(report.winner, a.id);
  assert.equal(report.players.find(p => p.id === b.id).points, 0);
  assert.equal((await request('duels', undefined, a.cookie)).body.matches.length, 1);
  assert.equal((await request('duels', undefined, outsider.cookie)).body.matches.length, 0);
  assert.equal((await app.db.get('SELECT COUNT(*) count FROM results WHERE user_id=?', a.id)).count, 4);
  // A rematch after the finale creates another match with the same schedule.
  a.messages.length = b.messages.length = 0;
  const lastId = report.rounds.at(-1).matchId;
  a.send('rematch', { matchId: lastId }); b.send('rematch', { matchId: lastId });
  const replay = (await a.wait(phase('countdown'))).game;
  assert.equal(replay.round, 1); assert.equal(replay.size, 4); assert.notEqual(replay.duel.id, report.id);
});

test('planned match: leaving between laps forfeits the whole match without adding a lap', async t => {
  const { register, request } = await fixture(t);
  const a = await register('ForfeitPlanA'), b = await register('ForfeitPlanB');
  a.send('create', { tracks: [{ size: 4, laps: 2 }, { size: 6, laps: 1 }] });
  const room = (await a.wait(phase('waiting'))).game;
  b.send('join', { code: room.code }); await b.wait(phase('waiting'));
  a.send('ready'); b.send('ready'); await a.wait(phase('racing'));
  b.send('hit', { number: 2 }); await complete(a, 16); await complete(b, 16);
  const finished = (await a.wait(phase('complete'))).game;
  assert.equal(finished.duel.report.winner, null);
  a.send('leave'); await a.wait(m => m.type === 'state' && m.game === null);
  const ended = (await b.wait(m => m.game?.phase === 'complete' && m.game.duel?.status === 'forfeit' && m.game.saved)).game;
  assert.equal(ended.duel.report.winner, b.id, 'Match forfeiture overrides an earlier points lead');
  assert.equal(ended.duel.report.rounds.length, 1);
  assert.equal(ended.duel.report.players.find(p => p.id === a.id).points, 1);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 1);
  assert.equal((await request('duels', undefined, a.cookie)).body.matches[0].status, 'forfeit');
});

test('planned match: invalid schedules are rejected before room creation', async t => {
  const { register } = await fixture(t);
  const a = await register('BadPlan');
  for (const tracks of [[], null, [{ size: 3, laps: 1 }], [{ size: 6, laps: 11 }], [{ size: 4, laps: 2 }, { size: 4, laps: 3 }]]) {
    a.messages.length = 0; a.send('create', { tracks });
    assert.match((await a.wait(m => m.type === 'error')).message, /tory/);
  }
});

test('planned match: report rollback and a lost acknowledgement can be retried without duplicate laps or points', async t => {
  const { register, request, app } = await fixture(t, { countdownMs: 1100 });
  const a = await register('AtomicA'), b = await register('AtomicB');
  a.send('create', { tracks: [{ size: 5, laps: 2 }] });
  const room = (await a.wait(phase('waiting'))).game;
  b.send('join', { code: room.code }); await b.wait(phase('waiting'));
  a.send('ready'); b.send('ready'); await a.wait(phase('racing'));
  const transaction = app.db.transaction;
  app.db.transaction = callback => transaction(tx => callback({ ...tx, async run(sql, ...args) { if (sql.includes('INSERT INTO duel_events')) throw Error('Simulated report write failure'); return tx.run(sql, ...args); } }));
  b.send('hit', { number: 2 }); await complete(a, 25); await complete(b, 25);
  const failed = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false)).game;
  assert.equal(failed.canRematch, false);
  a.send('rematch', { matchId: failed.matchId });
  assert.match((await a.wait(m => m.type === 'error')).message, /zapis/);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 0, 'A failed report write rolls back the lap too');
  assert.equal((await request('duels', undefined, a.cookie)).body.matches.length, 0);
  app.db.transaction = async callback => { await transaction(callback); throw Error('Simulated lost commit acknowledgement'); };
  a.messages.length = 0;
  a.send('retry-save');
  await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 1);
  assert.equal((await request('duels', undefined, a.cookie)).body.matches.length, 1);
  app.db.transaction = transaction;
  a.send('retry-save');
  const saved = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved)).game;
  assert.equal(saved.duel.report.rounds.length, 1);
  assert.equal(saved.duel.report.players.find(p => p.id === a.id).points, 1.5);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 1);
  assert.equal((await request('duels', undefined, a.cookie)).body.matches.length, 1);
  assert.equal((await app.db.get('SELECT COUNT(*) count FROM results WHERE user_id=?', a.id)).count, 1);
});

test('solo training: continuous laps, penalties, PB checkpoints and ranked records seed the next training', async t => {
  const { register, request, app } = await fixture(t, { countdownMs: 1100 });
  const a = await register('SoloLaps');
  a.send('solo', { size: 4, laps: 2 });
  const countdown = (await a.wait(phase('countdown'))).game;
  assert.deepEqual(countdown.board, []);
  assert.equal(countdown.training.laps, 2);
  assert.equal(countdown.deadline - countdown.startAt, 10000);
  const g = (await a.wait(phase('racing'))).game;
  assert.equal(g.training.driver.best, null);
  assert.equal(g.board.length, 16);
  assert.ok(!JSON.stringify(g).includes('splits'), 'Never expose PB splits or future boards');
  const hit = (lap, number, raceId = g.raceId) => a.send('hit', { lap, number, raceId });
  const get = app.db.get; let reads = 0;
  app.db.get = async (...args) => { reads++; return get(...args); };
  hit(1, 2);
  for (let n = 1; n <= 16; n++) hit(1, n);
  const next = (await a.wait(m => m.game?.training?.driver.lap === 2)).game;
  assert.equal(next.phase, 'racing'); assert.equal(next.training.driver.next, 1);
  assert.equal(next.training.driver.errors, 0); assert.equal(next.training.driver.totalErrors, 1);
  const first = next.training.driver.laps[0];
  assert.equal(first.score, Math.round((first.elapsed + 1000) / 10));
  hit(1, 16); hit(2, 1, 'old-race'); hit(2, 1);
  const checkpoint = (await a.wait(m => m.game?.training?.driver.lap === 2 && m.game.training.driver.next === 2)).game.training.driver;
  assert.equal(checkpoint.errors, 0, 'Late lap and race packets must be ignored');
  assert.equal(checkpoint.delta.checkpoint, 1);
  hit(2, 9);
  const penalized = (await a.wait(m => m.game?.training?.driver.lap === 2 && m.game.training.driver.errors === 1)).game.training.driver;
  assert.equal(penalized.delta.value, checkpoint.delta.value + 100, 'A wrong choice changes the delta immediately');
  assert.equal(reads, 0, 'Timed hits and lap changes cannot query the database'); app.db.get = get;
  for (let n = 2; n <= 16; n++) hit(2, n);
  const finished = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved)).game;
  const laps = finished.training.driver.laps;
  assert.equal(laps.length, 2); assert.equal(finished.training.summary.errors, 2);
  assert.equal(finished.training.summary.total, laps[0].score + laps[1].score);
  assert.equal(finished.players[0].score, finished.training.summary.total);
  const records = (await request('runs?mode=solo&size=4', undefined, a.cookie)).body;
  assert.equal(records.total, 2); assert.deepEqual(records.rows.map(r => r.score), laps.map(l => l.score).sort((a, b) => a - b));
  assert.equal((await app.db.get('SELECT COUNT(*) count FROM lap_telemetry')).count, 2);
  a.messages.length = 0; a.send('solo', { size: 4, laps: 1 });
  const replay = (await a.wait(phase('racing'))).game;
  assert.equal(replay.training.driver.best.historical, true);
  assert.equal(replay.training.driver.best.score, Math.min(...laps.map(l => l.score)));
  a.send('hit', { raceId: replay.raceId, lap: 1, number: 1 });
  assert.notEqual((await a.wait(m => m.game?.training?.driver.next === 2)).game.training.driver.delta, null);
});

test('solo training: invalid lap counts and track sizes do not start a game', async t => {
  const { register } = await fixture(t);
  const a = await register('SoloConfig');
  for (const laps of [0, -1, 11, 1.5, '2', null, {}]) {
    a.messages.length = 0; a.send('solo', { size: 4, laps });
    assert.match((await a.wait(m => m.type === 'error')).message, /1 do 10/);
    assert.ok(!a.messages.some(m => m.game));
  }
  a.messages.length = 0; a.send('solo', { size: 3, laps: 2 });
  assert.match((await a.wait(m => m.type === 'error')).message, /rozmiar/);
});

test('solo training: partial completed laps survive timeout, while unfinished laps are not ranked', async t => {
  const { register, request } = await fixture(t, { roundMs: 120 });
  const a = await register('SoloTimeout');
  a.send('solo', { size: 4, laps: 2 });
  const g = (await a.wait(phase('racing'))).game;
  for (let number = 1; number <= 16; number++) a.send('hit', { raceId: g.raceId, lap: 1, number });
  await a.wait(m => m.game?.training?.driver.lap === 2);
  const ended = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved)).game;
  assert.equal(ended.reason, 'timeout'); assert.equal(ended.training.summary.completed, 1);
  assert.equal(ended.players[0].score, null);
  assert.equal((await request('runs?mode=solo&size=4', undefined, a.cookie)).body.total, 1);
});

for (const disconnected of [false, true]) test(`solo training: ${disconnected ? 'disconnect' : 'leaving'} keeps completed laps without inventing a partial result`, async t => {
  const { register, request, connectSocket } = await fixture(t);
  const a = await register('SoloExit');
  a.send('solo', { size: 4, laps: 2 });
  const g = (await a.wait(phase('racing'))).game;
  for (let number = 1; number <= 16; number++) a.send('hit', { raceId: g.raceId, lap: 1, number });
  await a.wait(m => m.game?.training?.driver.lap === 2);
  if (disconnected) { a.ws.close(); await new Promise(resolve => a.ws.once('close', resolve)); }
  else { a.send('leave'); await a.wait(m => m.type === 'state' && m.game === null); }
  // A new connection is released only after the old game has finished saving.
  const b = disconnected ? await connectSocket(a, a.cookie) : a;
  const records = (await request('runs?mode=solo&size=4', undefined, b.cookie)).body;
  assert.equal(records.total, 1); assert.equal(records.rows[0].reason, 'finished');
});

test('solo training: save rollback and lost acknowledgement can be retried without duplicating laps', async t => {
  const { register, request, app } = await fixture(t);
  const a = await register('SoloRetry');
  a.send('solo', { size: 4, laps: 2 });
  const g = (await a.wait(phase('racing'))).game;
  const transaction = app.db.transaction;
  app.db.transaction = callback => transaction(tx => callback({ ...tx, async run(sql, ...args) { if (sql.includes('INSERT INTO lap_telemetry')) throw Error('Simulated telemetry outage'); return tx.run(sql, ...args); } }));
  for (const lap of [1, 2]) {
    for (let number = 1; number <= 16; number++) a.send('hit', { raceId: g.raceId, lap, number });
    if (lap === 1) await a.wait(m => m.game?.training?.driver.lap === 2);
  }
  await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false);
  assert.equal((await request('runs?mode=solo&size=4', undefined, a.cookie)).body.total, 0);
  app.db.transaction = async callback => { await transaction(callback); throw Error('Lost training acknowledgement'); };
  a.messages.length = 0; a.send('retry-save'); await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false);
  app.db.transaction = transaction; a.send('retry-save');
  const saved = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved)).game;
  assert.equal(saved.training.summary.completed, 2);
  assert.equal((await request('runs?mode=solo&size=4', undefined, a.cookie)).body.total, 2);
  assert.equal((await app.db.get('SELECT COUNT(*) count FROM lap_telemetry')).count, 2);
});

test('solo training: reconnect during a pending partial save refreshes stats after commit', async t => {
  const { register, request, connectSocket, app } = await fixture(t);
  const a = await register('SoloPending');
  a.send('solo', { size: 4, laps: 2 });
  const g = (await a.wait(phase('racing'))).game;
  for (let number = 1; number <= 16; number++) a.send('hit', { raceId: g.raceId, lap: 1, number });
  await a.wait(m => m.game?.training?.driver.lap === 2);
  const transaction = app.db.transaction;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { started = resolve; });
  app.db.transaction = async callback => { started(); await gate; return transaction(callback); };
  a.ws.close(); await saving;
  app.db.transaction = transaction;
  const b = await connectSocket(a, a.cookie);
  assert.equal((await request('runs?mode=solo&size=4', undefined, a.cookie)).body.total, 0);
  release(); await b.wait(m => m.type === 'refresh-stats');
  assert.equal((await request('runs?mode=solo&size=4', undefined, b.cookie)).body.total, 1);
});

test('solo training: cancelling while loading PB cannot start a detached countdown', async t => {
  const { register, app } = await fixture(t);
  const a = await register('SoloCancel');
  const get = app.db.get;
  let release, reached;
  const blocked = new Promise(resolve => { release = resolve; });
  const queried = new Promise(resolve => { reached = resolve; });
  app.db.get = async (sql, ...args) => { if (sql.includes('JOIN lap_telemetry')) { reached(); await blocked; } return get(sql, ...args); };
  a.send('solo', { size: 4, laps: 2 }); await queried;
  a.send('leave'); await a.wait(m => m.type === 'state' && m.game === null);
  release(); app.db.get = get;
  a.messages.length = 0; a.send('solo', { size: 5, laps: 1 });
  const racing = (await a.wait(phase('racing'))).game;
  assert.equal(racing.size, 5); assert.equal(racing.board.length, 25);
  assert.ok(!a.messages.some(m => m.game?.size === 4));
});

test('championship: independent laps, same per-lap boards, exact gaps, race points and persisted telemetry', async t => {
  const { register, request, app } = await fixture(t, { countdownMs: 1100, roundMs: 10000 });
  const a = await register('ChampA'), b = await register('ChampB'), outside = await register('ChampC');
  a.send('create', { championship: true, tracks: [{ size: 4, laps: 2 }, { size: 5, laps: 1 }] });
  const room = (await a.wait(phase('waiting'))).game;
  b.send('join', { code: room.code }); await b.wait(phase('waiting'));
  a.send('ready'); b.send('ready');
  const race = (await a.wait(phase('racing'))).game;
  const initialB = (await b.wait(phase('racing'))).game;
  assert.deepEqual(race.board, initialB.board); assert.equal(race.championship.drivers.find(p => p.me).best, null);
  const get = app.db.get; let reads = 0;
  app.db.get = async (...args) => { reads++; return get(...args); };
  const hit = (client, lap, number, raceId = race.raceId) => client.send('hit', { lap, number, raceId });
  for (let n = 1; n <= 16; n++) hit(a, 1, n);
  const lapTwo = (await a.wait(m => m.game?.championship?.drivers.find(p => p.me).lap === 2)).game;
  assert.equal(lapTwo.phase, 'racing'); assert.equal(lapTwo.championship.drivers.find(p => !p.me).lap, 1);
  hit(a, 1, 16); hit(a, 2, 1);
  const checkpoint = (await a.wait(m => m.game?.championship?.drivers.find(p => p.me).next === 2 && m.game.championship.drivers.find(p => p.me).lap === 2)).game;
  assert.equal(checkpoint.championship.drivers.find(p => p.me).errors, 0, 'Delayed hits from lap one cannot penalize lap two');
  assert.notEqual(checkpoint.championship.drivers.find(p => p.me).delta, null);
  hit(b, 1, 2); hit(b, 1, 1);
  const gapState = (await b.wait(m => m.game?.championship?.gap?.checkpoint === 1)).game;
  assert.ok(gapState.championship.gap.value >= 100, 'The cumulative checkpoint gap includes the penalty');
  for (let n = 2; n <= 16; n++) hit(b, 1, n);
  const bLapTwo = (await b.wait(m => m.game?.championship?.drivers.find(p => p.me).lap === 2)).game;
  assert.deepEqual(lapTwo.board, bLapTwo.board, 'Each driver receives the same layout for the same lap, even at different times');
  for (let n = 2; n <= 16; n++) hit(a, 2, n);
  await a.wait(m => m.game?.championship?.drivers.find(p => p.me).finished);
  assert.equal(reads, 0, 'Live timing and lap changes must not query the database'); app.db.get = get;
  assert.equal((await request('duels', undefined, a.cookie)).body.matches.length, 0, 'Points are not awarded after individual laps');
  for (let n = 1; n <= 16; n++) hit(b, 2, n);
  const result = (await a.wait(phase('complete'))).game;
  const report = result.championship.report;
  assert.equal(report.format, 'championship-v1'); assert.equal(report.status, 'active');
  assert.deepEqual(report.players.map(p => p.points), [2, 1]);
  assert.equal(report.races.length, 1); assert.equal(report.races[0].players[0].laps.length, 2);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 2);
  assert.equal((await app.db.get('SELECT COUNT(*) count FROM lap_telemetry')).count, 4);
  assert.equal((await request(`duels/${report.id}`, undefined, outside.cookie)).status, 404);
  // Mutual readiness advances the race, never individual laps.
  a.messages.length = b.messages.length = 0;
  a.send('rematch', { matchId: result.matchId }); b.send('rematch', { matchId: result.matchId });
  const next = (await a.wait(phase('racing'))).game;
  assert.equal(next.size, 5); assert.equal(next.round, 2); assert.equal(next.code, room.code);
  for (const client of [a, b]) for (let n = 1; n <= 25; n++) client.send('hit', { raceId: next.raceId, lap: 1, number: n });
  const final = (await a.wait(m => m.game?.phase === 'complete' && m.game.raceId === next.raceId)).game;
  assert.equal(final.championship.report.status, 'complete');
  assert.equal(final.championship.report.races.length, 2);
  assert.equal(final.championship.report.players.reduce((n, p) => n + p.points, 0), 6);
  a.messages.length = b.messages.length = 0;
  a.send('rematch', { matchId: final.matchId }); b.send('rematch', { matchId: final.matchId });
  const replay = (await a.wait(phase('racing'))).game;
  assert.equal(replay.championship.drivers.find(p => p.me).best.historical, true);
  assert.equal(replay.championship.drivers.find(p => p.me).best.score, Math.min(...report.races[0].players.find(p => p.id === a.id).laps.map(l => l.score)));
});

test('championship: a telemetry write failure rolls back all laps and retries award race points once', async t => {
  const { register, request, app } = await fixture(t);
  const a = await register('TelemetryA'), b = await register('TelemetryB');
  a.send('create', { championship: true, tracks: [{ size: 4, laps: 1 }] });
  const room = (await a.wait(phase('waiting'))).game;
  b.send('join', { code: room.code }); await b.wait(phase('waiting')); a.send('ready'); b.send('ready');
  const g = (await a.wait(phase('racing'))).game;
  const transaction = app.db.transaction;
  app.db.transaction = callback => transaction(tx => callback({ ...tx, async run(sql, ...args) { if (sql.includes('INSERT INTO lap_telemetry')) throw Error('Simulated telemetry outage'); return tx.run(sql, ...args); } }));
  for (const c of [a, b]) for (let n = 1; n <= 16; n++) c.send('hit', { raceId: g.raceId, lap: 1, number: n });
  await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 0);
  assert.equal((await request('duels', undefined, a.cookie)).body.matches.length, 0);
  app.db.transaction = async callback => { await transaction(callback); throw Error('Lost race acknowledgement'); };
  a.messages.length = 0; a.send('retry-save'); await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false);
  app.db.transaction = transaction;
  a.send('retry-save');
  const saved = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved)).game;
  assert.equal(saved.championship.report.races.length, 1);
  assert.equal(saved.championship.report.players.reduce((n, p) => n + p.points, 0), 3);
  assert.equal((await app.db.get('SELECT COUNT(*) count FROM lap_telemetry')).count, 2);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 1);
});

for (const phaseToLeave of ['complete', 'preparing']) test(`championship: leaving at ${phaseToLeave} forfeits the standings without an unplayed race`, async t => {
  const { register, request, app } = await fixture(t);
  const a = await register('ChampExitA'), b = await register('ChampExitB');
  a.send('create', { championship: true, tracks: [{ size: 4, laps: 1 }, { size: 5, laps: 1 }] });
  const room = (await a.wait(phase('waiting'))).game;
  b.send('join', { code: room.code }); await b.wait(phase('waiting')); a.send('ready'); b.send('ready');
  const g = (await a.wait(phase('racing'))).game;
  for (const c of [a, b]) for (let n = 1; n <= 16; n++) c.send('hit', { raceId: g.raceId, lap: 1, number: n });
  const saved = (await a.wait(phase('complete'))).game;
  let release = () => {};
  const get = app.db.get;
  if (phaseToLeave === 'preparing') {
    const gate = new Promise(resolve => { release = resolve; });
    app.db.get = async (...args) => { await gate; return get(...args); };
    a.messages.length = b.messages.length = 0;
    a.send('rematch', { matchId: saved.matchId }); b.send('rematch', { matchId: saved.matchId });
    await a.wait(phase('preparing'));
  }
  a.send('leave'); await a.wait(m => m.type === 'state' && m.game === null);
  release(); app.db.get = get;
  const ended = (await b.wait(m => m.game?.phase === 'complete' && m.game.championship?.status === 'forfeit' && m.game.saved)).game;
  assert.equal(ended.championship.report.winner, b.id);
  assert.equal(ended.championship.report.races.length, 1);
  assert.equal((await request('stats', undefined, a.cookie)).body.history.length, 1);
});

test('championship: race timeout keeps completed laps and gives DNF no time or race points', async t => {
  const { register } = await fixture(t, { roundMs: 200 });
  const a = await register('RaceTimeoutA'), b = await register('RaceTimeoutB');
  a.send('create', { championship: true, tracks: [{ size: 4, laps: 2 }] });
  const room = (await a.wait(phase('waiting'))).game;
  b.send('join', { code: room.code }); await b.wait(phase('waiting')); a.send('ready'); b.send('ready');
  const g = (await a.wait(phase('racing'))).game;
  for (let lap = 1; lap <= 2; lap++) for (let n = 1; n <= 16; n++) a.send('hit', { raceId: g.raceId, lap, number: n });
  const finished = (await a.wait(m => m.game?.phase === 'complete')).game;
  const report = finished.championship.report;
  assert.equal(report.races[0].reason, 'timeout'); assert.equal(report.winner, a.id);
  const winner = report.races[0].players.find(p => p.id === a.id), dnf = report.races[0].players.find(p => p.id === b.id);
  assert.equal(winner.points, 2); assert.equal(winner.laps.length, 2);
  assert.equal(dnf.points, 0); assert.equal(dnf.score, null); assert.equal(dnf.gap, null); assert.equal(dnf.laps.length, 0);
});

test('duel: leaving waiting room is free; disconnect after start forfeits and persists', async t => {
  const { request, register } = await fixture(t);
  const a = await register('LeaveA'), b = await register('LeaveB');
  a.send('create', { size: 4 });
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
  for (const action of ['solo', 'create']) for (const size of [3, 8, 100, 6.5, '7']) {
    c.messages.length = 0;
    c.send(action, { size }); assert.match((await c.wait(m => m.type === 'error')).message, /rozmiar/);
  }
  c.messages.length = 0;
  c.send('join', { code: '000000' }); assert.match((await c.wait(m => m.type === 'error')).message, /znaleziono/);
  a.send('create', { size: 4 });
  const waiting = await a.wait(phase('waiting'));
  b.send('join', { code: waiting.game.code }); await b.wait(phase('waiting'));
  c.messages.length = 0;
  c.send('join', { code: waiting.game.code }); assert.match((await c.wait(m => m.type === 'error')).message, /pełny/);
  a.send('solo', { size: 4 }); assert.match((await a.wait(m => m.type === 'error')).message, /aktualną/);
});

test('timeout completes a stalled match without inventing a finish time', async t => {
  const { register, request } = await fixture(t, { roundMs: 100 });
  const a = await register('TimeoutA'), b = await register('TimeoutB');
  await race(a, b);
  await complete(a, 16);
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
  await complete(a, 16); await complete(b, 16);
  const failed = (await a.wait(m => m.game?.phase === 'complete' && m.game.saved === false)).game;
  assert.equal(failed.saved, false);
  assert.equal(failed.canRematch, false);
  a.send('rematch', { matchId: failed.matchId });
  assert.match((await a.wait(m => m.type === 'error')).message, /zapis/);
  a.messages.length = 0;
  a.send('create', { size: 4 });
  assert.match((await a.wait(m => m.type === 'error')).message, /zapis/);
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
  a.send('solo', { size: 4 }); await a.wait(phase('racing'));
  a.send('hit', { number: 1 });
  await a.wait(m => m.game?.players[0].next === 2);
  assert.equal(reads, 1);
});

test('a reconnect from the same page replaces its stale socket and survives the old close event', async t => {
  const { register, request, connectSocket } = await fixture(t);
  const clientId = randomUUID();
  const a = await register('SamePage', clientId);
  const closed = new Promise(resolve => a.ws.once('close', resolve));
  const replacement = await connectSocket(a, a.cookie, clientId);
  await closed;
  replacement.send('ping', { id: 42 });
  assert.equal((await replacement.wait(m => m.type === 'pong')).id, 42);
  replacement.send('solo', { size: 4 }); await replacement.wait(phase('racing'));
  await complete(replacement, 16); await replacement.wait(phase('complete'));
  assert.equal((await request('stats', undefined, a.cookie)).body.records[0].runs, 1);
});

test('a different page cannot evict the active connection of the same account', async t => {
  const { url, register } = await fixture(t);
  const a = await register('DifferentPage', randomUUID());
  const duplicate = new WebSocket(url.replace('http:', 'ws:') + '/ws?client=' + randomUUID(), { origin: url, headers: { Cookie: a.cookie } });
  const code = await new Promise(resolve => { duplicate.once('close', resolve); duplicate.once('error', () => {}); });
  assert.equal(code, 4001);
  a.send('ping', { id: 10 }); assert.equal((await a.wait(m => m.type === 'pong')).id, 10);
  a.send('solo', { size: 4 }); await a.wait(phase('racing'));
});

test('reconnecting an interrupted duel records one forfeit and allows the next game', async t => {
  const { register, connectSocket, request } = await fixture(t);
  const clientId = randomUUID();
  const a = await register('InterruptedA', clientId), b = await register('InterruptedB');
  await race(a, b);
  const replacement = await connectSocket(a, a.cookie, clientId);
  await b.wait(phase('complete'));
  const stats = (await request('stats', undefined, a.cookie)).body;
  assert.equal(stats.totals.games, 1); assert.equal(stats.totals.losses, 1);
  replacement.send('create', { size: 4 });
  const room = await replacement.wait(phase('waiting'));
  assert.equal(room.game.players.length, 1);
});
