import { randomUUID } from 'node:crypto';

export function parseTracks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const seen = new Set();
  for (const track of value) {
    if (!track || typeof track !== 'object' || ![4, 5, 6, 7].includes(track.size) || !Number.isInteger(track.laps) || track.laps < 1 || track.laps > 10 || seen.has(track.size)) return null;
    seen.add(track.size);
  }
  return value.map(({ size, laps }) => ({ size, laps, points: 1 + (size - 4) / 2 })).sort((a, b) => a.size - b.size);
}

export function createDuel(tracks) {
  const schedule = tracks.flatMap(track => Array.from({ length: track.laps }, (_, i) => ({ ...track, lap: i + 1 })));
  return { id: randomUUID(), tracks, schedule, createdAt: Date.now(), status: 'active', finishedAt: null, forfeiter: null, rounds: [], report: null };
}

export function roundReport(game, matchId) {
  const stage = game.duel.schedule[game.round - 1];
  const scores = game.players.map(p => p.score).filter(score => score !== null);
  const best = scores.length ? Math.min(...scores) : null;
  return {
    index: game.round, size: game.size, lap: stage.lap, laps: stage.laps, points: stage.points,
    matchId, finishedAt: game.finishedAt, reason: game.reason,
    players: game.players.map(p => ({
      id: p.id, username: p.username, elapsed: p.elapsed, errors: p.errors, score: p.score, outcome: p.outcome,
      // Quarter points represent split 1.5 / 2.5-point wins exactly.
      points: p.score === null ? 0 : p.outcome === 'win' ? stage.points : p.outcome === 'draw' ? stage.points / 2 : 0,
      gap: p.score === null || best === null ? null : p.score - best,
    })),
  };
}

export function duelReport(duel, participants, rounds = duel.rounds) {
  const status = duel.status !== 'active' ? duel.status : rounds.length === duel.schedule.length ? 'complete' : 'active';
  const players = participants.map(p => {
    const laps = rounds.map(r => r.players.find(x => x.id === p.id));
    const finished = laps.filter(r => r.score !== null);
    return {
      id: p.id, username: p.username, points: laps.reduce((sum, r) => sum + r.points, 0),
      attempted: laps.length, completed: finished.length, wins: laps.filter(r => r.outcome === 'win').length,
      errors: laps.reduce((sum, r) => sum + r.errors, 0),
      total: laps.length && finished.length === laps.length ? finished.reduce((sum, r) => sum + r.score, 0) : null,
    };
  });
  const topPoints = Math.max(...players.map(p => p.points));
  const allFinished = rounds.length > 0 && players.every(p => p.total !== null);
  const bestTotal = allFinished ? Math.min(...players.map(p => p.total)) : null;
  const winner = status === 'forfeit' ? players.find(p => p.id !== duel.forfeiter)?.id ?? null
    : status === 'complete' && players.filter(p => p.points === topPoints).length === 1 ? players.find(p => p.points === topPoints).id : null;
  for (const p of players) {
    p.place = status === 'forfeit' ? p.id === winner ? 1 : 2 : 1 + players.filter(other => other.points > p.points).length;
    p.pointsGap = topPoints - p.points;
    p.timeGap = p.total === null || bestTotal === null ? null : p.total - bestTotal;
  }
  const tracks = duel.tracks.map(track => {
    const lapRows = rounds.filter(r => r.size === track.size);
    const rows = players.map(p => {
      const laps = lapRows.map(r => r.players.find(x => x.id === p.id));
      const completed = laps.filter(r => r.score !== null);
      const scores = completed.map(r => r.score);
      return {
        id: p.id, username: p.username, attempted: laps.length, completed: completed.length,
        best: scores.length ? Math.min(...scores) : null,
        average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
        total: scores.length && scores.length === laps.length ? scores.reduce((a, b) => a + b, 0) : null,
        errors: laps.reduce((sum, r) => sum + r.errors, 0), points: laps.reduce((sum, r) => sum + r.points, 0),
      };
    });
    const bestTimes = rows.filter(p => p.best !== null).map(p => p.best);
    const best = bestTimes.length ? Math.min(...bestTimes) : null;
    const total = rows.every(p => p.total !== null) ? Math.min(...rows.map(p => p.total)) : null;
    for (const row of rows) {
      row.bestGap = row.best === null || best === null ? null : row.best - best;
      row.totalGap = row.total === null || total === null ? null : row.total - total;
    }
    return { ...track, players: rows };
  });
  return {
    id: duel.id, createdAt: duel.createdAt, finishedAt: status === 'active' ? null : duel.finishedAt ?? rounds.at(-1)?.finishedAt ?? Date.now(),
    status, winner, forfeiter: duel.forfeiter, totalRounds: duel.schedule.length, completedRounds: rounds.length,
    players: players.sort((a, b) => a.place - b.place), tracks, rounds,
  };
}

export async function saveDuel(tx, report) {
  const [a, b] = report.players;
  await tx.run(`INSERT INTO duel_events(id,player_a,player_b,created_at,updated_at,status,report) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status,report=excluded.report`,
  report.id, a.id, b.id, report.createdAt, report.finishedAt ?? Date.now(), report.status, JSON.stringify(report));
}
