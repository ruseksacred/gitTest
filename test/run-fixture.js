export async function seedRun(db, userId, { mode = 'solo', size = 4, elapsed = 10000, errors = 0, score = elapsed === null ? null : Math.round((elapsed + errors * 1000) / 10), finishedAt = Date.now(), opponent = null, outcome = mode === 'solo' ? 'solo' : 'win', reason = 'finished' } = {}) {
  return db.transaction(async tx => {
    const { id } = await tx.get('INSERT INTO matches(mode,size,finished_at,reason) VALUES (?,?,?,?) RETURNING id', mode, size, finishedAt, reason);
    await tx.run('INSERT INTO results VALUES (?,?,?,?,?,?)', id, userId, elapsed, errors, score, outcome);
    if (opponent) await tx.run('INSERT INTO results VALUES (?,?,?,?,?,?)', id, opponent, elapsed, errors, score, 'loss');
    return id;
  });
}
