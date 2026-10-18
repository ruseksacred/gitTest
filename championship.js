import { randomUUID } from 'node:crypto';
import { prepareLaps, lapHit, lapDriverState, sumLaps as sum } from './lap-timing.js';

export function createChampionship(tracks) {
  return { id: randomUUID(), tracks: tracks.map(({ size, laps }) => ({ size, laps })), createdAt: Date.now(), status: 'active', finishedAt: null, forfeiter: null, races: [], report: null };
}

// Both solo training and championships use the same lap clock and current-race checkpoints.
export function prepareRace(game, startAt) {
  prepareLaps(game, game.championship.tracks[game.round - 1], startAt);
}
export function raceHit(game, p, data, now) {
  return lapHit(game, p, data, now, game.championship.tracks[game.round - 1].laps);
}

export function timingGap(a, b, cells) {
  if (!a?.raceSplits || !b?.raceSplits) return null;
  const common = Math.min(a.raceSplits.length, b.raceSplits.length);
  if (!common) return null;
  return { value: a.raceSplits[common - 1] - b.raceSplits[common - 1], lap: Math.floor((common - 1) / cells) + 1, checkpoint: (common - 1) % cells + 1 };
}

export function raceState(game, userId) {
  const champ = game.championship, track = champ.tracks[game.round - 1];
  const me = game.players.find(p => p.id === userId), rival = game.players.find(p => p.id !== userId);
  return {
    id: champ.id, raceId: game.saveKey, tracks: champ.tracks, race: game.round, races: champ.tracks.length,
    laps: track.laps, status: champ.status, next: champ.status === 'active' ? champ.tracks[game.round] ?? null : null,
    standings: champ.report?.players ?? [], report: game.phase === 'complete' ? champ.report : null,
    gap: timingGap(me, rival, game.size ** 2),
    drivers: game.players.map(p => lapDriverState(p, userId)),
  };
}

export function raceResult(game, matchIds = []) {
  const track = game.championship.tracks[game.round - 1];
  const finishers = game.players.filter(p => p.finished && !(game.reason === 'forfeit' && p.id === game.forfeitLoser));
  const bestTotal = finishers.length ? Math.min(...finishers.map(p => p.score)) : null;
  const players = game.players.map(p => {
    const classified = finishers.includes(p), score = classified ? p.score : null;
    const ahead = classified ? finishers.filter(q => q.score < score).length : finishers.length;
    const tied = classified ? finishers.filter(q => q.score === score).length : 0;
    const place = classified ? ahead + 1 : null;
    // Points follow the finishing order: N for first, one for last. Equal
    // classified times share the points of the positions they occupy.
    const points = classified ? game.players.length - ahead - (tied - 1) / 2 : 0;
    const laps = (p.laps ?? []).map(({ splits, ...lap }) => ({ ...lap, matchId: matchIds[lap.index - 1] ?? null }));
    return { id: p.id, username: p.username, place, points, classified, score, elapsed: classified ? p.elapsed : null,
      errors: sum(p.laps ?? [], 'errors') + (p.finished ? 0 : p.errors), best: laps.length ? Math.min(...laps.map(l => l.score)) : null,
      average: laps.length ? Math.round(sum(laps) / laps.length) : null, gap: score === null ? null : score - bestTotal, laps };
  });
  const winners = players.filter(p => p.place === 1);
  return { index: game.round, size: game.size, laps: track.laps, reason: game.reason, finishedAt: game.finishedAt,
    winner: winners.length === 1 ? winners[0].id : null, players: players.sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity)) };
}

export function championshipReport(champ, participants, races = champ.races) {
  const status = champ.status !== 'active' ? champ.status : races.length === champ.tracks.length ? 'complete' : 'active';
  const players = participants.map(p => {
    const results = races.map(r => r.players.find(q => q.id === p.id));
    return { id: p.id, username: p.username, points: results.reduce((n, r) => n + r.points, 0), wins: results.filter(r => r.place === 1 && r.points === participants.length).length,
      completedRaces: results.filter(r => r.classified).length, completed: results.reduce((n, r) => n + r.laps.length, 0),
      errors: results.reduce((n, r) => n + r.errors, 0), total: results.length && results.every(r => r.score !== null) ? results.reduce((n, r) => n + r.score, 0) : null };
  });
  const top = Math.max(...players.map(p => p.points));
  const winner = status === 'forfeit' ? players.find(p => p.id !== champ.forfeiter)?.id ?? null
    : status === 'complete' && players.filter(p => p.points === top).length === 1 ? players.find(p => p.points === top).id : null;
  for (const p of players) { p.place = status === 'forfeit' ? p.id === winner ? 1 : 2 : players.filter(q => q.points > p.points).length + 1; p.pointsGap = top - p.points; }
  return { format: 'championship-v1', id: champ.id, status, winner, forfeiter: champ.forfeiter, createdAt: champ.createdAt,
    finishedAt: status === 'active' ? null : champ.finishedAt ?? races.at(-1)?.finishedAt ?? Date.now(),
    totalRounds: champ.tracks.length, completedRounds: races.length, totalLaps: champ.tracks.reduce((n, t) => n + t.laps, 0),
    tracks: champ.tracks, players: players.sort((a, b) => a.place - b.place), races };
}
