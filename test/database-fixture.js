import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { postgresOptions } from '../database.js';

export function databaseFixture(explicitDatabase) {
  if (explicitDatabase || !process.env.TEST_DATABASE_URL) return { options: { database: explicitDatabase || ':memory:' }, cleanup: async () => {} };
  const schema = `rf_test_${randomBytes(8).toString('hex')}`;
  return {
    options: { database: process.env.TEST_DATABASE_URL, databaseSchema: schema },
    async cleanup() {
      const pool = new pg.Pool(postgresOptions(process.env.TEST_DATABASE_URL));
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
