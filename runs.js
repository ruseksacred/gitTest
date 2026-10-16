export function parseRunFilters(query) {
  function integer(name, fallback, max) {
    const raw = query[name];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return NaN;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value <= max ? value : NaN;
  }
  const filters = {
    mode: query.mode ?? 'all',
    size: integer('size', 4, 5),
    page: integer('page', 1, 1000000000),
    limit: integer('limit', 20, 50),
    highlight: integer('highlight', null, 2147483647),
  };
  if (!['all', 'solo', 'duel'].includes(filters.mode) || ![3, 4, 5].includes(filters.size) || !Number.isFinite(filters.page) || !Number.isFinite(filters.limit) || (filters.highlight !== null && !Number.isFinite(filters.highlight))) return null;
  return filters;
}

export async function rankedRuns(db, userId, filters) {
  const { mode, size, limit } = filters;
  const where = `r.user_id=? AND m.size=? AND r.score IS NOT NULL AND r.elapsed IS NOT NULL${mode === 'all' ? '' : ' AND m.mode=?'}`;
  const args = [userId, size, ...(mode === 'all' ? [] : [mode])];
  const ranked = `WITH filtered AS (
    SELECT m.id, m.mode, m.size, m.finished_at, m.reason, r.elapsed, r.errors, r.score, r.outcome,
      (SELECT u.username FROM results rival JOIN users u ON u.id=rival.user_id WHERE rival.match_id=m.id AND rival.user_id<>r.user_id) opponent
    FROM results r JOIN matches m ON m.id=r.match_id WHERE ${where}
  ), ranked AS (
    SELECT *, RANK() OVER (ORDER BY score ASC) place,
      ROW_NUMBER() OVER (ORDER BY score ASC, finished_at ASC, id ASC) row_index FROM filtered
  )`;
  return db.transaction(async tx => {
    // One consistent snapshot: a result arriving during pagination cannot make
    // the summary, highlighted position and returned page disagree.
    if (db.dialect === 'postgres') await tx.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const summary = await tx.get(`SELECT COUNT(*) count, MIN(r.score) best, ROUND(AVG(r.score)) average,
      COALESCE(SUM(r.errors),0) errors, COALESCE(SUM(CASE WHEN r.errors=0 THEN 1 ELSE 0 END),0) clean
      FROM results r JOIN matches m ON m.id=r.match_id WHERE ${where}`, ...args);
    const pages = Math.max(1, Math.ceil(summary.count / limit));
    let page = Math.min(filters.page, pages), highlight = null;
    if (filters.highlight !== null) {
      const entry = await tx.get(`${ranked} SELECT id, place, row_index FROM ranked WHERE id=?`, ...args, filters.highlight);
      if (entry) { page = Math.ceil(entry.row_index / limit); highlight = { id: entry.id, place: entry.place, page }; }
    }
    const rows = await tx.all(`${ranked} SELECT * FROM ranked ORDER BY row_index ASC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    return { mode, size, page, pages, limit, total: summary.count, summary, highlight, rows };
  });
}
