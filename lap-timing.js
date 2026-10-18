import { randomInt } from 'node:crypto';

export function prepareLaps(game, track, startAt) {
  game.startAt = startAt;
  game.boards = Array.from({ length: track.laps }, () => {
    const board = Array.from({ length: track.size ** 2 }, (_, i) => i + 1);
    for (let i = board.length - 1; i > 0; i--) { const j = randomInt(i + 1); [board[i], board[j]] = [board[j], board[i]]; }
    return board;
  });
  for (const p of game.players) Object.assign(p, { lap: 1, next: 1, errors: 0, lapStartAt: startAt, laps: [], splits: [], raceSplits: [], finished: false, delta: null, best: null });
}

export const sumLaps = (laps, key = 'score') => laps.reduce((total, lap) => total + lap[key], 0);

export function lapHit(game, p, data, now, lapCount) {
  if (p.finished || data.raceId !== game.saveKey || data.lap !== p.lap || !Number.isInteger(data.number) || data.number < 1 || data.number > game.size ** 2) return false;
  if (data.number !== p.next) {
    p.errors++;
    if (p.delta) p.delta.value += 100;
    return false;
  }
  const elapsed = Math.max(0, now - p.lapStartAt), score = Math.round((elapsed + p.errors * 1000) / 10);
  p.splits.push(score);
  p.raceSplits.push(sumLaps(p.laps) + score);
  p.delta = p.best ? { value: score - p.best.splits[data.number - 1], checkpoint: data.number, reference: p.best.score, historical: p.best.historical } : null;
  p.next++;
  if (p.next <= game.size ** 2) return false;
  const lap = { index: p.lap, elapsed, errors: p.errors, score, total: sumLaps(p.laps) + score, finishedAt: now, splits: [...p.splits], deltaScope: 'session', delta: p.delta?.value ?? null };
  p.laps.push(lap);
  if (!p.best || lap.score < p.best.score) p.best = { score: lap.score, splits: [...lap.splits], historical: false, lap: lap.index };
  if (p.lap === lapCount) { p.finished = true; p.elapsed = sumLaps(p.laps, 'elapsed'); p.score = sumLaps(p.laps); }
  else { p.lap++; p.next = 1; p.errors = 0; p.lapStartAt = now; p.splits = []; p.delta = null; }
  return true;
}

export function lapDriverState(p, userId) {
  return {
    id: p.id, username: p.username, me: p.id === userId, ready: p.ready, lap: p.lap ?? 1, next: p.next,
    finished: p.finished ?? false, lapStartAt: p.lapStartAt ?? null, errors: p.errors,
    totalErrors: sumLaps(p.laps ?? [], 'errors') + (p.finished ? 0 : p.errors),
    completedScore: sumLaps(p.laps ?? []), best: p.best ? { score: p.best.score, historical: p.best.historical, lap: p.best.lap ?? null } : null,
    delta: p.delta, laps: (p.laps ?? []).map(({ splits, ...lap }) => lap),
  };
}
