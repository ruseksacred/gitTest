import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChampionship, prepareRace, raceHit, raceState, timingGap, raceResult, championshipReport } from '../championship.js';

function game(laps = 2) {
  const championship = createChampionship([{ size: 4, laps }]);
  const g = { championship, round: 1, size: 4, saveKey: 'race-one', phase: 'racing', players: [1, 2].map(id => ({ id, username: 'Driver' + id, ready: false, next: 1, errors: 0, elapsed: null, score: null })) };
  prepareRace(g, 1000); return g;
}
function hit(g, p, number, now, lap = p.lap) { return raceHit(g, p, { number, lap, raceId: g.saveKey }, now); }

test('continuous race: a driver starts lap two immediately, with common boards and stale lap packets ignored', () => {
  const g = game(), [a, b] = g.players;
  for (let n = 1; n <= 16; n++) hit(g, a, n, 1000 + n * 10);
  assert.equal(a.lap, 2); assert.equal(a.next, 1); assert.equal(a.laps[0].score, 16);
  assert.equal(b.lap, 1); assert.equal(b.next, 1);
  assert.deepEqual(raceState(g, a.id).drivers[0].laps[0].score, 16);
  assert.equal(a.best.score, 16);
  assert.equal(hit(g, a, 16, 1170, 1), false);
  assert.equal(a.errors, 0); assert.equal(a.next, 1);
  raceHit(g, a, { number: 1, lap: 2, raceId: 'previous-race' }, 1180);
  assert.equal(a.next, 1);
  hit(g, a, 1, 1200);
  assert.equal(a.delta.value, 3); assert.equal(a.delta.checkpoint, 1);
  hit(g, a, 9, 1201);
  assert.equal(a.delta.value, 103); assert.equal(a.errors, 1);
  hit(g, b, 1, 1300);
  assert.deepEqual(timingGap(a, b, 16), { value: -29, lap: 1, checkpoint: 1 });
  assert.deepEqual(timingGap(b, a, 16), { value: 29, lap: 1, checkpoint: 1 });
  assert.equal(g.boards.length, 2); assert.equal(g.boards[1].length, 16);
  assert.ok(!JSON.stringify(raceState(g, a.id)).includes('splits'), 'Timing state must not expose reference arrays or future boards');
});

test('delta uses only the driver’s best completed lap in this race, updates on faster laps and resets at the next race', () => {
  const g = game(3), [a, b] = g.players;
  // A faster reference from a previous race is never used.
  a.best = { score: 1, splits: Array(16).fill(1), historical: true };
  prepareRace(g, 1000);
  hit(g, a, 1, 1100); assert.equal(a.delta, null);
  for (let n = 2; n <= 16; n++) hit(g, a, n, 1000 + n * 100);
  assert.equal(a.best.score, 160); assert.equal(a.laps[0].delta, null);
  assert.equal(a.laps[0].deltaScope, 'session');
  assert.equal(b.best, null, 'Each driver keeps their own lap reference');
  hit(g, a, 1, 2650); assert.equal(a.delta.value, -5);
  hit(g, a, 7, 2660); assert.equal(a.delta.value, 95);
  hit(g, a, 2, 2700); assert.equal(a.delta.value, 90);
  for (let n = 3; n <= 16; n++) hit(g, a, n, 2600 + n * 50);
  assert.equal(a.laps[1].score, 180); assert.equal(a.best.score, 160);
  for (let n = 1; n <= 16; n++) hit(g, a, n, 3400 + n * 50);
  assert.equal(a.finished, true); assert.equal(a.best.score, 80);
  assert.equal(a.laps[2].delta, -80);
  prepareRace(g, 5000);
  assert.equal(a.best, null); assert.equal(a.delta, null);
  hit(g, a, 1, 5100); assert.equal(a.delta, null);
});

test('race classification awards points once per track, from last to first, and shares tied positions', () => {
  const g = game(), [a, b] = g.players;
  for (const p of [a, b]) { p.finished = true; p.laps = [{ index: 1, score: p.id === 1 ? 700 : 500, elapsed: 5000, errors: 0 }, { index: 2, score: p.id === 1 ? 300 : 600, elapsed: 5000, errors: 0 }]; p.score = p.laps.reduce((n, l) => n + l.score, 0); p.elapsed = 10000; }
  let result = raceResult(g);
  assert.deepEqual(result.players.map(p => p.points), [2, 1]);
  assert.equal(result.winner, a.id); assert.equal(result.players[1].gap, 100);
  assert.ok(result.players.every(p => p.laps.every(l => l.points === undefined)));
  b.score = a.score;
  result = raceResult(g); assert.deepEqual(result.players.map(p => p.points), [1.5, 1.5]); assert.equal(result.winner, null);
  b.finished = false; b.score = null;
  result = raceResult(g); assert.deepEqual(result.players.map(p => p.points), [2, 0]);
  const c = { ...a, id: 3, username: 'Driver3', score: 1200 }; b.finished = true; b.score = 1100; g.players.push(c);
  assert.deepEqual(raceResult(g).players.map(p => p.points), [3, 2, 1]);
});

test('championship totals count completed races, keep ties and preserve an explicit forfeit', () => {
  const g = game(1), [a, b] = g.players;
  g.championship.tracks.push({ size: 7, laps: 1 });
  for (const p of [a, b]) { p.finished = true; p.elapsed = 10000; p.score = p.id === 1 ? 1000 : 1100; p.laps = [{ index: 1, score: p.score, elapsed: 10000, errors: 0 }]; }
  const first = raceResult(g); g.round = 2; g.size = 7;
  a.score = 1200; b.score = 1000;
  const second = raceResult(g);
  const report = championshipReport(g.championship, g.players, [first, second]);
  assert.equal(report.status, 'complete'); assert.equal(report.winner, null);
  assert.deepEqual(report.players.map(p => p.points), [3, 3]);
  assert.equal(report.completedRounds, 2);
  const partial = championshipReport(g.championship, g.players, [first]); assert.equal(partial.status, 'active');
  const ended = championshipReport({ ...g.championship, status: 'forfeit', forfeiter: a.id }, g.players, [first]);
  assert.equal(ended.winner, b.id); assert.equal(ended.races.length, 1);
});
