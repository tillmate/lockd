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
import type { Category, Socials } from '../src/lib/creatives.js';

// Synthetic, clearly labelled demo data for the staging site. Idempotent: re-running keeps
// existing rows, refreshes the demo logins (password and published authenticator), the demo
// creatives' public details and missing services, and puts the demo listings back on show, so
// every release starts from a presentable demo. Photos and ratings live in src/lib/demo.ts.
type Service = [name: string, description: string, priceJmd: number, hours: number];
type Creative = {
  slug: string;
  stageName: string;
  parish: string;
  category: Category;
  headline: string;
  bio: string;
  socials: Socials;
  services: Service[];
};
const ig = (h: string) => `https://www.instagram.com/${h}`;
const creatives: Creative[] = [
  {
    slug: 'jordan-p',
    stageName: 'Jordan P.',
    parish: 'Kingston',
    category: 'dj',
    headline: 'DJ & event curator',
    bio: 'Music for weddings, private celebrations and corporate events. Reggae, dancehall, soca, R&B and the classics, read from the room so the floor never empties. Demo profile.',
    socials: {
      instagram: ig('jordanp.demo'),
      tiktok: 'https://www.tiktok.com/@jordanp.demo',
      youtube: 'https://www.youtube.com/@jordanp.demo',
    },
    services: [
      [
        'Celebration set · 5 hours',
        'Ceremony music, reception set and MC announcements for weddings and milestone parties.',
        95000,
        5,
      ],
      [
        'Party & club performance · 3 hours',
        'High-energy dancehall, soca and afrobeats set for parties and club nights.',
        50000,
        3,
      ],
      [
        'Wedding & corporate DJ · 6 hours',
        'Full-day coverage with sound system, wireless mics and a planned run sheet.',
        120000,
        6,
      ],
    ],
  },
  {
    slug: 'selecta-marlon',
    stageName: 'Selecta Marlon',
    parish: 'St. Catherine',
    category: 'dj',
    headline: 'Dancehall & soca selector',
    bio: 'Sound-system selector from Spanish Town. Street dances, fetes, birthdays and uptown parties, with a crate that runs from foundation to the latest riddims. Demo profile.',
    socials: {
      instagram: ig('selectamarlon.demo'),
      youtube: 'https://www.youtube.com/@selectamarlon.demo',
    },
    services: [
      [
        'Party selection · 4 hours',
        'Dancehall, soca and hip-hop selection with hype MC for private parties.',
        45000,
        4,
      ],
      [
        'Street dance & fete · 6 hours',
        'Full sound and selection for outdoor events and fetes.',
        80000,
        6,
      ],
    ],
  },
  {
    slug: 'leah-m',
    stageName: 'Leah M.',
    parish: 'Kingston',
    category: 'live_music',
    headline: 'Wedding singer & live vocalist',
    bio: 'A beautiful voice for the moments that matter: ceremonies, first dances and intimate dinners. Gospel, soul, reggae and pop, with backing tracks or a live band. Demo profile.',
    socials: { instagram: ig('leahm.sings.demo'), youtube: 'https://www.youtube.com/@leahm.demo' },
    services: [
      [
        'Ceremony and reception · 3 hours',
        'Live vocals for the ceremony and an evening set.',
        70000,
        3,
      ],
      [
        'Wedding ceremony vocals · 1 hour',
        'Processional, signing and recessional songs, chosen with you.',
        35000,
        1,
      ],
      [
        'Reception performance · 2 hours',
        'Two live sets for dinner and the first dance.',
        55000,
        2,
      ],
    ],
  },
  {
    slug: 'shanice-w',
    stageName: 'Shanice W.',
    parish: 'St. Andrew',
    category: 'live_music',
    headline: 'Soul & reggae vocalist',
    bio: 'Warm, powerful vocals for brunches, launches and evening events. Lovers rock, neo-soul and reggae covers plus originals. Demo profile.',
    socials: { instagram: ig('shanicew.demo'), tiktok: 'https://www.tiktok.com/@shanicew.demo' },
    services: [
      ['Acoustic set · 2 hours', 'Vocals with guitar accompaniment for intimate events.', 60000, 2],
      ['Evening showcase · 3 hours', 'Full live set with backing tracks and sound.', 90000, 3],
    ],
  },
  {
    slug: 'rootical-vibes',
    stageName: 'Rootical Vibes Band',
    parish: 'Portland',
    category: 'live_music',
    headline: 'Five-piece reggae band',
    bio: 'Roots reggae, ska and rocksteady played live with drums, bass, keys, guitar and vocals. Hotels, festivals, weddings and private events island-wide. Demo profile.',
    socials: {
      instagram: ig('rooticalvibes.demo'),
      youtube: 'https://www.youtube.com/@rooticalvibes.demo',
      facebook: 'https://www.facebook.com/rooticalvibes.demo',
    },
    services: [
      ['Live band · 2 sets', 'Two 45-minute sets with the full five-piece band.', 150000, 3],
      [
        'Festival & headline set',
        'Headline performance with sound engineer, quoted per event.',
        250000,
        2,
      ],
    ],
  },
  {
    slug: 'tasha-k',
    stageName: 'Tasha K.',
    parish: 'Kingston',
    category: 'host',
    headline: 'Host & content creator',
    bio: 'Event host for brand launches, award shows and celebrations, who keeps the programme tight and the audience engaged, on stage and on socials. Demo profile.',
    socials: {
      instagram: ig('tashak.hosts.demo'),
      tiktok: 'https://www.tiktok.com/@tashak.demo',
      youtube: 'https://www.youtube.com/@tashak.demo',
    },
    services: [
      ['Event hosting · 4 hours', 'Hosting, crowd engagement and social content.', 65000, 4],
      [
        'Brand launch host · 3 hours',
        'Scripted programme, product moments and live social coverage.',
        85000,
        3,
      ],
    ],
  },
  {
    slug: 'nadine-r',
    stageName: 'Nadine R.',
    parish: 'St. Ann',
    category: 'host',
    headline: 'Wedding host & emcee',
    bio: 'North-coast wedding emcee who runs the reception with warmth and perfect timing, from grand entrance to last dance. Demo profile.',
    socials: {
      instagram: ig('nadiner.mc.demo'),
      facebook: 'https://www.facebook.com/nadiner.demo',
    },
    services: [
      ['Wedding reception MC · 5 hours', 'Run sheet, introductions, toasts and games.', 70000, 5],
      [
        'Private party host · 3 hours',
        'Birthdays and anniversaries with interactive segments.',
        45000,
        3,
      ],
    ],
  },
  {
    slug: 'damion-r',
    stageName: 'Damion R.',
    parish: 'St. James',
    category: 'host',
    headline: 'MC & hype man',
    bio: 'Montego Bay MC for parties, sports events and concerts. Big voice, bigger energy, always on cue with the DJ. Demo profile.',
    socials: { instagram: ig('damionr.mc.demo'), tiktok: 'https://www.tiktok.com/@damionr.demo' },
    services: [
      ['Party MC · 4 hours', 'Hype, shout-outs and crowd games alongside your DJ.', 40000, 4],
      ['Concert & sports MC', 'Stage hosting for concerts and sporting events.', 90000, 4],
    ],
  },
  {
    slug: 'andre-j',
    stageName: 'Andre J.',
    parish: 'St. James',
    category: 'comedian',
    headline: 'Comedian & host',
    bio: 'A quick wit and a warm presence. Stand-up and hosting that keep Montego Bay events moving and the room laughing, clean or late-night. Demo profile.',
    socials: {
      instagram: ig('andrej.comedy.demo'),
      youtube: 'https://www.youtube.com/@andrej.demo',
    },
    services: [
      ['Host and comedy set · 4 hours', 'Hosting the programme plus a stand-up set.', 60000, 4],
      ['Stand-up comedy set · 45 min', 'Clean or adult set tailored to your audience.', 40000, 1],
      ['Event MC and host · 5 hours', 'Full event hosting with comedy segments.', 75000, 5],
    ],
  },
  {
    slug: 'kerry-ann-b',
    stageName: 'Kerry-Ann B.',
    parish: 'Manchester',
    category: 'comedian',
    headline: 'Stand-up comedian',
    bio: 'Mandeville-born storyteller whose stand-up about family, church and taxis has sold out venues across the island. Corporate-friendly sets available. Demo profile.',
    socials: {
      instagram: ig('kerryannb.demo'),
      tiktok: 'https://www.tiktok.com/@kerryannb.demo',
      youtube: 'https://www.youtube.com/@kerryannb.demo',
    },
    services: [
      ['Stand-up set · 30 min', 'A tight set for parties, dinners and staff events.', 35000, 1],
      [
        'Corporate comedy & host · 3 hours',
        'Clean hosting and comedy for company functions.',
        80000,
        3,
      ],
    ],
  },
  {
    slug: 'simone-t',
    stageName: 'Simone T.',
    parish: 'Kingston',
    category: 'creator',
    headline: 'Content creator & brand storyteller',
    bio: 'Kingston lifestyle creator making launch videos, event recaps and product stories that feel real and travel far. Demo profile.',
    socials: {
      instagram: ig('simonet.creates.demo'),
      tiktok: 'https://www.tiktok.com/@simonet.demo',
      website: 'https://example.com/simone-t',
    },
    services: [
      ['Event coverage reel · 3 hours', 'On-site capture with a same-week edited reel.', 55000, 3],
      ['Brand content package', 'Three short-form videos with posting plan.', 90000, 4],
    ],
  },
  {
    slug: 'ayesha-g',
    stageName: 'Ayesha G.',
    parish: 'St. Andrew',
    category: 'creator',
    headline: 'Lifestyle creator & UGC',
    bio: 'Beauty, fashion and food content for Jamaican brands: UGC, reviews and launch-day live coverage. Demo profile.',
    socials: { instagram: ig('ayeshag.demo'), tiktok: 'https://www.tiktok.com/@ayeshag.demo' },
    services: [
      ['UGC video set', 'Two product videos with usage rights for 3 months.', 40000, 2],
      ['Launch live coverage · 2 hours', 'Stories and live posts from your launch.', 50000, 2],
    ],
  },
  {
    slug: 'orrin-p',
    stageName: 'Orrin P.',
    parish: 'Kingston',
    category: 'photo_film',
    headline: 'Event photographer',
    bio: 'Documentary-style photography for weddings, parties and corporate events, with edited galleries delivered within a week. Demo profile.',
    socials: { instagram: ig('orrinp.photo.demo'), website: 'https://example.com/orrin-p' },
    services: [
      [
        'Event photography · 4 hours',
        'Coverage with 200+ edited photos in an online gallery.',
        70000,
        4,
      ],
      [
        'Wedding day coverage · 8 hours',
        'Preparation to reception, with a second shooter.',
        180000,
        8,
      ],
    ],
  },
  {
    slug: 'javaughn-l',
    stageName: 'Javaughn L.',
    parish: 'Clarendon',
    category: 'photo_film',
    headline: 'Videographer & editor',
    bio: 'Cinematic event films and music videos, shot on gimbal and drone, edited with sound design. Demo profile.',
    socials: {
      instagram: ig('javaughnl.films.demo'),
      youtube: 'https://www.youtube.com/@javaughnl.demo',
    },
    services: [
      [
        'Event highlight film · 5 hours',
        'A 3–5 minute highlight film plus social cut-downs.',
        110000,
        5,
      ],
      ['Music video shoot · 1 day', 'Concept, shoot and edit for one track.', 200000, 8],
    ],
  },
];
const demoDj: Creative = {
  slug: 'demo-your-business',
  stageName: 'DEMO · Your DJ Business',
  parish: 'St. Andrew',
  category: 'dj',
  headline: 'Demo DJ login',
  bio: 'The demo DJ login. Sign in to see the DJ workspace: bookings, payment review, profile and subscription. Synthetic data only.',
  socials: {},
  services: [
    [
      'Signature set · 4 hours',
      'Synthetic demo package for trying the full booking flow.',
      55000,
      4,
    ],
  ],
};
const instructions =
  'DEMO ONLY — synthetic demo creative. Do not send money. No bank details exist on the staging site.';
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
async function account(c: pg.Client, userId: string, d: Creative, refreshProfile: boolean) {
  let id = (await c.query('SELECT id FROM lockd.accounts WHERE user_id=$1', [userId])).rows[0]?.id;
  if (!id)
    id = (
      await c.query(
        `INSERT INTO lockd.accounts(user_id,slug,stage_name,parish,bio,published,deposit_instructions,agreement_template,listing_state)
         VALUES($1,$2,$3,$4,$5,true,$6,$7,'approved') RETURNING id`,
        [userId, d.slug, d.stageName, d.parish, d.bio, instructions, agreement],
      )
    ).rows[0].id;
  // The synthetic creatives' public details follow this file; the demo DJ login keeps whatever
  // reviewers edited in its settings, apart from its category.
  if (refreshProfile)
    await c.query(
      'UPDATE lockd.accounts SET stage_name=$2,parish=$3,bio=$4,headline=$5,socials=$6,category=$7 WHERE id=$1',
      [id, d.stageName, d.parish, d.bio, d.headline, d.socials, d.category],
    );
  else await c.query('UPDATE lockd.accounts SET category=$2 WHERE id=$1', [id, d.category]);
  for (const [name, description, jmd, hours] of d.services)
    await c.query(
      `INSERT INTO lockd.packages(account_id,name,description,price_minor,deposit_minor,duration_minutes,buffer_before,buffer_after)
       SELECT $1,$2,$3,$4,$5,$6,60,60 WHERE NOT EXISTS(SELECT 1 FROM lockd.packages WHERE account_id=$1 AND name=$2)`,
      [id, name, description, jmd * 100, jmd * 50, hours * 60],
    );
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
    for (const d of creatives)
      await account(
        c,
        await user(c, `${d.slug}@example.com`, randomBytes(24).toString('hex')),
        d,
        true,
      );
    await account(c, await user(c, process.env.DEMO_DJ_EMAIL || DEMO_DJ_EMAIL, dj), demoDj, false);
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
      [[...creatives.map((d) => d.slug), demoDj.slug]],
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
