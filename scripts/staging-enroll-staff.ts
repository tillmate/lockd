import pg from 'pg';
import { decryptSecret } from '../src/lib/mfa.js';

// Run from the hosting provider's interactive shell (never a build or deploy log): prints the demo
// staff authenticator enrollment so the operator can add it to an authenticator app.
if (process.env.LOCKD_ENV !== 'staging')
  throw new Error('staging:enroll-staff only runs with LOCKD_ENV=staging');
const email = (process.env.DEMO_STAFF_EMAIL || 'demo.staff@example.com').toLowerCase();
const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await c.connect();
try {
  const row = (
    await c.query(
      'SELECT m.secret_cipher FROM lockd.billing_staff_members m JOIN lockd.users u ON u.id=m.user_id WHERE u.email=$1',
      [email],
    )
  ).rows[0];
  if (!row) throw new Error('Demo staff account not found; run a deploy first');
  const secret = decryptSecret(row.secret_cipher);
  console.log(`Demo staff authenticator for ${email} (keep private):`);
  console.log(`Secret: ${secret}`);
  console.log(
    `otpauth://totp/Lockd%20Staging:${encodeURIComponent(email)}?secret=${secret}&issuer=Lockd%20Staging&algorithm=SHA1&digits=6&period=30`,
  );
} finally {
  await c.end();
}
