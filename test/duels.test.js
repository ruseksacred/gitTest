import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTracks, createDuel, roundReport, duelReport, saveDuel } from '../duels.js';
import { createApp } from '../server.js';
import { databaseFixture } from './database-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('duel plans: canonical track order, strict bounds and fixed points even when smaller tracks are skipped', () => {
  assert.deepEqual(parseTracks([{ size: 7, laps: 1 }, { size: 5, laps: 3 }]), [{ size: 5, laps: 3, points: 1.5 }, { size: 7, laps: 1, points: 2.5 }]);
  for (const value of [undefined, null, {}, [], [{ size: 3, laps: 1 }], [{ size: 8, laps: 1 }], [{ size: '4', laps: 1 }], [{ size: 4, laps: 0 }], [{ size: 4, laps: 11 }], [{ size: 4, laps: 1.5 }], [{ size: 4, laps: '2' }], [{ size: 4, laps: 1 }, { size: 4, laps: 2 }]]) assert.equal(parseTracks(value), null);
  const duel = createDuel(parseTracks([{ size: 5, laps: 2 }, { size: 7, laps: 1 }]));
  assert.deepEqual(duel.schedule.map(s => [s.size, s.lap, s.points]), [[5, 1, 1.5], [5, 2, 1.5], [7, 1, 2.5]]);
});

test('duel report: weighted points, quarter-point draws, penalties, personal records, averages and comparable gaps', () => {
  const duel = createDuel(parseTracks([{ size: 4, laps: 1 }, { size: 5, laps: 2 }, { size: 7, laps: 1 }]));
  const participants = [{ id: 1, username: 'A' }, { id: 2, username: 'B' }];
  const times = [[[8000, 2], [9000, 0]], [[14000, 1], [15000, 0]], [[10000, 0], [12000, 2]], [[18000, 1], [null, 0]]];
  const rounds = times.map((pair, index) => {
    const scores = pair.map(([elapsed, errors]) => elapsed === null ? null : Math.round((elapsed + errors * 1000) / 10));
    const players = pair.map(([elapsed, errors], i) => ({ ...participants[i], elapsed, errors, score: scores[i], outcome: scores[i] === scores[1 - i] ? 'draw' : (scores[i] ?? Infinity) < (scores[1 - i] ?? Infinity) ? 'win' : 'loss' }));
    return roundReport({ duel, round: index + 1, size: duel.schedule[index].size, players, finishedAt: 1000 + index, reason: index === 3 ? 'timeout' : 'finished' }, index + 1);
  });
  const report = duelReport(duel, participants, rounds);
  assert.equal(report.status, 'complete'); assert.equal(report.winner, 1);
  assert.deepEqual(report.players.map(p => p.points), [4.75, 1.75]);
  assert.deepEqual(report.rounds[1].players.map(p => p.points), [.75, .75]);
  assert.equal(report.rounds[0].players[0].gap, 100);
  assert.equal(report.rounds[3].players[1].gap, null);
  assert.equal(report.players[0].total, 5400); assert.equal(report.players[1].total, null);
  assert.equal(report.players[0].timeGap, null, 'A partial rival total is not a comparable time');
  const track = report.tracks.find(t => t.size === 5);
  assert.deepEqual(track.players.map(p => p.best), [1000, 1400]);
  assert.deepEqual(track.players.map(p => p.average), [1250, 1450]);
  assert.deepEqual(track.players.map(p => p.bestGap), [0, 400]);
  assert.deepEqual(track.players.map(p => p.totalGap), [0, 400]);
  assert.deepEqual(track.players.map(p => p.points), [2.25, .75]);
  assert.equal(report.players[0].pointsGap, 0); assert.equal(report.players[1].pointsGap, 3);
  const forfeit = duelReport({ ...duel, status: 'forfeit', forfeiter: 1 }, participants, rounds);
  assert.equal(forfeit.winner, 2); assert.equal(forfeit.players[0].id, 2);
  assert.deepEqual(forfeit.rounds, rounds, 'A forfeit does not manufacture unplayed laps');
});

test('duel report: uncompleted draws earn no points; equal final points remain a draw', () => {
  const duel = createDuel(parseTracks([{ size: 7, laps: 1 }]));
  const players = [{ id: 1, username: 'A' }, { id: 2, username: 'B' }].map(p => ({ ...p, elapsed: 10000, errors: 0, score: 1000, outcome: 'draw' }));
  let round = roundReport({ duel, round: 1, size: 7, players, finishedAt: 1000, reason: 'finished' }, 1);
  assert.deepEqual(round.players.map(p => p.points), [1.25, 1.25]);
  assert.equal(duelReport(duel, players, [round]).winner, null);
  round = roundReport({ duel, round: 1, size: 7, players: players.map(p => ({ ...p, elapsed: null, score: null })), finishedAt: 1000, reason: 'timeout' }, 1);
  assert.deepEqual(round.players.map(p => p.points), [0, 0]);
  round = roundReport({ duel, round: 1, size: 7, players: players.map((p, i) => ({ ...p, elapsed: null, score: null, outcome: i ? 'loss' : 'win' })), finishedAt: 1000, reason: 'forfeit' }, 1);
  assert.deepEqual(round.players.map(p => p.points), [0, 0], 'An uncompleted forfeit awards the match but no fictitious lap points');
});

test('duel history: final reports survive reopening the database and unfinished reports become interrupted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rf-duel-restart-'));
  const target = databaseFixture(process.env.TEST_DATABASE_URL ? undefined : join(directory, 'db.sqlite'));
  let first, second;
  t.after(async () => { if (first) await first.close(); if (second) await second.close(); await target.cleanup(); rmSync(directory, { recursive: true, force: true }); });
  first = await createApp(target.options);
  await new Promise(resolve => first.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${first.server.address().port}`;
  const participants = [];
  let cookie;
  for (const username of ['RestartA', 'RestartB']) {
    const response = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Restart-test-123' }) });
    assert.equal(response.status, 201);
    participants.push((await response.json()).user); cookie = response.headers.get('set-cookie').split(';')[0];
  }
  const completed = createDuel(parseTracks([{ size: 5, laps: 1 }]));
  const active = createDuel(parseTracks([{ size: 5, laps: 2 }]));
  const players = participants.map((p, index) => ({ ...p, elapsed: 10000 + index * 1000, errors: 0, score: 1000 + index * 100, outcome: index ? 'loss' : 'win' }));
  const finalReport = duelReport(completed, participants, [roundReport({ duel: completed, round: 1, size: 5, players, finishedAt: Date.now(), reason: 'finished' }, 1)]);
  const activeReport = duelReport(active, participants, [roundReport({ duel: active, round: 1, size: 5, players, finishedAt: Date.now(), reason: 'finished' }, 2)]);
  await first.db.transaction(async tx => { await saveDuel(tx, finalReport); await saveDuel(tx, activeReport); });
  await first.close(); first = null;
  second = await createApp(target.options);
  await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve));
  const after = `http://127.0.0.1:${second.server.address().port}`;
  const read = async id => (await (await fetch(`${after}/api/duels/${id}`, { headers: { Cookie: cookie } })).json()).report;
  assert.deepEqual(await read(completed.id), finalReport);
  const interrupted = await read(active.id);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.winner, null);
  assert.deepEqual(interrupted.rounds, activeReport.rounds);
  assert.equal(interrupted.players[0].points, 1.5);
});
