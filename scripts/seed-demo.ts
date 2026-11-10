import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { passwordHash } from '../src/lib/auth.js';
import { encryptSecret } from '../src/lib/mfa.js';
import {
  DEMO_DJ_EMAIL,
  DEMO_STAFF_EMAIL,
  PUBLIC_DEMO_STAFF_TOTP,
  pgConfig,
} from '../src/lib/env.js';

// Synthetic, clearly labelled demo data for the staging site. Idempotent: re-running keeps
// existing rows, refreshes the demo logins (password and published authenticator) and puts the
// demo listings back on show, so every release starts from a presentable demo.
const djs = [
  {
    slug: 'jordan-p',
    stageName: 'Jordan P.',
    parish: 'Kingston',
    bio: 'Demo profile. DJ and event curator for weddings, launches and private parties: reggae, dancehall, soca and classics.',
    packageName: 'Celebration set · 5 hours',
    description: 'Demo package: ceremony music, reception set and MC announcements.',
    price: 9500000,
    deposit: 4750000,
    minutes: 300,
  },
  {
    slug: 'leah-m',
    stageName: 'Leah M.',
    parish: 'Kingston',
    bio: 'Demo profile. Wedding singer for ceremonies and receptions, from first dance to last song.',
    packageName: 'Ceremony and reception · 3 hours',
    description: 'Demo package: live vocals for the ceremony and an evening set.',
    price: 7000000,
    deposit: 3500000,
    minutes: 180,
  },
  {
    slug: 'andre-j',
    stageName: 'Andre J.',
    parish: 'St. James',
    bio: 'Demo profile. Comedian and host who keeps Montego Bay events moving and the room laughing.',
    packageName: 'Host and comedy set · 4 hours',
    description: 'Demo package: hosting the programme plus a stand-up set.',
    price: 6000000,
    deposit: 3000000,
    minutes: 240,
  },
  {
    slug: 'tasha-k',
    stageName: 'Tasha K.',
    parish: 'Kingston',
    bio: 'Demo profile. Event host and content creator for brand launches and celebrations.',
    packageName: 'Event hosting · 4 hours',
    description: 'Demo package: hosting, crowd engagement and social content.',
    price: 6500000,
    deposit: 3250000,
    minutes: 240,
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
  const c = new pg.Client(pgConfig(url));
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const d of djs)
      await account(c, await user(c, `${d.slug}@example.com`, randomBytes(24).toString('hex')), d);
    await account(c, await user(c, process.env.DEMO_DJ_EMAIL || DEMO_DJ_EMAIL, dj), {
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
    const staffId = await user(c, process.env.DEMO_STAFF_EMAIL || DEMO_STAFF_EMAIL, staff);
    // The demo Super Admin uses the published authenticator secret; the staging unlock screen shows
    // its current code. Replay protection (last used code) is kept.
    await c.query(
      `INSERT INTO lockd.billing_staff_members(user_id,secret_cipher,provision_reason) VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET secret_cipher=excluded.secret_cipher`,
      [staffId, encryptSecret(PUBLIC_DEMO_STAFF_TOTP), 'Staging demo staff account (synthetic)'],
    );
    // Anyone can try the demo staff tools, so restricted or unpublished demo listings are put back.
    await c.query(
      `UPDATE lockd.accounts SET published=true,listing_state='approved'
       WHERE slug=ANY($1::text[]) AND (NOT published OR listing_state<>'approved')`,
      [[...djs.map((d) => d.slug), 'demo-your-business']],
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
