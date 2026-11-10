import pg from 'pg';
import { notifierDatabaseUrl, pgConfig, runtimeDatabaseUrl } from '../src/lib/env.js';

// Post-release check (CI and the hosting shell): both restricted roles connect with the composed
// URLs, the demo directory is seeded, and the web role still cannot read tables directly.
async function as<T>(url: string | undefined, run: (c: pg.Client) => Promise<T>) {
  if (!url) throw new Error('Database URL could not be composed; check DB_HOST and passwords');
  const c = new pg.Client(pgConfig(url));
  await c.connect();
  try {
    return await run(c);
  } finally {
    await c.end();
  }
}
await as(runtimeDatabaseUrl(), async (c) => {
  const user = (await c.query('SELECT current_user AS u')).rows[0].u;
  if (user !== 'lockd_runtime') throw new Error(`Web role is ${user}, expected lockd_runtime`);
  const slugs = (
    (await c.query('SELECT lockd.public_profiles() AS p')).rows[0].p as { slug: string }[]
  ).map((p) => p.slug);
  for (const slug of ['jordan-p', 'leah-m', 'andre-j', 'tasha-k', 'demo-your-business'])
    if (!slugs.includes(slug)) throw new Error(`Demo listing ${slug} is missing`);
  const denied = await c.query('SELECT 1 FROM lockd.users').then(
    () => false,
    (e) => e.code === '42501',
  );
  if (!denied) throw new Error('Web role can read lockd.users directly');
});
await as(notifierDatabaseUrl(), async (c) => {
  const user = (await c.query('SELECT current_user AS u')).rows[0].u;
  if (user !== 'lockd_notifier') throw new Error(`Worker role is ${user}, expected lockd_notifier`);
  await c.query('SELECT lockd.expire_all()');
});
console.log('Staging smoke check passed.');
