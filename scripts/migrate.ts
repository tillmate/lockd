import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pgConfig } from '../src/lib/env.js';
// Remote databases are only migrated by the reviewed staging release (scripts/staging-release.ts),
// which must pass allowRemote and run with LOCKD_ENV=staging. Production has no path here.
export async function migrate(url: string, { allowRemote = false } = {}) {
  const u = new URL(url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!local && !(allowRemote && process.env.LOCKD_ENV === 'staging'))
    throw new Error(
      'Migration tool only permits a local database. Remote migrations require a separately reviewed release process.',
    );
  const c = new pg.Client(pgConfig(url));
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(717243)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS public.schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of readdirSync('db')
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      if ((await c.query('SELECT 1 FROM public.schema_migrations WHERE name=$1', [name])).rowCount)
        continue;
      const sql = readFileSync(`db/${name}`, 'utf8')
        .replace(/^\s*BEGIN;/i, '')
        .replace(/COMMIT;\s*$/i, '');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO public.schema_migrations(name) VALUES($1)', [name]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
      console.log(`Applied ${name}`);
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(717243)');
    await c.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* CI uses environment */
  }
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL required');
  await migrate(process.env.MIGRATION_DATABASE_URL);
}
