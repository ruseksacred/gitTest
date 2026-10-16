import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

// Keep TLS certificate and hostname verification enabled for hosted PostgreSQL.
// pg's connection-string SSL parameters otherwise override the explicit ssl option.
export function postgresOptions(connectionString) {
  let url;
  try { url = new URL(connectionString); } catch { throw Error('Nieprawidłowy DATABASE_URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw Error('DATABASE_URL musi wskazywać PostgreSQL.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const sslMode = url.searchParams.get('sslmode');
  if (!local && (['disable', 'no-verify', 'allow', 'prefer'].includes(sslMode) || url.searchParams.get('ssl') === 'false')) throw Error('Zewnętrzna baza wymaga zweryfikowanego połączenia TLS.');
  for (const key of ['sslcert', 'sslkey', 'sslrootcert']) if (url.searchParams.has(key)) throw Error('Użyj standardowego adresu Neon z sslmode=require lub verify-full.');
  url.searchParams.delete('sslmode'); url.searchParams.delete('ssl');
  return {
    connectionString: url.toString(),
    ssl: local && (!sslMode || sslMode === 'disable') ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
    max: 3,
    types: { getTypeParser(oid, format) { return [20, 1700].includes(oid) ? Number : pg.types.getTypeParser(oid, format); } },
  };
}

const schemaSQL = postgres => `
  CREATE TABLE IF NOT EXISTS users (
    id ${postgres ? 'SERIAL' : 'INTEGER'} PRIMARY KEY,
    username TEXT NOT NULL,
    salt TEXT NOT NULL, password TEXT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users(lower(username));
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
  CREATE TABLE IF NOT EXISTS matches (
    id ${postgres ? 'SERIAL' : 'INTEGER'} PRIMARY KEY, mode TEXT NOT NULL,
    size INTEGER NOT NULL, finished_at BIGINT NOT NULL, reason TEXT NOT NULL, save_key TEXT
  );
  CREATE TABLE IF NOT EXISTS results (
    match_id INTEGER NOT NULL REFERENCES matches(id), user_id INTEGER NOT NULL REFERENCES users(id),
    elapsed INTEGER, errors INTEGER NOT NULL, score INTEGER, outcome TEXT NOT NULL,
    PRIMARY KEY(match_id,user_id)
  );
  CREATE INDEX IF NOT EXISTS results_user ON results(user_id,match_id);
`;

const methods = query => ({
  async get(sql, ...args) { return (await query(sql, args)).rows[0]; },
  async all(sql, ...args) { return (await query(sql, args)).rows; },
  async run(sql, ...args) { return query(sql, args); },
});

export async function openDatabase(database, { schema } = {}) {
  if (/^postgres(?:ql)?:/.test(database)) {
    if (schema && !/^rf_test_[a-z0-9_]+$/.test(schema)) throw Error('Nieprawidłowy schemat testowy.');
    const pool = new pg.Pool({ ...postgresOptions(database), ...(schema ? { options: `-c search_path=${schema}` } : {}) });
    pool.on('error', () => console.error('PostgreSQL: zamknięto nieaktywne połączenie; kolejne żądanie utworzy nowe.'));
    const sqlFor = sql => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
    const query = (sql, args = []) => pool.query(sqlFor(sql), args);
    try {
      if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await pool.query(schemaSQL(true));
      await pool.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS save_key TEXT');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS matches_save_key ON matches(save_key)');
    } catch (error) { await pool.end(); throw error; }
    return {
      ...methods(query), dialect: 'postgres',
      async transaction(callback) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await callback(methods((sql, args) => client.query(sqlFor(sql), args)));
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      },
      async close() { await pool.end(); },
    };
  }
  if (schema) throw Error('Schemat testowy wymaga PostgreSQL.');
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
  const sqlite = new DatabaseSync(database);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  sqlite.exec(schemaSQL(false));
  if (!sqlite.prepare('PRAGMA table_info(matches)').all().some(c => c.name === 'save_key')) sqlite.exec('ALTER TABLE matches ADD COLUMN save_key TEXT');
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS matches_save_key ON matches(save_key)');
  let tail = Promise.resolve();
  const queue = operation => { const pending = tail.then(operation); tail = pending.catch(() => {}); return pending; };
  const rawQuery = (sql, args) => {
    const statement = sqlite.prepare(sql);
    return { rows: statement.columns().length ? statement.all(...args) : (statement.run(...args), []) };
  };
  return {
    ...methods((sql, args) => queue(() => rawQuery(sql, args))), dialect: 'sqlite',
    transaction(callback) {
      return queue(async () => {
        sqlite.exec('BEGIN');
        try { const result = await callback(methods(rawQuery)); sqlite.exec('COMMIT'); return result; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
    },
    async close() { await tail; sqlite.close(); },
  };
}
