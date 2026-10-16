import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';
import { seedRun } from './run-fixture.js';

async function fixture(t) {
  const target = databaseFixture();
  const app = await createApp(target.options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await target.cleanup(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function register(username) {
    const response = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username, password: 'Ranking-test-123' }) });
    assert.equal(response.status, 201);
    return { ...(await response.json()).user, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  async function get(query = '', cookie) {
    const response = await fetch(`${base}/api/runs${query ? `?${query}` : ''}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: response.status, body: await response.json() };
  }
  return { db: app.db, register, get };
}

test('run ranking: authentication and strict filter validation', async t => {
  const { register, get } = await fixture(t);
  assert.equal((await get()).status, 401);
  const a = await register('RankingDriver');
  for (const query of ['mode=bad', 'mode=solo&mode=duel', 'size=2', 'size=3', 'size=8', 'size=6.5', 'size=04', 'page=0', 'page=-1', 'page=1e3', 'limit=51', 'limit=0', 'highlight=0', 'highlight=abc', 'size=6&size=4']) {
    assert.equal((await get(query, a.cookie)).status, 400, query);
  }
  const { body } = await get('', a.cookie);
  assert.equal(body.total, 0); assert.equal(body.page, 1); assert.equal(body.pages, 1);
  assert.equal(body.summary.best, null); assert.equal(body.summary.errors, 0);
});

test('run ranking: penalties determine places, ties share place, filters and ownership protect history', async t => {
  const { db, register, get } = await fixture(t);
  const a = await register('RankA'), b = await register('RankB');
  const penalized = await seedRun(db, a.id, { elapsed: 8000, errors: 3, finishedAt: 100 });
  const clean = await seedRun(db, a.id, { elapsed: 10000, finishedAt: 300 });
  const tie = await seedRun(db, a.id, { elapsed: 9000, errors: 1, finishedAt: 200 });
  const duel = await seedRun(db, a.id, { mode: 'duel', opponent: b.id, elapsed: 12000 });
  const large = await seedRun(db, a.id, { size: 6, elapsed: 5000 });
  const largest = await seedRun(db, a.id, { size: 7, elapsed: 7000, errors: 2 });
  await seedRun(db, a.id, { size: 5, elapsed: 30000 });
  await seedRun(db, a.id, { elapsed: null, reason: 'timeout' });
  const privateRun = await seedRun(db, b.id, { elapsed: 100 });
  const all = (await get('', a.cookie)).body;
  assert.deepEqual(all.rows.map(r => r.id), [tie, clean, penalized, duel]);
  assert.deepEqual(all.rows.map(r => r.place), [1, 1, 3, 4]);
  assert.equal(all.summary.best, 1000); assert.equal(all.summary.average, 1075);
  assert.equal(all.summary.errors, 4); assert.equal(all.summary.clean, 2);
  assert.equal(all.rows[3].opponent, 'RankB');
  assert.equal((await get('mode=solo', a.cookie)).body.total, 3);
  assert.deepEqual((await get('mode=duel', a.cookie)).body.rows.map(r => r.id), [duel]);
  assert.deepEqual((await get('size=6', a.cookie)).body.rows.map(r => r.id), [large]);
  const sizeSeven = (await get(`size=7&highlight=${largest}`, a.cookie)).body;
  assert.equal(sizeSeven.rows[0].id, largest); assert.equal(sizeSeven.rows[0].score, 900);
  assert.equal(sizeSeven.highlight.place, 1);
  assert.equal((await get('size=5', a.cookie)).body.total, 1);
  assert.equal((await get(`highlight=${privateRun}`, a.cookie)).body.highlight, null);
  assert.equal((await get(`mode=solo&highlight=${duel}`, a.cookie)).body.highlight, null);
  const faster = await seedRun(db, a.id, { elapsed: 7500, errors: 1 });
  const updated = (await get(`highlight=${faster}`, a.cookie)).body;
  assert.equal(updated.rows[0].id, faster); assert.equal(updated.highlight.place, 1);
  assert.deepEqual(updated.rows.map(r => r.place), [1, 2, 2, 4, 5]);
});

test('run ranking: full history, pagination and automatic navigation to new result across tied pages', async t => {
  const { db, register, get } = await fixture(t);
  const a = await register('LongHistory');
  const ids = [];
  for (let i = 0; i < 45; i++) ids.push(await seedRun(db, a.id, { elapsed: 10000, finishedAt: (i + 1) * 10 }));
  const first = (await get('mode=solo', a.cookie)).body;
  assert.equal(first.total, 45); assert.equal(first.rows.length, 20); assert.equal(first.pages, 3);
  assert.equal(first.rows[0].id, ids[0], 'An old result remains in the ranking');
  const last = (await get('mode=solo&page=999', a.cookie)).body;
  assert.equal(last.page, 3); assert.equal(last.rows.length, 5);
  const marked = (await get(`mode=solo&highlight=${ids[44]}`, a.cookie)).body;
  assert.equal(marked.page, 3); assert.equal(marked.highlight.place, 1);
  assert.equal(marked.rows.at(-1).id, ids[44]);
  const idsFromPages = [];
  for (let page = 1; page <= 3; page++) idsFromPages.push(...(await get(`page=${page}`, a.cookie)).body.rows.map(r => r.id));
  assert.deepEqual(idsFromPages, ids, 'Stable tie ordering never duplicates or skips runs');
  const mid = await seedRun(db, a.id, { elapsed: 9000, errors: 1, finishedAt: 245 });
  const middlePage = (await get(`highlight=${mid}&limit=10`, a.cookie)).body;
  assert.equal(middlePage.page, 3); assert.equal(middlePage.rows[4].id, mid);
});
