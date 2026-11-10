import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { passwordHash } from '../src/lib/auth.js';
import { base32, encryptSecret } from '../src/lib/mfa.js';

// Synthetic, clearly labelled demo data for the staging site. Idempotent: re-running keeps
// existing rows and only refreshes the two demo logins' passwords from their secrets.
const djs = [
  {
    slug: 'demo-selecta-ruby',
    stageName: 'DEMO · Selecta Ruby',
    parish: 'Kingston',
    bio: 'Synthetic demo DJ. Weddings and corporate events with a mix of dancehall, reggae and soca classics. Not a real listing.',
    packageName: 'Wedding reception · 5 hours',
    description: 'Synthetic demo package: ceremony music, reception set and MC announcements.',
    price: 9500000,
    deposit: 4750000,
    minutes: 300,
  },
  {
    slug: 'demo-dj-blaze',
    stageName: 'DEMO · DJ Blaze',
    parish: 'St. James',
    bio: 'Synthetic demo DJ. Beach parties and birthdays in Montego Bay. Not a real listing.',
    packageName: 'Party set · 4 hours',
    description: 'Synthetic demo package: four-hour party set with sound system.',
    price: 6000000,
    deposit: 3000000,
    minutes: 240,
  },
  {
    slug: 'demo-island-vibes',
    stageName: 'DEMO · Island Vibes Sound',
    parish: 'St. Ann',
    bio: 'Synthetic demo sound system for community events and fundraisers. Not a real listing.',
    packageName: 'Community event · 6 hours',
    description: 'Synthetic demo package: six hours with two selectors.',
    price: 12000000,
    deposit: 6000000,
    minutes: 360,
  },
];
const instructions =
  'DEMO ONLY — synthetic demo DJ. Do not send money. No bank details exist on the staging site.';
const agreement =
  'DEMO AGREEMENT — staging demonstration only. Not a real event, not legally binding, and no payment is requested.';
async function user(c: pg.Client, email: string, password: string) {
  return (
    await c.query(
      `INSERT INTO lockd.users(email,password_hash,verified_at) VALUES($1,$2,now())
       ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,verified_at=coalesce(lockd.users.verified_at,now())
       RETURNING id`,
      [email.toLowerCase(), await passwordHash(password)],
    )
  ).rows[0].id as string;
}
async function account(c: pg.Client, userId: string, d: (typeof djs)[number]) {
  let id = (await c.query('SELECT id FROM lockd.accounts WHERE user_id=$1', [userId])).rows[0]?.id;
  if (!id) {
    id = (
      await c.query(
        `INSERT INTO lockd.accounts(user_id,slug,stage_name,parish,bio,published,deposit_instructions,agreement_template,listing_state)
         VALUES($1,$2,$3,$4,$5,true,$6,$7,'approved') RETURNING id`,
        [userId, d.slug, d.stageName, d.parish, d.bio, instructions, agreement],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO lockd.packages(account_id,name,description,price_minor,deposit_minor,duration_minutes,buffer_before,buffer_after)
       VALUES($1,$2,$3,$4,$5,$6,60,60)`,
      [id, d.packageName, d.description, d.price, d.deposit, d.minutes],
    );
  }
  return id as string;
}
export async function seedDemo(url: string) {
  const dj = process.env.DEMO_DJ_PASSWORD,
    staff = process.env.DEMO_STAFF_PASSWORD;
  if (!dj || dj.length < 12 || !staff || staff.length < 12)
    throw new Error('DEMO_DJ_PASSWORD and DEMO_STAFF_PASSWORD (12+ characters) are required');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const d of djs)
      await account(c, await user(c, `${d.slug}@example.com`, randomBytes(24).toString('hex')), d);
    await account(c, await user(c, process.env.DEMO_DJ_EMAIL || 'demo.dj@example.com', dj), {
      slug: 'demo-your-business',
      stageName: 'DEMO · Your DJ Business',
      parish: 'St. Andrew',
      bio: 'The demo DJ login. Sign in to see the DJ workspace: bookings, payment review, profile and subscription. Synthetic data only.',
      packageName: 'Signature set · 4 hours',
      description: 'Synthetic demo package for trying the full booking flow.',
      price: 5500000,
      deposit: 2750000,
      minutes: 240,
    });
    const staffId = await user(c, process.env.DEMO_STAFF_EMAIL || 'demo.staff@example.com', staff);
    // The authenticator secret is created once; staging:enroll-staff shows it in the operator shell.
    await c.query(
      `INSERT INTO lockd.billing_staff_members(user_id,secret_cipher,provision_reason) VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO NOTHING`,
      [staffId, encryptSecret(base32(randomBytes(20))), 'Staging demo staff account (synthetic)'],
    );
    for (const scope of ['billing', 'listings', 'support', 'notifications', 'admin'])
      await c.query(
        `INSERT INTO lockd.staff_scopes(user_id,scope,reason) VALUES($1,$2,'Staging demo staff account (synthetic)')
         ON CONFLICT DO NOTHING`,
        [staffId, scope],
      );
    // Synthetic collection instructions with no bank details, so the subscription flow can be tried.
    await c.query(
      `UPDATE lockd.billing_settings SET enabled=true,business_name='Lockd — STAGING DEMO',
       instructions='DEMO ONLY — no bank details are configured. Do not send money. Upload any synthetic image to try the review flow.',
       verified_by='Staging demo adapter; no actual bank verification'
       WHERE singleton AND (NOT enabled OR instructions LIKE 'DEMO ONLY%')`,
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
