import { lapDriverState, sumLaps } from './lap-timing.js';

export function trainingState(game, userId) {
  const p = game.players[0], laps = p.laps ?? [];
  return {
    laps: game.training.laps,
    driver: lapDriverState(p, userId),
    summary: {
      completed: laps.length, total: sumLaps(laps), elapsed: sumLaps(laps, 'elapsed'), errors: sumLaps(laps, 'errors'),
      best: laps.length ? Math.min(...laps.map(l => l.score)) : null,
      average: laps.length ? Math.round(sumLaps(laps) / laps.length) : null,
    },
  };
}
