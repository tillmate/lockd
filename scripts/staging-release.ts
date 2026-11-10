import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrate } from './migrate.js';
import { seedDemo } from './seed-demo.js';
import { keyConfigured } from '../src/lib/mfa.js';

// Render pre-deploy step for the staging demo: migrate, give the restricted database roles their
// generated passwords, then (re)seed synthetic demo data. Refuses to run anywhere but staging.
export async function stagingRelease() {
  if (process.env.LOCKD_ENV !== 'staging')
    throw new Error('staging:release only runs with LOCKD_ENV=staging');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  for (const name of ['RUNTIME_DB_PASSWORD', 'NOTIFIER_DB_PASSWORD'])
    if (!process.env[name]) throw new Error(`${name} is required`);
  for (const name of ['STAFF_MFA_KEY', 'NOTIFICATION_KEY'] as const)
    if (!keyConfigured(name)) throw new Error(`${name} must be 32 bytes (64 hex or base64)`);
  await migrate(url, { allowRemote: true });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const [role, secret] of [
      ['lockd_runtime', process.env.RUNTIME_DB_PASSWORD],
      ['lockd_notifier', process.env.NOTIFIER_DB_PASSWORD],
    ]) {
      // ALTER ROLE takes no bind parameters; format() quotes the generated secret safely.
      const sql = (
        await c.query("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql", [
          role,
          secret,
        ])
      ).rows[0].sql as string;
      await c.query(sql);
    }
  } finally {
    await c.end();
  }
  await seedDemo(url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await stagingRelease();
  console.log('Staging release complete: migrations applied, roles configured, demo data seeded.');
}
