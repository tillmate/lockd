import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ensureLocalMFAKey } from './local-billing.js';
const valid = ['listings', 'support', 'notifications', 'admin'];
// Grants operational scopes to an already enrolled synthetic staff member (npm run billing:local).
// Production staff provisioning needs a separately reviewed process.
export async function grantLocalScopes(email: string, scopes: string[]) {
  ensureLocalMFAKey();
  if (!email.endsWith('@example.test'))
    throw new Error('Local staff setup requires a synthetic example.test account');
  if (!scopes.length || scopes.some((s) => !valid.includes(s)))
    throw new Error(`Choose scopes from: ${valid.join(', ')}`);
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const user = (
      await c.query(
        'SELECT m.user_id AS id FROM lockd.billing_staff_members m JOIN lockd.users u ON u.id=m.user_id WHERE u.email=$1 AND m.enabled',
        [email.toLowerCase()],
      )
    ).rows[0];
    if (!user)
      throw new Error('Enroll the synthetic staff member with npm run billing:local first');
    for (const scope of scopes) {
      await c.query(
        'INSERT INTO lockd.staff_scopes(user_id,scope,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [user.id, scope, 'Explicit local synthetic staff provisioning'],
      );
      await c.query(
        "INSERT INTO lockd.staff_events(actor_id,scope,kind,subject_id,reason_code,note) VALUES($1::uuid,'admin','LOCAL_SCOPE_PROVISIONED',$1::text,$2,'Local synthetic provisioning script; not a production grant')",
        [user.id, scope],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [email, ...scopes] = process.argv.slice(2);
  if (!email)
    throw new Error('Usage: npm run staff:local -- staff@example.test listings notifications');
  await grantLocalScopes(email, scopes);
  console.log(`Granted ${scopes.join(', ')} to ${email} (local synthetic staff only).`);
}
