import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { base32, encryptSecret } from '../src/lib/mfa.js';
export function ensureLocalMFAKey() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* CI */
  }
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? 'http://invalid');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.LOCKD_LOCAL_ONLY !== '1')
    throw new Error('Staff setup is restricted to explicit local development');
  if (!process.env.STAFF_MFA_KEY) {
    const key = randomBytes(32).toString('hex');
    process.env.STAFF_MFA_KEY = key;
    appendFileSync('.env.local', `\nSTAFF_MFA_KEY=${key}\n`, { mode: 0o600 });
  }
}
export async function provisionLocalBilling(email: string) {
  ensureLocalMFAKey();
  if (!email.endsWith('@example.test'))
    throw new Error('Local billing setup requires a synthetic example.test account');
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const user = (
      await c.query('SELECT id FROM lockd.users WHERE email=$1 AND verified_at IS NOT NULL', [
        email.toLowerCase(),
      ])
    ).rows[0];
    if (!user) throw new Error('Register and verify the synthetic staff account first');
    const cfg = (await c.query('SELECT * FROM lockd.billing_settings WHERE singleton FOR UPDATE'))
      .rows[0];
    if (cfg.enabled && !cfg.instructions.startsWith('TEST ONLY'))
      throw new Error('Refusing to replace non-test billing configuration');
    const secret = base32(randomBytes(20));
    await c.query(
      'INSERT INTO lockd.billing_staff_members(user_id,secret_cipher,provision_reason) VALUES($1,$2,$3)',
      [user.id, encryptSecret(secret), 'Explicit local synthetic billing reviewer provisioning'],
    );
    await c.query(
      "INSERT INTO lockd.staff_scopes(user_id,scope,reason) VALUES($1,'billing','Explicit local synthetic billing reviewer provisioning')",
      [user.id],
    );
    await c.query(
      "UPDATE lockd.billing_settings SET enabled=true,business_name='Lockd — SYNTHETIC TEST',instructions='TEST ONLY — no bank details configured. Do not send funds. Synthetic invoice and reconciliation testing only.',verified_by='Local test adapter; no actual bank verification claimed' WHERE singleton",
    );
    await c.query(
      "INSERT INTO lockd.billing_events(actor_id,kind,reason) VALUES($1,'LOCAL_BILLING_STAFF_PROVISIONED','Synthetic reviewer and test collection adapter; no real bank enabled')",
      [user.id],
    );
    await c.query('COMMIT');
    return { id: user.id as string, secret };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: npm run billing:local -- reviewer@example.test');
  const member = await provisionLocalBilling(email);
  mkdirSync('.local', { recursive: true });
  const target = `.local/staff-enrollment-${member.id}.txt`;
  if (existsSync(target)) throw new Error('Enrollment file already exists');
  writeFileSync(
    target,
    `LOCAL TEST AUTHENTICATOR — keep private\n${email}\n${member.secret}\notpauth://totp/Lockd:${encodeURIComponent(email)}?secret=${member.secret}&issuer=Lockd&algorithm=SHA1&digits=6&period=30\n`,
    { mode: 0o600 },
  );
  console.log(
    `Synthetic billing reviewer provisioned. Private enrollment saved to ${target}. Open /staff/billing after signing in. No live account configured.`,
  );
}
