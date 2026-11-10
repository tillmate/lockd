import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { migrate } from './migrate.js';

mkdirSync('.local', { recursive: true });
const secretFile = '.local/database-passwords.json';
const secrets: {
  admin: string;
  runtime: string;
  notifier?: string;
  mfa?: string;
  notify?: string;
} = existsSync(secretFile)
  ? JSON.parse(readFileSync(secretFile, 'utf8'))
  : { admin: randomBytes(24).toString('hex'), runtime: randomBytes(24).toString('hex') };
// Preserve existing keys when the database supervisor regenerates .env.local.
try {
  process.loadEnvFile('.env.local');
} catch {
  /* First setup */
}
secrets.mfa = process.env.STAFF_MFA_KEY ?? secrets.mfa ?? randomBytes(32).toString('hex');
secrets.notify = process.env.NOTIFICATION_KEY ?? secrets.notify ?? randomBytes(32).toString('hex');
secrets.notifier ??= randomBytes(24).toString('hex');
writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600 });
const databaseDir = resolve('.local/postgres');
const db = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: secrets.admin,
  port: 55432,
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: () => {},
});
if (!existsSync(resolve(databaseDir, 'PG_VERSION'))) await db.initialise();
await db.start();
const admin = new pg.Client({
  connectionString: `postgresql://postgres:${secrets.admin}@127.0.0.1:55432/postgres`,
});
await admin.connect();
if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='lockd'")).rowCount)
  await admin.query('CREATE DATABASE lockd');
await admin.end();
const adminUrl = `postgresql://postgres:${secrets.admin}@127.0.0.1:55432/lockd`;
await migrate(adminUrl);
const c = new pg.Client({ connectionString: adminUrl });
await c.connect();
// Password is generated hex, not supplied input; ALTER ROLE does not accept bind parameters.
await c.query(`ALTER ROLE lockd_runtime PASSWORD '${secrets.runtime}'`);
await c.query(`ALTER ROLE lockd_notifier PASSWORD '${secrets.notifier}'`);
await c.end();
// EMAIL_PROVIDER=local writes rendered messages to the ignored test mailbox; nothing is sent.
writeFileSync(
  '.env.local',
  [
    `DATABASE_URL=postgresql://lockd_runtime:${secrets.runtime}@127.0.0.1:55432/lockd`,
    `MIGRATION_DATABASE_URL=${adminUrl}`,
    `NOTIFIER_DATABASE_URL=postgresql://lockd_notifier:${secrets.notifier}@127.0.0.1:55432/lockd`,
    'APP_ORIGIN=http://127.0.0.1:3100',
    'LOCKD_LOCAL_ONLY=1',
    `STAFF_MFA_KEY=${secrets.mfa}`,
    `NOTIFICATION_KEY=${secrets.notify}`,
    'EMAIL_PROVIDER=local',
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(
  'Local PostgreSQL ready on 127.0.0.1:55432. Settings saved in ignored .env.local. Email goes to the local test mailbox only.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void db.stop().then(() => process.exit(0));
  });
setInterval(() => {}, 60_000);
