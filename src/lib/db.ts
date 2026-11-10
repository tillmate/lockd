import pg, { type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { pgConfig, runtimeDatabaseUrl } from './env';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let pool: pg.Pool | undefined;
export function database() {
  const url = runtimeDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL is required. Run npm run db:local first.');
  if (!pool) {
    pool = new pg.Pool({
      ...pgConfig(url),
      max: 15,
      statement_timeout: 15000,
    });
    // pg-pool re-emits errors from idle clients (database restart, failover); it discards the
    // broken client, but without a listener the error would crash the process.
    pool.on('error', (e) => console.error('Database connection error:', e.message));
  }
  return pool;
}
export type Context = { session?: string; guest?: string };
export async function transaction<T>(ctx: Context, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await database().connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query(
      "SELECT set_config('lockd.session_hash',$1,true),set_config('lockd.guest_hash',$2,true)",
      [ctx.session ? hash(ctx.session) : '', ctx.guest ? hash(ctx.guest) : ''],
    );
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}
