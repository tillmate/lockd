import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { migrate } from '../scripts/migrate';
import { transaction, hash, closeDatabase } from '../src/lib/db';
import {
  newToken,
  passwordHash,
  login,
  verifyEmail,
  resetPassword,
  register,
  requestReset,
} from '../src/lib/auth';
import * as s from '../src/lib/service';
import * as billing from '../src/lib/billing';
import * as ops from '../src/lib/ops';
import * as support from '../src/lib/support';
import { base32, encryptSecret, totp, verifyTotp } from '../src/lib/mfa';
import { moneyToMinor } from '../src/lib/validation';
import { dispatch } from '../src/lib/notify/dispatcher';
import { attachSecret } from '../src/lib/notify/secret';
import { render, toEmail } from '../src/lib/notify/templates';
import {
  deliveryConfig,
  resendTransport,
  type Outgoing,
  type SendResult,
  type Transport,
} from '../src/lib/notify/transport';
let admin: pg.Client, control: pg.Client, notifier: pg.Pool;
let testName: string;
let runtimeBase: string;
let notifierUrl: string;
beforeAll(async () => {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* CI */
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Run npm run db:local before tests');
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname))
    throw new Error('Tests refuse remote databases');
  runtimeBase = process.env.DATABASE_URL!;
  testName = `lockd_test_${randomUUID().replaceAll('-', '')}`;
  parsed.pathname = '/postgres';
  control = new pg.Client({ connectionString: parsed.toString() });
  await control.connect();
  await control.query(`CREATE DATABASE ${testName}`);
  parsed.pathname = `/${testName}`;
  await migrate(parsed.toString());
  admin = new pg.Client({ connectionString: parsed.toString() });
  await admin.connect();
  const runtime = new URL(runtimeBase);
  runtime.pathname = `/${testName}`;
  process.env.DATABASE_URL = runtime.toString();
  process.env.LOCKD_LOCAL_ONLY = '0';
  process.env.STAFF_MFA_KEY ??= randomBytes(32).toString('hex');
  process.env.NOTIFICATION_KEY ??= randomBytes(32).toString('hex');
  if (!process.env.NOTIFIER_DATABASE_URL)
    throw new Error('NOTIFIER_DATABASE_URL is required; run npm run db:local');
  const delivery = new URL(process.env.NOTIFIER_DATABASE_URL);
  delivery.pathname = `/${testName}`;
  notifierUrl = delivery.toString();
  notifier = new pg.Pool({ connectionString: notifierUrl, max: 3 });
});
afterAll(async () => {
  await closeDatabase();
  await notifier?.end();
  await admin?.end();
  if (control) {
    await control.query(`DROP DATABASE ${testName} WITH (FORCE)`);
    await control.end();
  }
});
async function fixture() {
  const token = newToken(),
    email = `dj-${randomUUID()}@example.test`,
    p = await passwordHash('Testing-password-123!');
  await transaction({}, async (c) => {
    await c.query('SELECT lockd.register_user($1,$2,$3)', [email, p, hash(token)]);
  });
  expect(await verifyEmail(token)).toBe(true);
  const session = await login({ email, password: 'Testing-password-123!' });
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const account = await s.onboard(
    { session },
    {
      slug,
      stageName: 'Synthetic DJ',
      parish: 'Kingston',
      bio: 'Synthetic local test DJ profile.',
      depositInstructions: 'TEST ONLY. Do not send funds. Synthetic instructions.',
      agreement: 'TEST AGREEMENT. Synthetic booking only. No payment requested.',
      packageName: 'Four hour set',
      description: 'Synthetic DJ package for automated tests.',
      priceMinor: 5500000,
      depositMinor: 2750000,
      durationMinutes: 240,
      bufferBefore: 60,
      bufferAfter: 60,
    },
  );
  const [profile] = await s.profiles(slug);
  return { session, email, account, profile };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, day = 30) {
  return {
    creatorId: f.account,
    packageId: f.profile.packages[0].id,
    requestId: randomUUID(),
    accessToken: newToken(),
    startsAt: new Date(Date.now() + day * 86400000).toISOString(),
    clientName: 'Synthetic Client',
    clientEmail: 'client@example.test',
    venue: 'Synthetic Kingston venue',
  };
}
async function held(f: Fixture, day = 30) {
  const d = input(f, day);
  const id = await s.createHold(d);
  return { id, guest: d.accessToken, ctx: { guest: d.accessToken }, input: d };
}
async function signed(f: Fixture, day = 30) {
  const h = await held(f, day);
  const b = (await s.booking(h.ctx, h.id))!;
  await s.sign(h.ctx, h.id, {
    agreementId: b.agreement.id,
    contentHash: b.agreement.content_hash,
    signer: 'Synthetic Client',
    accept: true,
  });
  return h;
}
async function png() {
  return sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: {
        r: Math.floor(Math.random() * 255),
        g: Math.floor(Math.random() * 255),
        b: Math.floor(Math.random() * 255),
      },
    },
  })
    .png()
    .toBuffer();
}
async function claimed(f: Fixture) {
  const h = await signed(f);
  const bytes = await png();
  const claim = await s.proof(h.ctx, h.id, 'TEST-CLAIM', 2750000, bytes);
  return { ...h, claim, bytes };
}
const decision = (claimId: string, amountMinor = 2750000) => ({
  claimId,
  decision: 'received',
  amountMinor,
  bankReference: `TEST-${randomUUID()}`,
  reason: 'Synthetic attestation in isolated automated test',
  attest: true,
});
async function confirmedFixture() {
  const f = await fixture(),
    h = await claimed(f);
  await s.verify({ session: f.session }, h.id, decision(h.claim));
  return { f, h };
}
async function propose(f: Fixture, h: Awaited<ReturnType<typeof held>>, days = 40) {
  return s.proposeChange(h.ctx, h.id, {
    party: 'client',
    startsAt: input(f, days).startsAt,
    reason: 'Synthetic change request',
  });
}
async function acceptChange(
  ctx: Parameters<typeof s.respondChange>[0],
  h: Awaited<ReturnType<typeof held>>,
  mid: string,
  party: 'dj' | 'client',
) {
  const b = (await s.booking(ctx, h.id))!,
    m = b.amendments.find((m) => m.id === mid)!,
    a = b.agreements.find((a) => a.id === m.agreement_id)!;
  return s.respondChange(ctx, h.id, {
    amendmentId: mid,
    party,
    action: 'accept',
    contentHash: a.content_hash,
    signer: party === 'client' ? 'Synthetic Client' : 'Synthetic DJ',
    accept: true,
  });
}
const cancelDecision = (requestId: string | null, refundMinor = 1375000) => ({
  requestId,
  approve: true,
  refundMinor,
  reason: 'Synthetic cancellation review',
  basis: 'Synthetic agreed refund basis for automated test only.',
  attest: true,
});
async function expiry(id: string, remainingSeconds: number, grace = false) {
  await admin.query(
    "UPDATE lockd.bookings SET created_at=now()+make_interval(secs=>$2)-interval '48 hours',original_expires_at=now()+make_interval(secs=>$2),expires_at=now()+make_interval(secs=>$2)+CASE WHEN $3 THEN interval '24 hours' ELSE interval '0 hours' END,grace_used=$3 WHERE id=$1",
    [id, remainingSeconds, grace],
  );
}
async function reviewer({ billing: billingScope = true } = {}) {
  const f = await fixture(),
    secret = base32(randomBytes(20));
  const uid = (await admin.query('SELECT user_id FROM lockd.accounts WHERE id=$1', [f.account]))
    .rows[0].user_id;
  await admin.query(
    'INSERT INTO lockd.billing_staff_members(user_id,secret_cipher,provision_reason) VALUES($1,$2,$3)',
    [uid, encryptSecret(secret), 'Synthetic billing reviewer for isolated tests'],
  );
  if (billingScope)
    await admin.query(
      "INSERT INTO lockd.staff_scopes(user_id,scope,reason) VALUES($1,'billing','Synthetic billing scope for isolated tests')",
      [uid],
    );
  const code = totp(secret);
  await billing.stepUp({ session: f.session }, { code });
  return { ...f, secret, code, uid, ctx: { session: f.session } };
}
async function enableBilling() {
  await admin.query(
    "UPDATE lockd.billing_settings SET enabled=true,business_name='SYNTHETIC LOCKD',instructions='TEST ONLY — do not send real funds.',verified_by='Synthetic local test fixture' WHERE singleton",
  );
}
async function invoiceFixture(plan = 'monthly') {
  await enableBilling();
  const dj = await fixture(),
    staff = await reviewer();
  if (plan === 'founding')
    await billing.approve(staff.ctx, {
      accountId: dj.account,
      reason: 'Synthetic Jamaican DJ eligibility reviewed',
      attest: true,
    });
  const ctx = { session: dj.session },
    id = await billing.issue(ctx, {
      plan,
      billingName: 'Synthetic Billing DJ',
      billingEmail: dj.email,
      requestId: randomUUID(),
    });
  const amount = plan === 'monthly' ? 350000 : plan === 'annual' ? 3600000 : 2500000;
  const claim = await billing.upload(ctx, id, 'SYNTHETIC-INVOICE', amount, await png());
  return { dj, staff, ctx, id, claim, amount };
}
const invoiceDecision = (claimId: string, amountMinor = 350000) => ({
  claimId,
  decision: 'received',
  amountMinor,
  bankReference: `SYNTHETIC-BANK-${randomUUID()}`,
  receivedAt: new Date().toISOString(),
  reason: 'Synthetic actual bank receipt verification',
  attest: true,
});
async function moveSubscriptionEnd(account: string, daysFromNow: number) {
  await admin.query(
    "UPDATE lockd.subscriptions SET starts_at=now()+make_interval(days=>$2)-interval '1 year',ends_at=now()+make_interval(days=>$2) WHERE account_id=$1",
    [account, daysFromNow],
  );
}

describe('PostgreSQL booking slice', () => {
  it('registers, verifies contact, onboards and publishes only public profile fields', async () => {
    const f = await fixture();
    const [p] = await s.profiles(f.profile.slug);
    expect(p.id).toBe(f.account);
    expect(JSON.stringify(p)).not.toMatch(
      /password|deposit_instructions|agreement_template|client_email/,
    );
    expect(p.packages[0].priceMinor).toBe(5500000);
  });
  it('cannot log in before verification; verification token is single use', async () => {
    const token = newToken(),
      email = `unverified-${randomUUID()}@example.test`;
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.register_user($1,$2,$3)', [
        email,
        await passwordHash('Testing-password-123!'),
        hash(token),
      ]);
    });
    await expect(login({ email, password: 'Testing-password-123!' })).rejects.toThrow(/verify/);
    expect(await verifyEmail(token)).toBe(true);
    expect(await verifyEmail(token)).toBe(false);
  });
  it('completes real persistence from onboarding through signed agreement, evidence and DJ verification', async () => {
    const f = await fixture(),
      h = await claimed(f);
    let b = (await s.booking(h.ctx, h.id))!;
    expect(b.status).toBe('VERIFICATION_PENDING');
    expect(b.verified_minor).toBe(0);
    expect(b.grace_used).toBe(true);
    const v = decision(h.claim);
    expect(await s.verify({ session: f.session }, h.id, v)).toBe('CONFIRMED_LOCKD');
    expect(await s.verify({ session: f.session }, h.id, v)).toBe('CONFIRMED_LOCKD');
    b = (await s.booking(h.ctx, h.id))!;
    expect(b.verified_minor).toBe(2750000);
    expect(b.agreement.signer).toBe('Synthetic Client');
    expect(b.events.filter((e) => e.kind === 'CONFIRMED_LOCKD')).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM lockd.outbox WHERE kind='confirmed_lockd' AND payload->>'bookingId'=$1",
          [h.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('uses independent PostgreSQL connections: at most one concurrent overlapping hold', async () => {
    const f = await fixture(),
      a = input(f),
      b = { ...input(f), startsAt: a.startsAt };
    const r = await Promise.allSettled([s.createHold(a), s.createHold(b)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });
  it('enforces the three-active Free cap under six concurrent non-overlapping requests', async () => {
    const f = await fixture();
    const r = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => s.createHold(input(f, 40 + i))),
    );
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
  });
  it('covers cross-service buffer collisions, overnight events, and blocked dates', async () => {
    const f = await fixture();
    const package2 = (
      await admin.query(
        "INSERT INTO lockd.packages(account_id,name,description,price_minor,deposit_minor,duration_minutes,buffer_before,buffer_after) VALUES($1,'Second service','A second package',10000,5000,120,30,30) RETURNING id",
        [f.account],
      )
    ).rows[0].id;
    const d = input(f);
    d.startsAt = '2028-01-05T23:00:00-05:00';
    await s.createHold(d);
    await expect(
      s.createHold({ ...input(f), packageId: package2, startsAt: '2028-01-06T03:30:00-05:00' }),
    ).rejects.toMatchObject({ code: '23P01' });
    await s.block(
      { session: f.session },
      {
        startsAt: '2028-01-10T10:00:00-05:00',
        endsAt: '2028-01-10T23:00:00-05:00',
        reason: 'Other commitment',
      },
    );
    await expect(
      s.createHold({ ...input(f), startsAt: '2028-01-10T12:00:00-05:00' }),
    ).rejects.toMatchObject({ code: '23P01' });
  });
  it('grants one grace at 47:59 and repeated evidence never extends it', async () => {
    const f = await fixture(),
      h = await signed(f);
    await expiry(h.id, 60);
    await s.proof(h.ctx, h.id, 'REF-1', 10000, await png());
    const b = (await s.booking(h.ctx, h.id))!;
    expect(new Date(b.expires_at).getTime() - new Date(b.original_expires_at).getTime()).toBe(
      86400000,
    );
    await s.proof(h.ctx, h.id, 'REF-2', 10000, await png());
    expect((await s.booking(h.ctx, h.id))!.expires_at).toEqual(b.expires_at);
  });
  it('proof at 48:01 preserves the claim without reactivating the released slot', async () => {
    const f = await fixture(),
      h = await signed(f);
    await expiry(h.id, -60);
    await s.proof(h.ctx, h.id, 'LATE', 2750000, await png());
    const b = (await s.booking(h.ctx, h.id))!;
    expect(b.status).toBe('HOLD_EXPIRED');
    expect(b.grace_used).toBe(false);
    expect(b.claims[0].on_time).toBe(false);
    expect(
      (await admin.query('SELECT 1 FROM lockd.occupied_slots WHERE booking_id=$1', [h.id]))
        .rowCount,
    ).toBe(0);
  });
  it('releases grace-expired slots and late funds never override a replacement hold', async () => {
    const f = await fixture(),
      h = await claimed(f);
    await expiry(h.id, -86401, true);
    await s.expire();
    const replacement = await s.createHold({ ...input(f), startsAt: h.input.startsAt });
    expect(await s.verify({ session: f.session }, h.id, decision(h.claim))).toBe('HOLD_EXPIRED');
    expect(
      (
        await admin.query('SELECT booking_id FROM lockd.occupied_slots WHERE account_id=$1', [
          f.account,
        ])
      ).rows,
    ).toEqual([{ booking_id: replacement }]);
    expect(
      (await s.booking(h.ctx, h.id))!.events.some(
        (e) => e.kind === 'LATE_PAYMENT_REQUIRES_RESOLUTION',
      ),
    ).toBe(true);
  });
  it('requires the owning DJ and actual-funds attestation, not evidence or a client token', async () => {
    const f = await fixture(),
      other = await fixture(),
      h = await claimed(f);
    await expect(
      s.verify({ session: other.session }, h.id, decision(h.claim)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(s.verify(h.ctx, h.id, decision(h.claim))).rejects.toMatchObject({ code: '42501' });
    await expect(
      s.verify({ session: f.session }, h.id, { ...decision(h.claim), attest: false }),
    ).rejects.toThrow();
    expect((await s.booking(h.ctx, h.id))!.status).toBe('VERIFICATION_PENDING');
  });
  it('isolates private bookings, proofs, agreements and audits with RLS', async () => {
    const f = await fixture(),
      other = await fixture(),
      h = await claimed(f);
    for (const ctx of [{}, { session: other.session }, { guest: newToken() }]) {
      expect(await s.booking(ctx, h.id)).toBeNull();
      expect(await s.receipt(ctx, h.claim)).toBeUndefined();
      for (const table of ['agreements', 'signatures', 'claims', 'verifications', 'booking_events'])
        expect(
          await transaction(
            ctx,
            async (c) =>
              (await c.query(`SELECT * FROM lockd.${table} WHERE booking_id=$1`, [h.id])).rowCount,
          ),
        ).toBe(0);
    }
    expect((await s.receipt({ session: f.session }, h.claim))!.image.length).toBeGreaterThan(20);
  });
  it('prevents a mismatched DJ/package, signature version, and claim/booking combination', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      s.createHold({ ...input(f), packageId: other.profile.packages[0].id }),
    ).rejects.toThrow(/Package/);
    const h = await held(f);
    await expect(
      s.sign(h.ctx, h.id, {
        agreementId: randomUUID(),
        contentHash: '0'.repeat(64),
        signer: 'Client Name',
        accept: true,
      }),
    ).rejects.toThrow(/version/);
    const c = await claimed(other);
    await expect(s.verify({ session: f.session }, h.id, decision(c.claim))).rejects.toThrow(
      /Claim/,
    );
  });
  it('records partial actual funds, then a separate top-up confirms without double counting', async () => {
    const f = await fixture(),
      h = await claimed(f);
    expect(await s.verify({ session: f.session }, h.id, decision(h.claim, 1000000))).toBe(
      'PARTIAL_VERIFIED',
    );
    const c2 = await s.proof(h.ctx, h.id, 'TOP-UP', 1750000, await png());
    expect(await s.verify({ session: f.session }, h.id, decision(c2, 1750000))).toBe(
      'CONFIRMED_LOCKD',
    );
    expect((await s.booking(h.ctx, h.id))!.verified_minor).toBe(2750000);
  });
  it('records rejected evidence without claiming funds and allows distinct replacement evidence', async () => {
    const f = await fixture(),
      h = await claimed(f);
    expect(
      await s.verify({ session: f.session }, h.id, {
        claimId: h.claim,
        decision: 'rejected',
        amountMinor: 0,
        bankReference: '',
        reason: 'Unreadable reference; supply a clearer receipt',
        attest: false,
      }),
    ).toBe('PROOF_REJECTED');
    await s.proof(h.ctx, h.id, 'REPLACEMENT', 2750000, await png());
    expect((await s.booking(h.ctx, h.id))!.status).toBe('VERIFICATION_PENDING');
  });
  it('deduplicates retries; prevents changed idempotency payloads and reused receipt images', async () => {
    const f = await fixture(),
      h = await claimed(f);
    expect(await s.createHold(h.input)).toBe(h.id);
    await expect(s.createHold({ ...h.input, venue: 'Different venue' })).rejects.toThrow(
      /Idempotency/,
    );
    expect(await s.proof(h.ctx, h.id, 'TEST-CLAIM', 2750000, h.bytes)).toBe(h.claim);
    const h2 = await signed(f, 40);
    await expect(s.proof(h2.ctx, h2.id, 'OTHER', 2750000, h.bytes)).rejects.toThrow(/Duplicate/);
  });
  it('rejects reuse of an actual bank receipt reference across claims', async () => {
    const f = await fixture(),
      h = await claimed(f),
      v = decision(h.claim, 1000000);
    await s.verify({ session: f.session }, h.id, v);
    const c2 = await s.proof(h.ctx, h.id, 'SECOND', 1750000, await png());
    await expect(
      s.verify({ session: f.session }, h.id, { ...v, claimId: c2, amountMinor: 1750000 }),
    ).rejects.toMatchObject({ code: '23505' });
    expect((await s.booking(h.ctx, h.id))!.verified_minor).toBe(1000000);
  });
  it('denies direct runtime writes and preserves immutable agreement/attestation history', async () => {
    const f = await fixture(),
      h = await claimed(f);
    await s.verify({ session: f.session }, h.id, decision(h.claim));
    await expect(
      transaction({ session: f.session }, async (c) => {
        await c.query("UPDATE lockd.bookings SET status='CONFIRMED_LOCKD' WHERE id=$1", [h.id]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin.query("UPDATE lockd.agreements SET body='tampered' WHERE booking_id=$1", [h.id]),
    ).rejects.toThrow(/Immutable/);
    await expect(
      admin.query('DELETE FROM lockd.verifications WHERE booking_id=$1', [h.id]),
    ).rejects.toThrow(/Immutable/);
    await expect(
      admin.query('DELETE FROM lockd.booking_events WHERE booking_id=$1', [h.id]),
    ).rejects.toThrow(/Immutable/);
  });
  it('database exclusion constraint rejects overlaps even when bypassing the service', async () => {
    const f = await fixture(),
      h = await held(f);
    await expect(
      admin.query(
        'INSERT INTO lockd.occupied_slots(account_id,slot,reason) SELECT account_id,slot,$2 FROM lockd.occupied_slots WHERE booking_id=$1',
        [h.id, 'Raw collision'],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });
  it('validates money precisely, payloads and images; upload never invents a deposit', async () => {
    expect(moneyToMinor('3500.01')).toBe(350001);
    expect(() => moneyToMinor('1.001')).toThrow();
    const f = await fixture(),
      h = await signed(f);
    await expect(
      s.proof(h.ctx, h.id, 'BAD', 1, Buffer.from('<script>bad upload</script>')),
    ).rejects.toThrow();
    await expect(s.proof(h.ctx, h.id, 'BAD', -1, await png())).rejects.toThrow();
    await expect(s.createHold({ ...input(f), startsAt: new Date().toISOString() })).rejects.toThrow(
      /72/,
    );
  });
  it('unblocks personal time with owner authorization only', async () => {
    const f = await fixture(),
      other = await fixture();
    const id = await s.block(
      { session: f.session },
      {
        startsAt: '2028-04-01T12:00:00-05:00',
        endsAt: '2028-04-01T20:00:00-05:00',
        reason: 'Personal day',
      },
    );
    await expect(s.unblock({ session: other.session }, id)).rejects.toMatchObject({
      code: '42501',
    });
    await s.unblock({ session: f.session }, id);
    expect(
      (await admin.query('SELECT 1 FROM lockd.occupied_slots WHERE id=$1', [id])).rowCount,
    ).toBe(0);
  });
  it('does not complete future events, and completion is idempotent', async () => {
    const f = await fixture(),
      h = await claimed(f);
    await s.verify({ session: f.session }, h.id, decision(h.claim));
    await expect(s.complete({ session: f.session }, h.id)).rejects.toThrow(/finished/);
    await admin.query(
      "UPDATE lockd.bookings SET starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' WHERE id=$1",
      [h.id],
    );
    await s.complete({ session: f.session }, h.id);
    await s.complete({ session: f.session }, h.id);
    expect(
      (await s.booking(h.ctx, h.id))!.events.filter((e) => e.kind === 'COMPLETED'),
    ).toHaveLength(1);
  });
  it('password reset invalidates prior sessions and cannot be replayed', async () => {
    const f = await fixture(),
      t = newToken();
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.request_reset($1,$2)', [f.email, hash(t)]);
    });
    expect(await resetPassword(t, 'A-new-testing-password!')).toBe(true);
    expect(await resetPassword(t, 'A-new-testing-password!')).toBe(false);
    expect(await s.dashboard({ session: f.session })).toBeNull();
    await expect(login({ email: f.email, password: 'Testing-password-123!' })).rejects.toThrow();
    expect(await login({ email: f.email, password: 'A-new-testing-password!' })).toHaveLength(64);
  });
  it('proof at the original expiry boundary never grants grace', async () => {
    const f = await fixture(),
      h = await signed(f);
    await expiry(h.id, 0);
    await s.proof(h.ctx, h.id, 'EXACT-BOUNDARY', 10000, await png());
    const b = (await s.booking(h.ctx, h.id))!;
    expect(b.grace_used).toBe(false);
    expect(b.status).toBe('HOLD_EXPIRED');
  });
  it('a proof transaction queued before expiry uses the wall clock after the lock', async () => {
    const f = await fixture(),
      h = await signed(f);
    const bytes = await png();
    await expiry(h.id, 1);
    await admin.query('BEGIN');
    await admin.query('SELECT 1 FROM lockd.accounts WHERE id=$1 FOR UPDATE', [f.account]);
    const pending = s.proof(h.ctx, h.id, 'QUEUED', 10000, bytes);
    await admin.query('SELECT pg_sleep(1.2)');
    await admin.query('COMMIT');
    await pending;
    const b = (await s.booking(h.ctx, h.id))!;
    expect(b.grace_used).toBe(false);
    expect(b.status).toBe('HOLD_EXPIRED');
  });
  it('expires a capped hold during allocation and preserves the original record', async () => {
    const f = await fixture(),
      a = await held(f, 30);
    await held(f, 40);
    await held(f, 50);
    await expiry(a.id, -1);
    const replacement = await s.createHold({ ...input(f), startsAt: a.input.startsAt });
    expect(replacement).not.toBe(a.id);
    expect((await s.booking(a.ctx, a.id))!.status).toBe('HOLD_EXPIRED');
  });
  it('snapshots direct payment instructions and human-readable JMD terms immutably', async () => {
    const f = await fixture(),
      h = await held(f);
    const before = (await s.booking(h.ctx, h.id))!.agreement;
    await admin.query(
      "UPDATE lockd.accounts SET deposit_instructions='Updated test-only payment instructions',agreement_template='Updated test-only booking agreement' WHERE id=$1",
      [f.account],
    );
    const after = (await s.booking(h.ctx, h.id))!.agreement;
    expect(after).toEqual(before);
    expect(after.payment_instructions).toContain('Do not send funds');
    expect(after.body).toContain('Total JMD: 55000.00');
    expect(after.body).toMatch(/Starts \(UTC\): .+\+00/);
  });
  it('rejects expired DJ sessions and expires guest links independently of retained records', async () => {
    const f = await fixture(),
      h = await claimed(f);
    await admin.query(
      "UPDATE lockd.sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hash(f.session)],
    );
    expect(await s.booking({ session: f.session }, h.id)).toBeNull();
    await admin.query(
      "UPDATE lockd.bookings SET guest_expires_at=now()-interval '1 second' WHERE id=$1",
      [h.id],
    );
    expect(await s.booking(h.ctx, h.id)).toBeNull();
    expect((await admin.query('SELECT 1 FROM lockd.claims WHERE id=$1', [h.claim])).rowCount).toBe(
      1,
    );
  });
  it('does not interchange verification and password-reset tokens', async () => {
    const token = newToken(),
      email = `purpose-${randomUUID()}@example.test`;
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.register_user($1,$2,$3)', [
        email,
        await passwordHash('Testing-password-123!'),
        hash(token),
      ]);
    });
    expect(await resetPassword(token, 'Attempted-new-password!')).toBe(false);
    expect(await verifyEmail(token)).toBe(true);
    const reset = newToken();
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.request_reset($1,$2)', [email, hash(reset)]);
    });
    expect(await verifyEmail(reset)).toBe(false);
    expect(await resetPassword(reset, 'Valid-new-password-123!')).toBe(true);
  });
  it('can resend verification without replacing an existing password', async () => {
    const email = `resend-${randomUUID()}@example.test`,
      first = newToken(),
      second = newToken();
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.register_user($1,$2,$3)', [
        email,
        await passwordHash('Original-password-123!'),
        hash(first),
      ]);
    });
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.register_user($1,$2,$3)', [
        email,
        await passwordHash('Replacement-password-123!'),
        hash(second),
      ]);
    });
    expect(await verifyEmail(second)).toBe(true);
    expect(await login({ email, password: 'Original-password-123!' })).toHaveLength(64);
    await expect(login({ email, password: 'Replacement-password-123!' })).rejects.toThrow();
  });
  it('edits profile atomically with stale-write protection, preserving booked prices, buffers and signed snapshots', async () => {
    const { f, h } = await confirmedFixture(),
      before = (await s.booking(h.ctx, h.id))!,
      v = (await s.settings({ session: f.session }))!;
    const slot = (
      await admin.query('SELECT slot::text FROM lockd.occupied_slots WHERE booking_id=$1', [h.id])
    ).rows[0].slot;
    await s.updateProfile(
      { session: f.session },
      {
        ...v,
        stageName: 'Updated Synthetic DJ',
        priceMinor: 6000000,
        agreement: 'Replacement synthetic terms, for new bookings only.',
        bufferBefore: 120,
      },
    );
    expect((await s.profiles(f.profile.slug))[0].stageName).toBe('Updated Synthetic DJ');
    expect((await s.booking(h.ctx, h.id))!.agreement).toEqual(before.agreement);
    expect((await s.booking(h.ctx, h.id))!.price_minor).toBe(5500000);
    expect(
      (await admin.query('SELECT slot::text FROM lockd.occupied_slots WHERE booking_id=$1', [h.id]))
        .rows[0].slot,
    ).toBe(slot);
    await expect(s.updateProfile({ session: f.session }, v)).rejects.toThrow(/Reload/);
    const current = (await s.settings({ session: f.session }))!;
    await s.updateProfile({ session: f.session }, { ...current, published: false });
    expect(await s.profiles(f.profile.slug)).toEqual([]);
    expect(await s.booking(h.ctx, h.id)).not.toBeNull();
    await expect(s.createHold(input(f, 50))).rejects.toThrow(/not available/);
    await expect(
      admin.query('DELETE FROM lockd.account_changes WHERE account_id=$1', [f.account]),
    ).rejects.toThrow(/Immutable/);
  });
  it('rejects cross-owner settings writes and never exposes private settings to a client', async () => {
    const f = await fixture(),
      other = await fixture(),
      v = (await s.settings({ session: f.session }))!;
    expect(await s.settings({})).toBeNull();
    await expect(s.updateProfile({}, v)).rejects.toThrow(/access/);
    const own = (await s.settings({ session: other.session }))!;
    await expect(
      s.updateProfile({ session: other.session }, { ...own, packageId: v.packageId }),
    ).rejects.toThrow(/access/);
    await expect(
      s.updateProfile({ session: f.session }, { ...v, slug: 'changed-address' }),
    ).rejects.toThrow(/address/);
  });
  it('requires both exact signatures, atomically moves buffers, and retains original agreement and deposit', async () => {
    const { f, h } = await confirmedFixture(),
      before = (await s.booking(h.ctx, h.id))!,
      mid = await propose(f, h);
    await acceptChange(h.ctx, h, mid, 'client');
    expect((await s.booking(h.ctx, h.id))!.starts_at).toEqual(before.starts_at);
    const a = (await s.booking(h.ctx, h.id))!.agreements[1];
    await expect(
      s.respondChange({ session: f.session }, h.id, {
        amendmentId: mid,
        party: 'dj',
        action: 'accept',
        contentHash: 'a'.repeat(64),
        signer: 'Synthetic DJ',
        accept: true,
      }),
    ).rejects.toThrow(/exact/);
    await acceptChange({ session: f.session }, h, mid, 'dj');
    await acceptChange({ session: f.session }, h, mid, 'dj');
    const after = (await s.booking(h.ctx, h.id))!;
    expect(after.agreement.id).toBe(a.id);
    expect(after.agreement.version).toBe(2);
    expect(after.agreements[0]).toEqual(before.agreement);
    expect(after.reschedules_used).toBe(1);
    expect(after.status).toBe('CONFIRMED_LOCKD');
    expect(after.verified_minor).toBe(before.verified_minor);
    expect(after.amendments[0].acceptances).toHaveLength(2);
    expect(after.events.filter((e) => e.kind === 'DATE_CHANGE_APPLIED')).toHaveLength(1);
    const slot = (
      await admin.query(
        'SELECT lower(slot) AS start,upper(slot) AS finish FROM lockd.occupied_slots WHERE booking_id=$1',
        [h.id],
      )
    ).rows[0];
    expect(new Date(after.starts_at).getTime() - slot.start.getTime()).toBe(3600000);
    expect(slot.finish.getTime() - new Date(after.ends_at).getTime()).toBe(3600000);
    await expect(propose(f, h, 60)).rejects.toThrow(/One complimentary/);
    await expect(
      admin.query('UPDATE lockd.amendment_acceptances SET signer=$1 WHERE amendment_id=$2', [
        'Tampered',
        mid,
      ]),
    ).rejects.toThrow(/Immutable/);
    await expect(
      admin.query('UPDATE lockd.amendments SET reason=$1 WHERE id=$2', ['Tampered', mid]),
    ).rejects.toThrow(/Immutable/);
  });
  it('keeps original slot and rolls back final acceptance if the proposed date is taken', async () => {
    const { f, h } = await confirmedFixture(),
      before = (await s.booking(h.ctx, h.id))!,
      mid = await propose(f, h);
    const m = (await s.booking(h.ctx, h.id))!.amendments[0];
    await acceptChange(h.ctx, h, mid, 'client');
    await s.block(
      { session: f.session },
      {
        startsAt: new Date(m.new_start).toISOString(),
        endsAt: new Date(m.new_end).toISOString(),
        reason: 'External engagement after proposal',
      },
    );
    await expect(acceptChange({ session: f.session }, h, mid, 'dj')).rejects.toMatchObject({
      code: '23P01',
    });
    const after = (await s.booking(h.ctx, h.id))!;
    expect(after.starts_at).toEqual(before.starts_at);
    expect(after.amendments[0].acceptances).toHaveLength(1);
    expect(after.agreement_version).toBe(1);
    expect(after.reschedules_used).toBe(0);
    await expect(
      s.createHold({ ...input(f), startsAt: new Date(before.starts_at).toISOString() }),
    ).rejects.toMatchObject({ code: '23P01' });
  });
  it('serializes simultaneous signatures to apply an amendment exactly once', async () => {
    const { f, h } = await confirmedFixture(),
      mid = await propose(f, h);
    await Promise.all([
      acceptChange(h.ctx, h, mid, 'client'),
      acceptChange({ session: f.session }, h, mid, 'dj'),
    ]);
    const b = (await s.booking(h.ctx, h.id))!;
    expect(b.amendments[0].state).toBe('applied');
    expect(b.events.filter((e) => e.kind === 'DATE_CHANGE_APPLIED')).toHaveLength(1);
  });
  it('declines and replaces proposals without consuming the complimentary move', async () => {
    const { f, h } = await confirmedFixture(),
      mid = await propose(f, h),
      b = (await s.booking(h.ctx, h.id))!;
    await s.respondChange({ session: f.session }, h.id, {
      amendmentId: mid,
      party: 'dj',
      action: 'decline',
      contentHash: b.agreements[1].content_hash,
      signer: '',
      accept: false,
    });
    await expect(acceptChange(h.ctx, h, mid, 'client')).rejects.toThrow(/no longer pending/);
    await propose(f, h, 50);
    const after = (await s.booking(h.ctx, h.id))!;
    expect(after.reschedules_used).toBe(0);
    expect(after.agreements).toHaveLength(3);
    expect(after.agreement_version).toBe(1);
  });
  it('rejects ineligible dates, short notice, forged party and foreign amendment access', async () => {
    const { f, h } = await confirmedFixture(),
      other = await fixture();
    await expect(propose(f, h, 130)).rejects.toThrow(/within 90/);
    await expect(propose(f, h, 1)).rejects.toThrow(/72 hours/);
    await expect(
      s.proposeChange(h.ctx, h.id, {
        party: 'dj',
        startsAt: input(f, 40).startsAt,
        reason: 'Forged role',
      }),
    ).rejects.toMatchObject({ code: '42501' });
    const mid = await propose(f, h);
    await expect(
      s.respondChange({ session: other.session }, h.id, {
        amendmentId: mid,
        party: 'dj',
        action: 'accept',
        contentHash: 'a'.repeat(64),
        signer: 'Other DJ',
        accept: true,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    const rows = await transaction(
      { session: other.session },
      async (c) => (await c.query('SELECT * FROM lockd.amendments')).rows,
    );
    expect(rows).toEqual([]);
    const near = await signed(other, 10),
      claim = await s.proof(near.ctx, near.id, 'Near date', 2750000, await png());
    await s.verify({ session: other.session }, near.id, decision(claim));
    await expect(propose(other, near, 50)).rejects.toThrow(/14 days/);
  });
  it('keeps reservation through a cancellation request, then releases it and records a distinct refund workflow', async () => {
    const { f, h } = await confirmedFixture(),
      before = (await s.booking(h.ctx, h.id))!,
      rid = await s.requestCancellation(h.ctx, h.id, { reason: 'Synthetic client cancellation' });
    expect(await s.requestCancellation(h.ctx, h.id, { reason: 'Repeated request' })).toBe(rid);
    expect((await s.booking(h.ctx, h.id))!.status).toBe('CONFIRMED_LOCKD');
    await expect(
      s.createHold({ ...input(f), startsAt: new Date(before.starts_at).toISOString() }),
    ).rejects.toMatchObject({ code: '23P01' });
    const d = cancelDecision(rid);
    await s.decideCancellation({ session: f.session }, h.id, d);
    await s.decideCancellation({ session: f.session }, h.id, d);
    let b = (await s.booking(h.ctx, h.id))!;
    expect(b.status).toBe('CANCELLED');
    expect(b.decisions).toHaveLength(1);
    expect(b.decisions[0].suggested_minor).toBe(1375000);
    expect(b.verified_minor).toBe(2750000);
    expect(b.agreement).toEqual(before.agreement);
    const did = b.decisions[0].id;
    expect(b.decisions[0].refund_reference).toBeNull();
    await expect(
      s.acknowledgeRefund(h.ctx, h.id, { decisionId: did, attest: true }),
    ).rejects.toThrow(/after the DJ/);
    await expect(
      s.recordRefund(h.ctx, h.id, { decisionId: did, reference: 'Fake refund', attest: true }),
    ).rejects.toMatchObject({ code: '42501' });
    await s.recordRefund({ session: f.session }, h.id, {
      decisionId: did,
      reference: 'SYNTHETIC-REFUND',
      attest: true,
    });
    b = (await s.booking(h.ctx, h.id))!;
    expect(b.decisions[0].acknowledged_at).toBeNull();
    await s.acknowledgeRefund(h.ctx, h.id, { decisionId: did, attest: true });
    await s.acknowledgeRefund(h.ctx, h.id, { decisionId: did, attest: true });
    expect(
      (await s.booking(h.ctx, h.id))!.events.filter(
        (e) => e.kind === 'REFUND_RECEIPT_ACKNOWLEDGED',
      ),
    ).toHaveLength(1);
    expect(
      await s.createHold({ ...input(f), startsAt: new Date(before.starts_at).toISOString() }),
    ).toBeTruthy();
    await expect(
      admin.query('DELETE FROM lockd.cancellation_decisions WHERE id=$1', [did]),
    ).rejects.toThrow(/Immutable/);
  });
  it('requires full actual funds return for DJ cancellation and preserves cancelled amendment history', async () => {
    const { f, h } = await confirmedFixture();
    await propose(f, h);
    await expect(
      s.decideCancellation({ session: f.session }, h.id, cancelDecision(null, 1375000)),
    ).rejects.toThrow(/full return/);
    await expect(
      s.decideCancellation(h.ctx, h.id, cancelDecision(null, 2750000)),
    ).rejects.toMatchObject({ code: '42501' });
    await s.decideCancellation({ session: f.session }, h.id, cancelDecision(null, 2750000));
    const b = (await s.booking(h.ctx, h.id))!;
    expect(b.amendments[0].state).toBe('cancelled');
    expect(b.decisions[0].refund_minor).toBe(2750000);
    expect(
      new Date(b.decisions[0].due_at!).getTime() - new Date(b.decisions[0].created_at).getTime(),
    ).toBeGreaterThan(7 * 86400000 - 2000);
    expect(
      new Date(b.decisions[0].due_at!).getTime() - new Date(b.decisions[0].created_at).getTime(),
    ).toBeLessThanOrEqual(7 * 86400000);
  });
  it('declines cancellation without releasing dates and blocks amendments while cancellation is pending', async () => {
    const { f, h } = await confirmedFixture(),
      mid = await propose(f, h),
      rid = await s.requestCancellation(h.ctx, h.id, { reason: 'Please review cancellation' });
    await expect(acceptChange({ session: f.session }, h, mid, 'dj')).rejects.toThrow(
      /cancellation request/,
    );
    await s.decideCancellation({ session: f.session }, h.id, {
      ...cancelDecision(rid, 0),
      approve: false,
    });
    expect((await s.booking(h.ctx, h.id))!.status).toBe('CONFIRMED_LOCKD');
    await acceptChange({ session: f.session }, h, mid, 'dj');
    await acceptChange(h.ctx, h, mid, 'client');
    expect((await s.booking(h.ctx, h.id))!.amendments[0].state).toBe('applied');
  });
  it('uses client request timestamp for the 14-day refund suggestion, not later review time', async () => {
    const f = await fixture(),
      h = await signed(f, 10),
      cid = await s.proof(h.ctx, h.id, 'Synthetic near date', 2750000, await png());
    await s.verify({ session: f.session }, h.id, decision(cid));
    const rid = await s.requestCancellation(h.ctx, h.id, { reason: 'Synthetic late cancellation' });
    await s.decideCancellation({ session: f.session }, h.id, cancelDecision(rid, 0));
    const b = (await s.booking(h.ctx, h.id))!;
    expect(b.decisions[0].suggested_minor).toBe(0);
    expect(b.decisions[0].due_at).toBeNull();
  });
  it('rejects unsigned refund attestations and isolates all new tables and functions', async () => {
    const { f, h } = await confirmedFixture(),
      other = await fixture(),
      rid = await s.requestCancellation(h.ctx, h.id, { reason: 'Synthetic test cancellation' });
    await expect(
      s.decideCancellation({ session: f.session }, h.id, { ...cancelDecision(rid), attest: false }),
    ).rejects.toThrow();
    await expect(
      s.decideCancellation({ session: other.session }, h.id, cancelDecision(rid)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      s.decideCancellation({ session: f.session }, h.id, cancelDecision(rid, 3000000)),
    ).rejects.toMatchObject({ code: '23514' });
    await s.decideCancellation({ session: f.session }, h.id, cancelDecision(rid));
    const tables = [
      'cancellation_requests',
      'cancellation_decisions',
      'refund_records',
      'refund_acknowledgements',
      'amendments',
      'amendment_acceptances',
      'account_changes',
    ];
    for (const table of tables) {
      expect(
        await transaction(
          { session: other.session },
          async (c) => (await c.query(`SELECT * FROM lockd.${table}`)).rows,
        ),
      ).toEqual([]);
      await expect(
        transaction({ session: f.session }, async (c) => c.query(`DELETE FROM lockd.${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      transaction({ session: f.session }, async (c) =>
        c.query(
          "SELECT lockd.change_event(b,'FORGED','forged','{}') FROM lockd.bookings b WHERE id=$1",
          [h.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('expires amendment acceptance after 48 hours and preserves the original reservation', async () => {
    const { f, h } = await confirmedFixture(),
      before = (await s.booking(h.ctx, h.id))!,
      mid = await propose(f, h);
    await acceptChange(h.ctx, h, mid, 'client');
    // Only the isolated test database clock fixture can rewrite proposal timestamps.
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER TABLE lockd.amendments DISABLE TRIGGER amendments_history');
      await admin.query(
        "UPDATE lockd.amendments SET created_at=now()-interval '49 hours',expires_at=now()-interval '49 hours'+interval '48 hours' WHERE id=$1",
        [mid],
      );
      await admin.query('ALTER TABLE lockd.amendments ENABLE TRIGGER amendments_history');
      await admin.query('COMMIT');
    } catch (e) {
      await admin.query('ROLLBACK');
      throw e;
    }
    await expect(acceptChange({ session: f.session }, h, mid, 'dj')).rejects.toThrow(
      /no longer pending/,
    );
    let b = (await s.booking(h.ctx, h.id))!;
    expect(b.starts_at).toEqual(before.starts_at);
    expect(b.amendments[0].state).toBe('expired');
    expect(b.reschedules_used).toBe(0);
    await propose(f, h, 50);
    b = (await s.booking(h.ctx, h.id))!;
    expect(b.agreements).toHaveLength(3);
    expect(b.amendments[0].state).toBe('expired');
  });
});

describe('Manual software subscriptions and scoped staff MFA', () => {
  it('matches RFC 6238 SHA-1 vectors and rejects malformed or expired codes', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    for (const [time, expected] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ] as const)
      expect(totp(secret, time, 8)).toBe(expected);
    expect(verifyTotp(secret, totp(secret, 1000), 1000)).toBe(Math.floor(1000 / 30));
    expect(verifyTotp(secret, totp(secret, 1000), 2000)).toBeNull();
    expect(verifyTotp(secret, '12')).toBeNull();
  });
  it('blocks collection until bank configuration exists and enforces exact plan-specific invoice prices', async () => {
    const f = await fixture(),
      ctx = { session: f.session };
    await admin.query('UPDATE lockd.billing_settings SET enabled=false');
    const input = {
      plan: 'monthly',
      billingName: 'Synthetic DJ billing',
      billingEmail: f.email,
      requestId: randomUUID(),
    };
    await expect(billing.issue(ctx, input)).rejects.toThrow(/not configured/);
    await enableBilling();
    const id = await billing.issue(ctx, input);
    expect(await billing.issue(ctx, input)).toBe(id);
    expect((await billing.invoice(ctx, id))!.amount_minor).toBe(350000);
    await expect(billing.issue(ctx, { ...input, plan: 'annual' })).rejects.toThrow(/already used/);
    await billing.voidInvoice(ctx, id, { reason: 'Synthetic plan selection changed' });
    const annual = await billing.issue(ctx, { ...input, plan: 'annual', requestId: randomUUID() });
    expect((await billing.invoice(ctx, annual))!.amount_minor).toBe(3600000);
    await expect(
      admin.query('UPDATE lockd.subscription_invoices SET amount_minor=1 WHERE id=$1', [annual]),
    ).rejects.toThrow(/Immutable invoice/);
  });
  it('requires independent staff and fresh MFA; rejects replay and revocation immediately', async () => {
    const x = await invoiceFixture();
    const plain = await login({ email: x.staff.email, password: 'Testing-password-123!' });
    await expect(
      billing.reconcile({ session: plain }, x.id, invoiceDecision(x.claim)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(billing.stepUp({ session: plain }, { code: x.staff.code })).rejects.toThrow(
      /already used/,
    );
    await expect(billing.reconcile(x.ctx, x.id, invoiceDecision(x.claim))).rejects.toMatchObject({
      code: '42501',
    });
    const own = await billing.issue(x.staff.ctx, {
      plan: 'monthly',
      billingName: 'Own staff invoice',
      billingEmail: x.staff.email,
      requestId: randomUUID(),
    });
    const claim = await billing.upload(x.staff.ctx, own, 'STAFF-OWN', 350000, await png());
    await expect(billing.reconcile(x.staff.ctx, own, invoiceDecision(claim))).rejects.toMatchObject(
      { code: '42501' },
    );
    await expect(
      billing.approve(x.staff.ctx, {
        accountId: x.staff.account,
        reason: 'Attempted self approval',
        attest: true,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await admin.query(
      "UPDATE lockd.billing_staff_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [x.staff.uid],
    );
    await expect(
      billing.reconcile(x.staff.ctx, x.id, invoiceDecision(x.claim)),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await billing.invoice(x.staff.ctx, x.id)).toBeNull();
  });
  it('keeps invoice proof and partial receipts separate from entitlements and settles exactly once', async () => {
    const x = await invoiceFixture(),
      b = (await billing.home(x.ctx))!;
    expect(b.pro).toBe(false);
    await expect(
      billing.reconcile(x.staff.ctx, x.id, { ...invoiceDecision(x.claim), attest: false }),
    ).rejects.toThrow();
    const first = invoiceDecision(x.claim, 100000);
    expect(await billing.reconcile(x.staff.ctx, x.id, first)).toBe('open');
    expect(await billing.reconcile(x.staff.ctx, x.id, first)).toBe('open');
    expect((await billing.home(x.ctx))!.pro).toBe(false);
    await expect(
      billing.voidInvoice(x.ctx, x.id, { reason: 'Attempt to void paid evidence' }),
    ).rejects.toThrow(/payment activity/);
    const topup = await billing.upload(x.ctx, x.id, 'SYNTHETIC-TOPUP', 250000, await png());
    const second = invoiceDecision(topup, 250000);
    expect(await billing.reconcile(x.staff.ctx, x.id, second)).toBe('paid');
    expect(await billing.reconcile(x.staff.ctx, x.id, second)).toBe('paid');
    expect((await billing.home(x.ctx))!.pro).toBe(true);
    expect((await billing.invoice(x.ctx, x.id))!.verified_minor).toBe(350000);
    expect(
      (await admin.query('SELECT * FROM lockd.subscription_grants WHERE invoice_id=$1', [x.id]))
        .rowCount,
    ).toBe(1);
    await expect(
      admin.query('DELETE FROM lockd.subscription_payments WHERE invoice_id=$1', [x.id]),
    ).rejects.toThrow(/Immutable/);
  });
  it('rejects duplicate bank receipts across tenants and enforces invoice/claim ownership', async () => {
    const a = await invoiceFixture(),
      b = await invoiceFixture(),
      v = invoiceDecision(a.claim);
    await billing.reconcile(a.staff.ctx, a.id, v);
    await expect(
      billing.reconcile(b.staff.ctx, b.id, {
        ...invoiceDecision(b.claim),
        bankReference: v.bankReference.toLowerCase(),
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(billing.reconcile(b.staff.ctx, b.id, invoiceDecision(a.claim))).rejects.toThrow(
      /already recorded differently/,
    );
    expect(await billing.invoice(b.ctx, a.id)).toBeNull();
    expect(await billing.receipt(b.ctx, a.claim)).toBeUndefined();
    expect(await billing.invoice({}, a.id)).toBeNull();
  });
  it('rejection records zero funds, rejects impossible receipt dates, and permits corrected new evidence', async () => {
    const x = await invoiceFixture();
    await expect(
      billing.reconcile(x.staff.ctx, x.id, {
        ...invoiceDecision(x.claim),
        receivedAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    ).rejects.toThrow(/valid timestamp/);
    await billing.reconcile(x.staff.ctx, x.id, {
      claimId: x.claim,
      decision: 'rejected',
      amountMinor: 0,
      bankReference: '',
      receivedAt: null,
      reason: 'Synthetic incorrect reference',
      attest: false,
    });
    expect((await billing.home(x.ctx))!.pro).toBe(false);
    expect((await billing.invoice(x.ctx, x.id))!.verified_minor).toBe(0);
    const cid = await billing.upload(x.ctx, x.id, 'CORRECTED-SYNTHETIC', 350000, await png());
    await billing.reconcile(x.staff.ctx, x.id, invoiceDecision(cid));
    expect((await billing.home(x.ctx))!.pro).toBe(true);
  });
  it('enforces paid access and exact renewal grace in hold allocation without deleting existing bookings', async () => {
    const x = await invoiceFixture();
    await billing.reconcile(x.staff.ctx, x.id, invoiceDecision(x.claim));
    const ids = await Promise.all([10, 20, 30, 40].map((day) => s.createHold(input(x.dj, day))));
    expect(ids).toHaveLength(4);
    await moveSubscriptionEnd(x.dj.account, -6);
    expect((await billing.home(x.ctx))!.pro).toBe(true);
    await s.createHold(input(x.dj, 50));
    await moveSubscriptionEnd(x.dj.account, -7);
    expect((await billing.home(x.ctx))!.pro).toBe(false);
    await expect(s.createHold(input(x.dj, 60))).rejects.toThrow(/Free plan/);
    expect((await s.dashboard(x.ctx))!.bookings).toHaveLength(5);
    const renewal = await billing.issue(x.ctx, {
      plan: 'monthly',
      billingName: 'Synthetic renewal',
      billingEmail: x.dj.email,
      requestId: randomUUID(),
    });
    const cid = await billing.upload(x.ctx, renewal, 'RENEWAL', 350000, await png());
    await billing.reconcile(x.staff.ctx, renewal, invoiceDecision(cid));
    expect((await billing.home(x.ctx))!.pro).toBe(true);
  });
  it('renews from the original due date within grace, not the reconciliation date', async () => {
    const x = await invoiceFixture('annual');
    await billing.reconcile(x.staff.ctx, x.id, invoiceDecision(x.claim, x.amount));
    await expect(
      billing.issue(x.ctx, {
        plan: 'annual',
        billingName: 'Early renewal',
        billingEmail: x.dj.email,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(/15 days/);
    await moveSubscriptionEnd(x.dj.account, -3);
    const before = (await billing.home(x.ctx))!.subscription!;
    const iid = await billing.issue(x.ctx, {
        plan: 'annual',
        billingName: 'Renewal',
        billingEmail: x.dj.email,
        requestId: randomUUID(),
      }),
      cid = await billing.upload(x.ctx, iid, 'ANNUAL-RENEWAL', 3600000, await png());
    await billing.reconcile(x.staff.ctx, iid, invoiceDecision(cid, 3600000));
    const after = (await billing.home(x.ctx))!.subscription!;
    expect(new Date(after.starts_at).toISOString()).toBe(new Date(before.ends_at).toISOString());
    expect(new Date(after.ends_at) > new Date()).toBe(true);
  });
  it('allocates founding membership only after approval and full verified bank funds', async () => {
    await enableBilling();
    const dj = await fixture(),
      ctx = { session: dj.session },
      staff = await reviewer();
    const d = {
      plan: 'founding',
      billingName: 'Founding synthetic DJ',
      billingEmail: dj.email,
      requestId: randomUUID(),
    };
    await expect(billing.issue(ctx, d)).rejects.toThrow(/approval/);
    await billing.approve(staff.ctx, {
      accountId: dj.account,
      reason: 'Verified synthetic Jamaican DJ eligibility',
      attest: true,
    });
    const id = await billing.issue(ctx, d);
    expect((await billing.home(ctx))!.seat).toBeNull();
    const cid = await billing.upload(ctx, id, 'FOUNDING', 2500000, await png());
    expect((await billing.home(ctx))!.seat).toBeNull();
    await billing.reconcile(staff.ctx, id, invoiceDecision(cid, 2500000));
    expect((await billing.home(ctx))!.seat).toBeGreaterThan(0);
  });
  it('preserves founding price for timely actual renewal receipt even if staff review is late', async () => {
    const x = await invoiceFixture('founding');
    await billing.reconcile(x.staff.ctx, x.id, invoiceDecision(x.claim, x.amount));
    await moveSubscriptionEnd(x.dj.account, -6);
    const iid = await billing.issue(x.ctx, {
      plan: 'founding',
      billingName: 'Founding renewal',
      billingEmail: x.dj.email,
      requestId: randomUUID(),
    });
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER TABLE lockd.subscription_invoices DISABLE TRIGGER invoice_history');
      await admin.query(
        "UPDATE lockd.subscriptions SET starts_at=now()-interval '1 year',ends_at=now()-interval '8 days' WHERE account_id=$1",
        [x.dj.account],
      );
      await admin.query(
        "UPDATE lockd.subscription_invoices SET created_at=now()-interval '20 days',due_at=(SELECT ends_at FROM lockd.subscriptions WHERE account_id=$2),renewal_for=(SELECT ends_at FROM lockd.subscriptions WHERE account_id=$2) WHERE id=$1",
        [iid, x.dj.account],
      );
      await admin.query('ALTER TABLE lockd.subscription_invoices ENABLE TRIGGER invoice_history');
      await admin.query('COMMIT');
    } catch (e) {
      await admin.query('ROLLBACK');
      throw e;
    }
    expect((await billing.home(x.ctx))!.pro).toBe(false);
    const cid = await billing.upload(x.ctx, iid, 'TIMELY-RENEWAL', 2500000, await png());
    await billing.reconcile(x.staff.ctx, iid, {
      ...invoiceDecision(cid, 2500000),
      receivedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    });
    expect((await billing.home(x.ctx))!.pro).toBe(true);
  });
  it('keeps billing staff out of event contracts and receipts and removes access when disabled', async () => {
    const x = await invoiceFixture(),
      h = await claimed(x.dj);
    expect(await s.booking(x.staff.ctx, h.id)).toBeNull();
    expect(await s.receipt(x.staff.ctx, h.claim)).toBeUndefined();
    expect((await billing.queue(x.staff.ctx)).invoices.some((i) => i.id === x.id)).toBe(true);
    await admin.query('UPDATE lockd.billing_staff_members SET enabled=false WHERE user_id=$1', [
      x.staff.uid,
    ]);
    expect(await billing.invoice(x.staff.ctx, x.id)).toBeNull();
    await expect(billing.queue(x.staff.ctx)).rejects.toThrow(/MFA/);
    for (const table of [
      'subscription_invoices',
      'subscription_claims',
      'subscription_payments',
      'subscriptions',
      'subscription_grants',
      'founding_memberships',
      'founding_approvals',
      'billing_events',
    ])
      await expect(
        transaction(x.ctx, (c) => c.query(`DELETE FROM lockd.${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('rechecks staff MFA after waiting for the tenant lock', async () => {
    const x = await invoiceFixture();
    await admin.query('BEGIN');
    await admin.query('SELECT id FROM lockd.accounts WHERE id=$1 FOR UPDATE', [x.dj.account]);
    await admin.query(
      "UPDATE lockd.billing_staff_sessions SET expires_at=clock_timestamp()+interval '50 milliseconds' WHERE user_id=$1",
      [x.staff.uid],
    );
    const pending = billing.reconcile(x.staff.ctx, x.id, invoiceDecision(x.claim)).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    await admin.query('SELECT pg_sleep(0.2)');
    await admin.query('COMMIT');
    expect(await pending).toMatchObject({ code: '42501' });
    expect((await billing.invoice(x.ctx, x.id))!.verified_minor).toBe(0);
  });
  it('rate limits authenticator replays per staff account', async () => {
    const staff = await reviewer(),
      code = staff.code;
    for (let n = 0; n < 5; n++)
      await expect(billing.stepUp(staff.ctx, { code })).rejects.toThrow(/already used/);
    await expect(billing.stepUp(staff.ctx, { code })).rejects.toThrow(/Too many/);
  });
  it('records a late founding renewal as unapplied funds and does not silently substitute a standard plan', async () => {
    const x = await invoiceFixture('founding');
    await billing.reconcile(x.staff.ctx, x.id, invoiceDecision(x.claim, x.amount));
    await moveSubscriptionEnd(x.dj.account, -6);
    const iid = await billing.issue(x.ctx, {
      plan: 'founding',
      billingName: 'Late founding renewal',
      billingEmail: x.dj.email,
      requestId: randomUUID(),
    });
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER TABLE lockd.subscription_invoices DISABLE TRIGGER invoice_history');
      await admin.query(
        "UPDATE lockd.subscriptions SET starts_at=now()-interval '1 year',ends_at=now()-interval '8 days' WHERE account_id=$1",
        [x.dj.account],
      );
      await admin.query(
        "UPDATE lockd.subscription_invoices SET created_at=now()-interval '20 days',due_at=(SELECT ends_at FROM lockd.subscriptions WHERE account_id=$2),renewal_for=(SELECT ends_at FROM lockd.subscriptions WHERE account_id=$2) WHERE id=$1",
        [iid, x.dj.account],
      );
      await admin.query('ALTER TABLE lockd.subscription_invoices ENABLE TRIGGER invoice_history');
      await admin.query('COMMIT');
    } catch (e) {
      await admin.query('ROLLBACK');
      throw e;
    }
    const cid = await billing.upload(x.ctx, iid, 'LATE-FOUNDING-RENEWAL', 2500000, await png());
    expect(await billing.reconcile(x.staff.ctx, iid, invoiceDecision(cid, 2500000))).toBe(
      'requires_resolution',
    );
    const h = (await billing.home(x.ctx))!;
    expect(h.pro).toBe(false);
    expect(h.subscription!.plan).toBe('founding');
    expect((await billing.invoice(x.ctx, iid))!.verified_minor).toBe(2500000);
    expect(
      (await admin.query('SELECT * FROM lockd.subscription_grants WHERE invoice_id=$1', [iid]))
        .rowCount,
    ).toBe(0);
  });
  it('serializes the final founding place and records the other payment for resolution without granting access', async () => {
    const staff = await reviewer();
    await enableBilling();
    const prepare = async () => {
      const dj = await fixture(),
        ctx = { session: dj.session };
      await billing.approve(staff.ctx, {
        accountId: dj.account,
        reason: 'Synthetic Jamaican DJ cohort eligibility',
        attest: true,
      });
      const id = await billing.issue(ctx, {
        plan: 'founding',
        billingName: 'Synthetic Cohort DJ',
        billingEmail: dj.email,
        requestId: randomUUID(),
      });
      const claim = await billing.upload(ctx, id, 'SYNTHETIC-COHORT', 2500000, await png());
      return { dj, ctx, id, claim };
    };
    let count = Number(
      (await admin.query('SELECT count(*) FROM lockd.founding_memberships')).rows[0].count,
    );
    while (count < 49) {
      const x = await prepare();
      await billing.reconcile(staff.ctx, x.id, invoiceDecision(x.claim, 2500000));
      count++;
    }
    const a = await prepare(),
      b = await prepare();
    const states = await Promise.all([
      billing.reconcile(staff.ctx, a.id, invoiceDecision(a.claim, 2500000)),
      billing.reconcile(staff.ctx, b.id, invoiceDecision(b.claim, 2500000)),
    ]);
    expect(states.sort()).toEqual(['paid', 'requires_resolution']);
    expect(
      Number((await admin.query('SELECT count(*) FROM lockd.founding_memberships')).rows[0].count),
    ).toBe(50);
    const homes = await Promise.all([billing.home(a.ctx), billing.home(b.ctx)]);
    expect(homes.filter((h) => h!.pro)).toHaveLength(1);
    const rejected = states;
    expect(rejected).toContain('requires_resolution');
    const outsider = await fixture();
    await billing.approve(staff.ctx, {
      accountId: outsider.account,
      reason: 'Synthetic cohort already full test',
      attest: true,
    });
    await expect(
      billing.issue(
        { session: outsider.session },
        {
          plan: 'founding',
          billingName: 'No place left',
          billingEmail: outsider.email,
          requestId: randomUUID(),
        },
      ),
    ).rejects.toThrow(/cohort is full/);
  });
});

const ORIGIN = 'https://lockd.test';
function recorder(outcome?: (m: Outgoing) => SendResult) {
  const sent: Outgoing[] = [];
  const transport: Transport = {
    name: 'recorder',
    async send(m) {
      sent.push(m);
      return outcome ? outcome(m) : { ok: true, messageId: `rec-${m.id}` };
    },
  };
  return { sent, transport };
}
async function drain(
  transport: Transport,
  pool = notifier,
  allowedDomains: string[] | null = null,
) {
  for (let i = 0; i < 50; i++) {
    const r = await dispatch(pool, { transport, allowedDomains }, ORIGIN);
    if (!(r.sent + r.retry + r.failed + r.skipped)) return;
  }
}
type Row = {
  id: string;
  kind: string;
  audience: string;
  status: string;
  attempts: number;
  secret_cipher: string | null;
  last_error: string | null;
};
const rows = async (bookingId: string) =>
  (
    await admin.query(
      "SELECT id,kind,audience,status,attempts,secret_cipher,last_error FROM lockd.outbox WHERE payload->>'bookingId'=$1 ORDER BY created_at,kind",
      [bookingId],
    )
  ).rows as Row[];
const tokenIn = (m: Outgoing) => m.action!.url.split('#')[1];

describe('Transactional notifications', () => {
  it('queues hold, request and signature messages once and delivers each exactly once', async () => {
    const f = await fixture(),
      h = await signed(f);
    await s.createHold(h.input); // An idempotent retry must not queue or re-attach anything.
    const queued = await rows(h.id);
    expect(queued.map((r) => `${r.kind}:${r.audience}`).sort()).toEqual([
      'agreement_signed:client',
      'agreement_signed:dj',
      'booking_request:dj',
      'hold_created:client',
    ]);
    const hold = queued.find((r) => r.kind === 'hold_created')!;
    expect(hold.secret_cipher).toBeTruthy();
    expect(hold.secret_cipher).not.toContain(h.guest);
    const { sent, transport } = recorder();
    await drain(transport);
    await drain(transport);
    for (const r of await rows(h.id)) {
      expect(r.status).toBe('sent');
      expect(r.secret_cipher).toBeNull();
      expect(sent.filter((m) => m.id === r.id)).toHaveLength(1);
    }
    const holdMail = sent.find((m) => m.id === hold.id)!;
    expect(holdMail.to).toBe('client@example.test');
    expect(holdMail.action!.url).toBe(`${ORIGIN}/booking/${h.id}#${h.guest}`);
    expect(holdMail.text).toMatch(/Lockd never holds booking deposits/);
    const request = sent.find((m) => m.kind === 'booking_request' && m.action!.url.includes(h.id))!;
    expect(request.to).toBe(f.email);
    expect(request.action!.url).toBe(`${ORIGIN}/dashboard/bookings/${h.id}`);
    expect(request.text).not.toContain(h.guest);
    const attempts = await admin.query(
      'SELECT outcome,provider FROM lockd.notification_attempts WHERE outbox_id=$1',
      [hold.id],
    );
    expect(attempts.rows).toEqual([{ outcome: 'sent', provider: 'recorder' }]);
    await expect(
      admin.query("UPDATE lockd.notification_attempts SET outcome='failed' WHERE outbox_id=$1", [
        hold.id,
      ]),
    ).rejects.toThrow(/Immutable/);
  });
  it('delivers working verification links and fails links that cannot work', async () => {
    const email = `mail-${randomUUID()}@example.test`;
    await register({ email, password: 'Testing-password-123!' });
    const row = (
      await admin.query(
        "SELECT id,secret_cipher FROM lockd.outbox WHERE recipient=$1 AND kind='verify'",
        [email],
      )
    ).rows[0];
    expect(row.secret_cipher).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    // Queued without an encrypted link (written directly in SQL, as fixtures do).
    const bare = `bare-${randomUUID()}@example.test`;
    await transaction({}, async (c) => {
      await c.query('SELECT lockd.register_user($1,$2,$3)', [bare, 'x', hash(newToken())]);
    });
    const { sent, transport } = recorder();
    await drain(transport);
    const mail = sent.find((m) => m.id === row.id)!;
    expect(mail.action!.url.startsWith(`${ORIGIN}/verify#`)).toBe(true);
    expect(await verifyEmail(tokenIn(mail))).toBe(true);
    const unusable = (
      await admin.query('SELECT status,last_error FROM lockd.outbox WHERE recipient=$1', [bare])
    ).rows[0];
    expect(unusable.status).toBe('failed');
    expect(unusable.last_error).toMatch(/secret unavailable/);
    expect(sent.some((m) => m.to === bare)).toBe(false);
    await requestReset(email);
    await requestReset(`nobody-${randomUUID()}@example.test`);
    await admin.query(
      "UPDATE lockd.outbox SET created_at=now()-interval '31 minutes' WHERE recipient=$1 AND kind='reset'",
      [email],
    );
    await drain(transport);
    const reset = (
      await admin.query(
        "SELECT status,last_error,secret_cipher FROM lockd.outbox WHERE recipient=$1 AND kind='reset'",
        [email],
      )
    ).rows[0];
    expect(reset).toMatchObject({ status: 'failed', secret_cipher: null });
    expect(reset.last_error).toMatch(/expired/);
  });
  it('retries transient failures with backoff, fails permanent errors and ignores stale leases', async () => {
    const f = await fixture();
    await drain(recorder().transport);
    const h = await held(f);
    const flaky = recorder(() => ({ ok: false, retry: true, error: 'Resend 503: unavailable' }));
    await drain(flaky.transport);
    const queued = await rows(h.id);
    expect(queued).toHaveLength(2);
    for (const r of queued)
      expect(r).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: 'Resend 503: unavailable',
      });
    const due = await admin.query(
      "SELECT bool_and(next_attempt_at BETWEEN now()+interval '50 seconds' AND now()+interval '70 seconds') ok FROM lockd.outbox WHERE payload->>'bookingId'=$1",
      [h.id],
    );
    expect(due.rows[0].ok).toBe(true);
    const hold = queued.find((r) => r.kind === 'hold_created')!,
      request = queued.find((r) => r.kind === 'booking_request')!;
    const stale = await notifier.query(
      "SELECT lockd.notifier_finish($1,1,'sent','stale',NULL,NULL,60) AS s",
      [hold.id],
    );
    expect(stale.rows[0].s).toBe('stale');
    await admin.query(
      "UPDATE lockd.outbox SET next_attempt_at=now() WHERE payload->>'bookingId'=$1",
      [h.id],
    );
    const mixed = recorder((m) =>
      m.id === hold.id
        ? { ok: true, messageId: 'provider-1' }
        : { ok: false, retry: false, error: 'Resend 422: invalid to' },
    );
    await drain(mixed.transport);
    const after = await rows(h.id);
    expect(after.find((r) => r.id === hold.id)).toMatchObject({
      status: 'sent',
      attempts: 2,
      secret_cipher: null,
    });
    expect(after.find((r) => r.id === request.id)).toMatchObject({ status: 'failed', attempts: 2 });
    const history = await admin.query(
      'SELECT attempt,outcome FROM lockd.notification_attempts WHERE outbox_id=$1 ORDER BY attempt',
      [hold.id],
    );
    expect(history.rows).toEqual([
      { attempt: 1, outcome: 'retry' },
      { attempt: 2, outcome: 'sent' },
    ]);
    // The eighth recorded attempt is terminal even for a retryable error.
    for (let attempt = 3; attempt <= 7; attempt++)
      await admin.query(
        "INSERT INTO lockd.notification_attempts(outbox_id,attempt,outcome,provider,error) VALUES($1,$2,'retry','recorder','Synthetic earlier attempt')",
        [request.id, attempt],
      );
    await admin.query(
      "UPDATE lockd.outbox SET status='pending',attempts=7,next_attempt_at=now() WHERE id=$1",
      [request.id],
    );
    await drain(flaky.transport);
    expect((await rows(h.id)).find((r) => r.id === request.id)).toMatchObject({
      status: 'failed',
      attempts: 8,
    });
  });
  it('never delivers a message twice with competing workers', async () => {
    const djs = [await fixture(), await fixture()];
    await drain(recorder().transport);
    for (const f of djs) for (let i = 0; i < 3; i++) await held(f, 30 + i * 3);
    const second = new pg.Pool({ connectionString: notifierUrl, max: 2 });
    const a = recorder(),
      b = recorder();
    await Promise.all([
      drain(a.transport),
      drain(b.transport, second),
      drain(a.transport),
      drain(b.transport, second),
    ]);
    await second.end();
    const ids = [...a.sent, ...b.sent].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(12);
  });
  it('isolates the worker role from bookings and the runtime from the delivery queue', async () => {
    const f = await fixture(),
      h = await held(f);
    for (const sql of [
      'SELECT * FROM lockd.bookings LIMIT 1',
      'SELECT * FROM lockd.outbox LIMIT 1',
      "SELECT lockd.public_profiles('x')",
      "SELECT lockd.new_session(gen_random_uuid(),repeat('a',64))",
    ])
      await expect(notifier.query(sql)).rejects.toMatchObject({ code: '42501' });
    // Hold expiry is the one booking function the worker role may run.
    expect(
      (await notifier.query('SELECT lockd.expire_all() AS n')).rows[0].n,
    ).toBeGreaterThanOrEqual(0);
    await expect(
      notifier.query('SELECT lockd.create_hold($1,$2,$3)', [h.input, 'a'.repeat(64), 'b']),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      notifier.query('SELECT lockd.request_guest_link($1,$2,$3)', [
        h.id,
        'x@example.test',
        'a'.repeat(64),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    for (const sql of [
      'SELECT * FROM lockd.outbox LIMIT 1',
      'SELECT * FROM lockd.notification_attempts LIMIT 1',
      'SELECT * FROM lockd.guest_links LIMIT 1',
      'SELECT * FROM lockd.notifier_claim(1,60)',
      'SELECT lockd.enqueue_due_reminders()',
    ])
      await expect(transaction({}, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    // Attaching requires the hash of the real link, and only fills an empty slot once.
    expect(await transaction({}, (c) => attachSecret(c, `hold:${h.id}:client`, newToken()))).toBe(
      false,
    );
    expect(await transaction({}, (c) => attachSecret(c, `hold:${h.id}:client`, h.guest))).toBe(
      false,
    );
    // Context is only readable for a row currently leased for delivery.
    const id = (await rows(h.id))[0].id;
    expect((await notifier.query('SELECT lockd.notifier_context($1,1) AS c', [id])).rows[0].c).toBe(
      null,
    );
  });
  it('queues idempotent reminders and suppresses those made stale by later actions', async () => {
    const f = await fixture(),
      unsigned = await held(f, 26),
      unpaid = await signed(f, 34),
      review = await claimed(f);
    await expiry(unsigned.id, 35 * 3600);
    await expiry(unpaid.id, 6 * 3600);
    await expiry(review.id, -19 * 3600, true); // within the 24-hour verification window
    await drain(recorder().transport);
    await notifier.query('SELECT lockd.enqueue_due_reminders()');
    await notifier.query('SELECT lockd.enqueue_due_reminders()');
    const reminders = async (id: string) => (await rows(id)).filter((r) => /reminder/.test(r.kind));
    expect((await reminders(unsigned.id)).map((r) => r.kind)).toEqual(['agreement_reminder']);
    expect((await reminders(unpaid.id)).map((r) => r.kind)).toEqual(['deposit_reminder']);
    expect((await reminders(review.id)).map((r) => `${r.kind}:${r.audience}`)).toEqual([
      'verification_reminder:dj',
    ]);
    const b = (await s.booking(unsigned.ctx, unsigned.id))!;
    await s.sign(unsigned.ctx, unsigned.id, {
      agreementId: b.agreement.id,
      contentHash: b.agreement.content_hash,
      signer: 'Synthetic Client',
      accept: true,
    });
    const { sent, transport } = recorder();
    await drain(transport);
    expect((await reminders(unsigned.id))[0]).toMatchObject({ status: 'suppressed' });
    const depositId = (await reminders(unpaid.id))[0].id;
    const deposit = sent.find((m) => m.id === depositId)!;
    expect(deposit.subject).toMatch(/ends soon/);
    expect(deposit.text).toMatch(/J\$27,500\.00/);
    const verifyId = (await reminders(review.id))[0].id;
    expect(sent.find((m) => m.id === verifyId)!.to).toBe(f.email);
  });
  it('reports payment discrepancies, confirmation and cancellation to the right parties', async () => {
    const { sent, transport } = recorder();
    const f = await fixture(),
      h = await claimed(f);
    await drain(transport); // Hold-phase messages go out while the hold is still running.
    await s.verify({ session: f.session }, h.id, decision(h.claim, 1000000));
    const topUp = await s.proof(h.ctx, h.id, 'TEST-TOPUP', 1750000, await png());
    await s.verify({ session: f.session }, h.id, decision(topUp, 1750000));
    const rid = await s.requestCancellation(h.ctx, h.id, {
      reason: 'Synthetic client cancellation',
    });
    await s.decideCancellation({ session: f.session }, h.id, cancelDecision(rid));
    await drain(transport);
    const mine = new Set((await rows(h.id)).map((r) => r.id));
    const mail = sent.filter((m) => mine.has(m.id));
    const by = (kind: string, to: string) => mail.filter((m) => m.kind === kind && m.to === to);
    expect(by('proof_submitted', f.email)).toHaveLength(2);
    const partial = by('partial_verified', 'client@example.test')[0];
    expect(partial.subject).toMatch(/Part of your deposit/);
    expect(partial.text).toMatch(/verified J\$10,000\.00 .*you reported J\$27,500\.00/);
    expect(partial.text).toMatch(/remaining J\$17,500\.00/);
    expect(by('confirmed_lockd', 'client@example.test')[0].subject).toMatch(/^Confirmed:/);
    expect(by('CANCELLATION_REQUESTED', f.email)[0].text).toMatch(/asked to cancel/);
    expect(by('CANCELLED', 'client@example.test')[0].text).toMatch(
      /owes you a direct refund of J\$13,750\.00/,
    );
    expect(by('CANCELLED', f.email)[0].text).toMatch(/You owe the client/);
    // Only the original hold email carries the private link.
    expect(mail.filter((m) => m.text.includes(h.guest)).map((m) => m.kind)).toEqual([
      'hold_created',
    ]);
  });
  it('sends invoice, failed payment, activation, renewal, grace and lapse notices once each', async () => {
    const x = await invoiceFixture('monthly');
    await billing.reconcile(x.staff.ctx, x.id, {
      claimId: x.claim,
      decision: 'rejected',
      amountMinor: 0,
      bankReference: '',
      receivedAt: null,
      reason: 'Synthetic reference not found',
      attest: false,
    });
    const retry = await billing.upload(x.ctx, x.id, 'SYNTHETIC-RETRY', 350000, await png());
    await billing.reconcile(x.staff.ctx, x.id, invoiceDecision(retry));
    const { sent, transport } = recorder();
    await drain(transport);
    const mine = sent.filter((m) => m.to === x.dj.email);
    expect(
      mine.some((m) => /^Lockd invoice #\d+ \(Pro monthly, J\$3,500\.00\)$/.test(m.subject)),
    ).toBe(true);
    expect(mine.find((m) => m.kind === 'SUBSCRIPTION_RECONCILED')!.text).toMatch(
      /Synthetic reference not found/,
    );
    expect(mine.find((m) => m.kind === 'SUBSCRIPTION_ACTIVATED')!.subject).toBe(
      'Pro monthly is active',
    );
    const stages: [number, string][] = [
      [3, 'renewal_due'],
      [-2, 'renewal_overdue'],
      [-8, 'pro_lapsed'],
    ];
    for (const [days, kind] of stages) {
      await moveSubscriptionEnd(x.dj.account, days);
      await notifier.query('SELECT lockd.enqueue_due_reminders()');
      await notifier.query('SELECT lockd.enqueue_due_reminders()');
      await drain(transport);
      expect(sent.filter((m) => m.to === x.dj.email && m.kind === kind)).toHaveLength(1);
    }
    expect(sent.find((m) => m.to === x.dj.email && m.kind === 'renewal_overdue')!.text).toMatch(
      /moves to Free/,
    );
  });
  it('recovers client access with an additional emailed link without revealing matches', async () => {
    const f = await fixture(),
      h = await held(f);
    await drain(recorder().transport);
    await s.requestGuestLink(h.id, { email: 'someone-else@example.test' });
    expect((await rows(h.id)).filter((r) => r.kind === 'booking_link')).toHaveLength(0);
    await s.requestGuestLink(h.id, { email: 'CLIENT@example.test' });
    const { sent, transport } = recorder();
    await drain(transport);
    const link = sent.find((m) => m.kind === 'booking_link' && m.action!.url.includes(h.id))!;
    const fresh = tokenIn(link);
    expect(fresh).not.toBe(h.guest);
    expect((await s.booking({ guest: fresh }, h.id))?.id).toBe(h.id);
    expect((await s.booking(h.ctx, h.id))?.id).toBe(h.id);
    const other = await held(await fixture());
    expect(await s.booking({ guest: fresh }, other.id)).toBeNull();
    expect(
      (await s.booking(h.ctx, h.id))!.events.some((e) => e.kind === 'CLIENT_LINK_REISSUED'),
    ).toBe(true);
  });
  it('honors the staging recipient allowlist and escapes user-entered names', async () => {
    const f = await fixture();
    await drain(recorder().transport);
    const h = await held(f);
    const { sent, transport } = recorder();
    await drain(transport, notifier, ['usetillmate.com']);
    expect(sent).toHaveLength(0);
    expect((await rows(h.id)).every((r) => r.status === 'suppressed')).toBe(true);
    const now = new Date().toISOString();
    const r = render(
      {
        id: randomUUID(),
        kind: 'booking_request',
        audience: 'dj',
        recipient: 'x@example.test',
        payload: {},
        created_at: now,
      },
      {
        booking: {
          id: h.id,
          status: 'AWAITING_SIGNATURE',
          clientName: '<script>alert(1)</script>\r\nBcc: x',
          venue: 'V',
          startsAt: now,
          endsAt: now,
          priceMinor: 100,
          depositMinor: 100,
          verifiedMinor: 0,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          graceUsed: false,
          djName: 'DJ',
          djSlug: 'dj',
          packageName: 'P',
        },
      },
      ORIGIN,
    );
    if (!r.ok) throw new Error(r.reason);
    const email = toEmail(r.message);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.subject).not.toMatch(/[\r\n]/);
  });
  it('maps Resend responses to retryable and permanent outcomes with an idempotency key', async () => {
    const calls: RequestInit[] = [];
    const reply = (status: number, body: unknown) =>
      (async (_: unknown, init?: RequestInit) => {
        calls.push(init!);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const msg = {
      id: randomUUID(),
      kind: 'DATE_CHANGE_PROPOSED',
      to: 'a@example.test',
      subject: 'S',
      text: 'T',
      html: '<p>T</p>',
    };
    const t = (f: typeof fetch) =>
      resendTransport('re_test_key', 'Lockd <bookings@lockd.test>', undefined, f);
    expect(await t(reply(200, { id: 'em_1' })).send(msg)).toEqual({
      ok: true,
      messageId: 'em_1',
    });
    expect((calls[0].headers as Record<string, string>)['Idempotency-Key']).toBe(`lockd-${msg.id}`);
    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      to: ['a@example.test'],
      tags: [{ name: 'kind', value: 'DATE_CHANGE_PROPOSED' }],
    });
    expect(await t(reply(422, { message: 'Invalid `to`' })).send(msg)).toMatchObject({
      ok: false,
      retry: false,
    });
    for (const status of [401, 429, 500, 503])
      expect(await t(reply(status, {})).send(msg)).toMatchObject({ ok: false, retry: true });
    const offline = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await t(offline).send(msg)).toMatchObject({ ok: false, retry: true });
    expect(() =>
      deliveryConfig({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'k',
        EMAIL_FROM: 'a@b.c',
        APP_ORIGIN: 'http://127.0.0.1:3100',
      }),
    ).toThrow(/https/);
    expect(() => deliveryConfig({ EMAIL_PROVIDER: 'local' })).toThrow(/local mode/);
    expect(deliveryConfig({}).transport).toBeNull();
  });
});

const grantScope = (uid: string, scope: string) =>
  admin.query(
    "INSERT INTO lockd.staff_scopes(user_id,scope,reason) VALUES($1,$2,'Synthetic test scope grant')",
    [uid, scope],
  );
const inDirectory = async (account: string) => (await s.profiles()).some((p) => p.id === account);
const failAll = () =>
  recorder(() => ({ ok: false, retry: false, error: 'Resend 422: invalid to' })).transport;

describe('Super Admin operations', () => {
  it('moderates listings: pending is bookable but unlisted, restriction hides and pauses new holds', async () => {
    const f = await fixture(),
      staff = await reviewer();
    await grantScope(staff.uid, 'listings');
    expect(await inDirectory(f.account)).toBe(false);
    expect((await s.profiles(f.profile.slug))[0]?.id).toBe(f.account);
    const existing = await held(f, 30);
    expect(
      (await ops.listings(staff.ctx, 'pending')).find((l) => l.id === f.account),
    ).toMatchObject({ email: f.email, active_bookings: 1 });
    await ops.reviewListing(staff.ctx, {
      accountId: f.account,
      decision: 'approved',
      reasonCode: 'identity_checked',
      note: 'Synthetic identity and stage name checked',
    });
    expect(await inDirectory(f.account)).toBe(true);
    await ops.reviewListing(staff.ctx, {
      accountId: f.account,
      decision: 'restricted',
      reasonCode: 'fraud_report',
      note: 'Synthetic report of deposits taken without performing',
    });
    expect(await inDirectory(f.account)).toBe(false);
    expect(await s.profiles(f.profile.slug)).toEqual([]);
    await expect(s.createHold(input(f, 40))).rejects.toThrow(/not available/);
    expect((await s.booking(existing.ctx, existing.id))?.status).toBe('AWAITING_SIGNATURE');
    const dash = (await s.dashboard({ session: f.session }))!;
    expect(dash.account.listing_state).toBe('restricted');
    expect(dash.review?.note).toMatch(/deposits taken/);
    const { sent, transport } = recorder();
    await drain(transport);
    const mail = sent.filter((m) => m.to === f.email && m.kind.startsWith('LISTING_'));
    expect(mail.map((m) => m.kind).sort()).toEqual(['LISTING_APPROVED', 'LISTING_RESTRICTED']);
    expect(mail.find((m) => m.kind === 'LISTING_RESTRICTED')!.text).toMatch(
      /Reason: Synthetic report of deposits taken/,
    );
    await ops.reviewListing(staff.ctx, {
      accountId: f.account,
      decision: 'approved',
      reasonCode: 'other',
      note: 'Synthetic investigation closed, reinstated',
    });
    await drain(transport);
    expect(sent.find((m) => m.to === f.email && m.subject.includes('active again'))).toBeTruthy();
    expect(await s.createHold(input(f, 44))).toBeTruthy();
    const history = await admin.query(
      'SELECT from_state,to_state FROM lockd.listing_reviews WHERE account_id=$1 ORDER BY id',
      [f.account],
    );
    expect(history.rows.map((r) => `${r.from_state}>${r.to_state}`)).toEqual([
      'pending>approved',
      'approved>restricted',
      'restricted>approved',
    ]);
    await expect(
      admin.query("UPDATE lockd.listing_reviews SET note='rewritten history' WHERE account_id=$1", [
        f.account,
      ]),
    ).rejects.toThrow(/Immutable/);
  });
  it('requires the listings scope, fresh MFA, independence and matching reason codes', async () => {
    const f = await fixture(),
      billingOnly = await reviewer(),
      staff = await reviewer();
    await grantScope(staff.uid, 'listings');
    const decision = {
      accountId: f.account,
      decision: 'approved',
      reasonCode: 'identity_checked',
      note: 'Synthetic eligibility review note',
    };
    await expect(ops.reviewListing(billingOnly.ctx, decision)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(ops.listings(billingOnly.ctx)).rejects.toMatchObject({ code: '42501' });
    await expect(ops.listings({ session: f.session })).rejects.toMatchObject({ code: '42501' });
    await expect(
      ops.reviewListing(staff.ctx, { ...decision, accountId: staff.account }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      ops.reviewListing(staff.ctx, { ...decision, reasonCode: 'fraud_report' }),
    ).rejects.toThrow(/Reason code/);
    await expect(
      transaction(staff.ctx, (c) =>
        c.query(
          "SELECT lockd.review_listing($1,'approved','fraud_report','Bypassing the API layer')",
          [f.account],
        ),
      ),
    ).rejects.toThrow(/Reason code does not match/);
    await admin.query(
      "UPDATE lockd.billing_staff_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [staff.uid],
    );
    await expect(ops.reviewListing(staff.ctx, decision)).rejects.toMatchObject({ code: '42501' });
    for (const t of ['staff_scopes', 'staff_events', 'listing_reviews'])
      await expect(
        transaction(staff.ctx, (c) => c.query(`SELECT * FROM lockd.${t}`)),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('shows masked delivery metadata and requeues failed messages once, with an audit record', async () => {
    const staff = await reviewer();
    await grantScope(staff.uid, 'notifications');
    await drain(recorder().transport);
    const f = await fixture(),
      h = await held(f);
    await drain(failAll());
    const { messages, counts } = await ops.notifications(staff.ctx, 'failed');
    expect(counts.failed).toBeGreaterThanOrEqual(2);
    const requestId = (await rows(h.id)).find((r) => r.kind === 'booking_request')!.id;
    const request = messages.find((m) => m.id === requestId)!;
    expect(request).toMatchObject({ requeueable: true, stage_name: 'Synthetic DJ' });
    expect(request.recipient).toMatch(/^d•••@example\.test$/);
    expect(JSON.stringify(messages)).not.toContain(f.email);
    expect(JSON.stringify(messages)).not.toContain(h.guest);
    const verify = (
      await admin.query("SELECT id FROM lockd.outbox WHERE recipient=$1 AND kind='verify'", [
        f.email,
      ])
    ).rows[0];
    expect(messages.find((m) => m.id === verify.id)?.requeueable).toBe(false);
    await expect(
      ops.requeue(staff.ctx, {
        id: verify.id,
        reasonCode: 'other',
        note: 'Synthetic attempt to resend a link',
      }),
    ).rejects.toThrow(/cannot be resent/);
    await ops.requeue(staff.ctx, {
      id: requestId,
      reasonCode: 'configuration_fixed',
      note: 'Synthetic provider configuration corrected',
    });
    await expect(
      ops.requeue(staff.ctx, {
        id: requestId,
        reasonCode: 'other',
        note: 'Synthetic second requeue',
      }),
    ).rejects.toThrow(/Only failed/);
    const { sent, transport } = recorder();
    await drain(transport);
    expect(sent.filter((m) => m.id === requestId)).toHaveLength(1);
    expect((await rows(h.id)).find((r) => r.id === requestId)?.status).toBe('sent');
    const audit = await admin.query(
      "SELECT reason_code,actor_id FROM lockd.staff_events WHERE kind='NOTIFICATION_REQUEUED' AND subject_id=$1",
      [requestId],
    );
    expect(audit.rows).toEqual([{ reason_code: 'configuration_fixed', actor_id: staff.uid }]);
    // Staff cannot requeue messages about their own account.
    await held(staff);
    await drain(failAll());
    const own = (
      await admin.query(
        "SELECT id FROM lockd.outbox WHERE account_id=$1 AND kind='booking_request' AND status='failed'",
        [staff.account],
      )
    ).rows[0];
    await expect(
      ops.requeue(staff.ctx, {
        id: own.id,
        reasonCode: 'other',
        note: 'Synthetic self-service attempt',
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(ops.notifications((await reviewer()).ctx)).rejects.toMatchObject({
      code: '42501',
    });
  });
  it('lets only Super Admins change other staff scopes, records it, and unifies the audit trail', async () => {
    const root = await reviewer(),
      target = await reviewer(),
      outsider = await fixture();
    await grantScope(root.uid, 'admin');
    await expect(ops.listings(target.ctx)).rejects.toMatchObject({ code: '42501' });
    const change = {
      userId: target.uid,
      scope: 'listings',
      grant: true,
      note: 'Synthetic onboarding of a listings reviewer',
    };
    await ops.setScope(root.ctx, change);
    await ops.setScope(root.ctx, change);
    expect(Array.isArray(await ops.listings(target.ctx))).toBe(true);
    await expect(ops.setScope(target.ctx, { ...change, userId: root.uid })).rejects.toMatchObject({
      code: '42501',
    });
    await expect(ops.setScope(root.ctx, { ...change, userId: root.uid })).rejects.toMatchObject({
      code: '42501',
    });
    const outsiderUser = (
      await admin.query('SELECT user_id FROM lockd.accounts WHERE id=$1', [outsider.account])
    ).rows[0].user_id;
    await expect(ops.setScope(root.ctx, { ...change, userId: outsiderUser })).rejects.toThrow(
      /enrolled staff/,
    );
    await ops.setScope(root.ctx, {
      ...change,
      grant: false,
      note: 'Synthetic removal of listings scope',
    });
    await expect(ops.listings(target.ctx)).rejects.toMatchObject({ code: '42501' });
    const { staff, audit } = await ops.directory(root.ctx);
    expect(staff.find((m) => m.user_id === target.uid)?.scopes).toEqual(['billing']);
    const mine = audit.filter((e) => e.actor === root.email);
    expect(mine.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['SCOPE_REVOKED', 'SCOPE_GRANTED', 'STAFF_MFA_VERIFIED']),
    );
    expect(mine.filter((e) => e.kind === 'SCOPE_GRANTED')).toHaveLength(1);
    await expect(ops.directory(target.ctx)).rejects.toMatchObject({ code: '42501' });
    expect(Array.isArray(await ops.listings(root.ctx, 'approved'))).toBe(true);
    expect((await ops.notifications(root.ctx)).counts).toBeTruthy();
  });
});

describe('Review hardening', () => {
  const reject = (claimId: string, reason: string) => ({
    claimId,
    decision: 'rejected',
    amountMinor: 0,
    bankReference: '',
    reason,
    attest: false,
  });
  it('classifies rejected evidence by the DJ decision on expired holds and after partial verification', async () => {
    const f = await fixture();
    const late = await claimed(f);
    await expiry(late.id, -30 * 3600, true);
    expect(
      await s.verify(
        { session: f.session },
        late.id,
        reject(late.claim, 'No such transfer arrived in my account'),
      ),
    ).toBe('HOLD_EXPIRED');
    const p = await signed(f, 36);
    const first = await s.proof(p.ctx, p.id, 'TEST-PART', 2750000, await png());
    await s.verify({ session: f.session }, p.id, decision(first, 1000000));
    const topUp = await s.proof(p.ctx, p.id, 'TEST-TOPUP', 1750000, await png());
    expect(
      await s.verify({ session: f.session }, p.id, reject(topUp, 'Top-up transfer not found')),
    ).toBe('PARTIAL_VERIFIED');
    const kinds = await admin.query(
      "SELECT payload->>'claimId' AS claim,kind,payload->>'decision' AS decision FROM lockd.outbox WHERE dedupe_key LIKE 'verification:%' AND payload->>'bookingId' IN ($1,$2)",
      [late.id, p.id],
    );
    const byClaim = Object.fromEntries(kinds.rows.map((r) => [r.claim, r]));
    expect(byClaim[late.claim]).toMatchObject({ kind: 'proof_rejected', decision: 'rejected' });
    expect(byClaim[first]).toMatchObject({ kind: 'partial_verified', decision: 'received' });
    expect(byClaim[topUp]).toMatchObject({ kind: 'proof_rejected', decision: 'rejected' });
    const { sent, transport } = recorder();
    await drain(transport);
    const mailFor = async (claim: string) => {
      const id = (
        await admin.query('SELECT id FROM lockd.outbox WHERE dedupe_key=$1', [
          `verification:${claim}`,
        ])
      ).rows[0].id;
      return sent.find((m) => m.id === id)!;
    };
    const lateMail = await mailFor(late.claim);
    expect(lateMail.subject).not.toMatch(/recorded a payment/);
    expect(lateMail.text).toMatch(/No such transfer arrived in my account/);
    expect(lateMail.text).toMatch(/hold has ended/i);
    const topUpMail = await mailFor(topUp);
    expect(topUpMail.subject).not.toMatch(/Part of your deposit/);
    expect(topUpMail.text).toMatch(/Top-up transfer not found/);
    expect(topUpMail.text).toMatch(/J\$10,000\.00 of the J\$27,500\.00 deposit/);
  });
  it('renews leases per message and counts only recorded attempts toward the budget', async () => {
    const f = await fixture();
    await drain(recorder().transport);
    const h = await held(f);
    const claimedRows = (await notifier.query('SELECT * FROM lockd.notifier_claim(10,10)')).rows;
    const mine = claimedRows.filter((r) => r.payload.bookingId === h.id);
    expect(mine).toHaveLength(2);
    await admin.query(
      "UPDATE lockd.outbox SET lease_until=now()-interval '1 second' WHERE payload->>'bookingId'=$1",
      [h.id],
    );
    const ctx = (
      await notifier.query('SELECT lockd.notifier_context($1,$2) AS c', [
        mine[0].id,
        mine[0].attempt,
      ])
    ).rows[0].c;
    expect(ctx.booking.id).toBe(h.id);
    expect(
      (
        await admin.query('SELECT lease_until>now() AS live FROM lockd.outbox WHERE id=$1', [
          mine[0].id,
        ])
      ).rows[0].live,
    ).toBe(true);
    expect(
      (
        await notifier.query('SELECT lockd.notifier_context($1,$2) AS c', [
          mine[0].id,
          mine[0].attempt - 1,
        ])
      ).rows[0].c,
    ).toBeNull();
    for (const r of mine)
      await notifier.query('SELECT lockd.notifier_release($1,$2)', [r.id, r.attempt]);
    expect(
      (
        await admin.query(
          "SELECT bool_and(lease_until IS NULL) AS free FROM lockd.outbox WHERE payload->>'bookingId'=$1",
          [h.id],
        )
      ).rows[0].free,
    ).toBe(true);
    // Lost lease generations never make the next transient failure terminal.
    await admin.query("UPDATE lockd.outbox SET attempts=12 WHERE payload->>'bookingId'=$1", [h.id]);
    await drain(
      recorder(() => ({ ok: false, retry: true, error: 'Resend 503: unavailable' })).transport,
    );
    for (const r of await rows(h.id)) expect(r).toMatchObject({ status: 'pending', attempts: 13 });
  });
  it('keeps link emails and their encrypted links queued when the worker cannot decrypt them', async () => {
    const f = await fixture();
    await drain(recorder().transport);
    const h = await held(f);
    const original = process.env.NOTIFICATION_KEY;
    process.env.NOTIFICATION_KEY = randomBytes(32).toString('hex');
    try {
      await drain(recorder().transport);
    } finally {
      process.env.NOTIFICATION_KEY = original;
    }
    const hold = (await rows(h.id)).find((r) => r.kind === 'hold_created')!;
    expect(hold).toMatchObject({ status: 'pending' });
    expect(hold.secret_cipher).toBeTruthy();
    expect(hold.last_error).toMatch(/decrypt/);
    await admin.query('UPDATE lockd.outbox SET next_attempt_at=now() WHERE id=$1', [hold.id]);
    const { sent, transport } = recorder();
    await drain(transport);
    expect(sent.find((m) => m.id === hold.id)!.action!.url).toBe(
      `${ORIGIN}/booking/${h.id}#${h.guest}`,
    );
  });
  it('makes billing an explicit scope that admin does not imply', async () => {
    const x = await invoiceFixture();
    const operator = await reviewer({ billing: false });
    await grantScope(operator.uid, 'admin');
    expect(await billing.staffStatus(operator.ctx)).toEqual({
      member: true,
      unlocked: true,
      billing: false,
    });
    await expect(
      billing.reconcile(operator.ctx, x.id, invoiceDecision(x.claim)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      billing.approve(operator.ctx, {
        accountId: x.dj.account,
        reason: 'Synthetic eligibility attempt by an operator',
        attest: true,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(billing.queue(operator.ctx)).rejects.toThrow(/Billing staff/);
    expect(await billing.invoice(operator.ctx, x.id)).toBeNull();
    expect(await billing.receipt(operator.ctx, x.claim)).toBeFalsy();
    await expect(
      ops.setScope(operator.ctx, {
        userId: operator.uid,
        scope: 'billing',
        grant: true,
        note: 'Synthetic attempt to self-grant billing',
      }),
    ).rejects.toMatchObject({ code: '42501' });
    const colleague = await reviewer({ billing: false });
    await ops.setScope(operator.ctx, {
      userId: colleague.uid,
      scope: 'billing',
      grant: true,
      note: 'Synthetic grant of billing to a colleague',
    });
    expect(await billing.reconcile(colleague.ctx, x.id, invoiceDecision(x.claim))).toBe('paid');
  });
  it('serializes scope changes: mutual revocation keeps one admin; disabled staff can be cleaned up', async () => {
    const a = await reviewer(),
      b = await reviewer();
    await grantScope(a.uid, 'admin');
    await grantScope(b.uid, 'admin');
    const results = await Promise.allSettled([
      ops.setScope(a.ctx, {
        userId: b.uid,
        scope: 'admin',
        grant: false,
        note: 'Synthetic concurrent revocation by A',
      }),
      ops.setScope(b.ctx, {
        userId: a.uid,
        scope: 'admin',
        grant: false,
        note: 'Synthetic concurrent revocation by B',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const remaining = await admin.query(
      "SELECT user_id FROM lockd.staff_scopes WHERE scope='admin' AND user_id IN ($1,$2)",
      [a.uid, b.uid],
    );
    expect(remaining.rowCount).toBe(1);
    const survivor = remaining.rows[0].user_id === a.uid ? a : b;
    const leaver = await reviewer();
    await grantScope(leaver.uid, 'listings');
    await admin.query('UPDATE lockd.billing_staff_members SET enabled=false WHERE user_id=$1', [
      leaver.uid,
    ]);
    await ops.setScope(survivor.ctx, {
      userId: leaver.uid,
      scope: 'listings',
      grant: false,
      note: 'Synthetic clean-up after a departure',
    });
    await expect(
      ops.setScope(survivor.ctx, {
        userId: leaver.uid,
        scope: 'listings',
        grant: true,
        note: 'Synthetic re-grant to a disabled member',
      }),
    ).rejects.toThrow(/enabled/);
    const { audit } = await ops.directory(survivor.ctx);
    expect(
      audit.find((e) => e.kind === 'SCOPE_REVOKED' && e.subject?.startsWith(leaver.email))?.subject,
    ).toBe(`${leaver.email} · listings`);
    // A staff member's own DJ self-service billing is not presented as a staff action.
    await enableBilling();
    await billing.issue(
      { session: survivor.session },
      {
        plan: 'monthly',
        billingName: 'Synthetic Staff DJ',
        billingEmail: survivor.email,
        requestId: randomUUID(),
      },
    );
    const after = await ops.directory(survivor.ctx);
    expect(after.audit.some((e) => e.actor === survivor.email && e.kind === 'INVOICE_ISSUED')).toBe(
      false,
    );
    expect(
      after.audit.some((e) => e.actor === survivor.email && e.kind === 'STAFF_MFA_VERIFIED'),
    ).toBe(true);
  });
  it('link recovery ignores failed deliveries in its cap and never matches a NULL address', async () => {
    const f = await fixture(),
      h = await held(f);
    await drain(recorder().transport);
    for (let i = 0; i < 10; i++) await s.requestGuestLink(h.id, { email: 'client@example.test' });
    await drain(failAll());
    await s.requestGuestLink(h.id, { email: 'client@example.test' });
    expect(
      (await rows(h.id)).filter((r) => r.kind === 'booking_link' && r.status === 'pending'),
    ).toHaveLength(1);
    const before = (
      await admin.query('SELECT count(*)::int n FROM lockd.guest_links WHERE booking_id=$1', [h.id])
    ).rows[0].n;
    await transaction({}, (c) =>
      c.query('SELECT lockd.request_guest_link($1,NULL,$2)', [h.id, hash(newToken())]),
    );
    expect(
      (
        await admin.query('SELECT count(*)::int n FROM lockd.guest_links WHERE booking_id=$1', [
          h.id,
        ])
      ).rows[0].n,
    ).toBe(before);
  });
  it('lets reminders run beside hold expiry without account locks, under the worker role', async () => {
    const fk = await admin.query(
      "SELECT count(*)::int n FROM pg_constraint WHERE conrelid='lockd.outbox'::regclass AND contype='f' AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='lockd.outbox'::regclass AND attname='account_id')]",
    );
    expect(fk.rows[0].n).toBe(0);
    const f = await fixture(),
      h = await held(f, 26);
    await expiry(h.id, 35 * 3600);
    const results = await Promise.all([
      notifier.query('SELECT lockd.expire_all() AS n'),
      notifier.query('SELECT lockd.enqueue_due_reminders() AS n'),
      notifier.query('SELECT lockd.expire_all() AS n'),
    ]);
    expect(results).toHaveLength(3);
    expect((await rows(h.id)).some((r) => r.kind === 'agreement_reminder')).toBe(true);
  });
});

async function supportStaff() {
  const staff = await reviewer({ billing: false });
  await grantScope(staff.uid, 'support');
  return staff;
}
const caseInput = (account: string, category = 'payment_discrepancy') => ({
  accountId: account,
  category,
  requester: 'client',
  summary: 'Client says the deposit was sent but the booking is still pending',
});

describe('Case-scoped support access', () => {
  it('opens cases only with the support scope and fresh MFA, never about the staff member', async () => {
    const f = await fixture(),
      staff = await supportStaff(),
      billingOnly = await reviewer();
    await expect(support.openCase(billingOnly.ctx, caseInput(f.account))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      support.openCase({ session: f.session }, caseInput(f.account)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(support.openCase(staff.ctx, caseInput(staff.account))).rejects.toMatchObject({
      code: '42501',
    });
    const id = await support.openCase(staff.ctx, caseInput(f.account));
    const listed = (await support.cases(staff.ctx, 'open')).find((c) => c.id === id)!;
    expect(listed).toMatchObject({ state: 'open', category: 'payment_discrepancy', linked: 0 });
    await admin.query(
      "UPDATE lockd.billing_staff_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [staff.uid],
    );
    await expect(support.viewCase(staff.ctx, id)).rejects.toMatchObject({ code: '42501' });
    // Cases about a staff member's own account are hidden from them.
    const colleague = await supportStaff();
    const aboutStaff = await support.openCase(colleague.ctx, caseInput(staff.account));
    const fresh = await supportStaff();
    await expect(support.viewCase(staff.ctx, aboutStaff)).rejects.toMatchObject({ code: '42501' });
    expect((await support.cases(fresh.ctx)).some((c) => c.id === aboutStaff)).toBe(true);
    for (const t of ['support_cases', 'support_case_bookings', 'support_case_notes'])
      await expect(
        transaction(fresh.ctx, (c) => c.query(`SELECT * FROM lockd.${t}`)),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('shows records only for linked bookings of the case DJ while access is live, without secrets', async () => {
    const f = await fixture(),
      h = await claimed(f),
      other = await held(f, 40),
      foreign = await held(await fixture()),
      staff = await supportStaff();
    const id = await support.openCase(staff.ctx, caseInput(f.account));
    let v = await support.viewCase(staff.ctx, id);
    expect(v.records).toEqual([]);
    expect(v.candidates!.map((c) => c.id).sort()).toEqual([h.id, other.id].sort());
    expect(JSON.stringify(v.candidates)).not.toContain('Synthetic Client');
    await expect(
      support.linkBooking(staff.ctx, id, {
        bookingId: foreign.id,
        reason: 'Client gave this booking reference by email',
      }),
    ).rejects.toThrow(/does not belong to this DJ/);
    await support.linkBooking(staff.ctx, id, {
      bookingId: h.id,
      reason: 'Client gave this booking reference by email',
    });
    v = await support.viewCase(staff.ctx, id);
    expect(v.records).toHaveLength(1);
    const r = v.records![0];
    expect(r.booking).toMatchObject({ id: h.id, clientEmail: 'client@example.test' });
    expect(r.claims[0]).toMatchObject({ reference: 'TEST-CLAIM', claimedMinor: 2750000 });
    expect(r.agreements[0].body).toMatch(/TEST AGREEMENT/);
    expect(r.agreements[0].signatures[0].signer).toBe('Synthetic Client');
    expect(r.deliveries.length).toBeGreaterThan(0);
    const json = JSON.stringify(v);
    for (const secret of [
      h.guest,
      hash(h.guest),
      'guest_hash',
      'request_hash',
      'secret_cipher',
      '"image"',
    ])
      expect(json).not.toContain(secret);
    expect(r.deliveries.every((d) => d.recipient.includes('•••@'))).toBe(true);
    const views = await admin.query(
      "SELECT count(*)::int n FROM lockd.staff_events WHERE kind='CASE_RECORDS_VIEWED' AND subject_id=$1",
      [id],
    );
    expect(views.rows[0].n).toBe(1);
    await admin.query(
      "UPDATE lockd.support_cases SET access_expires_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    v = await support.viewCase(staff.ctx, id);
    expect(v.case.recordsAvailable).toBe(false);
    expect(v.records).toBeUndefined();
    expect(v.candidates).toBeUndefined();
    await expect(
      support.linkBooking(staff.ctx, id, {
        bookingId: other.id,
        reason: 'Second booking mentioned by the client',
      }),
    ).rejects.toThrow(/access has ended/);
  });
  it('releases one evidence image per justified request, only for linked bookings, and audits it', async () => {
    const f = await fixture(),
      h = await claimed(f),
      elsewhere = await claimed(await fixture()),
      staff = await supportStaff();
    const id = await support.openCase(staff.ctx, caseInput(f.account));
    await support.linkBooking(staff.ctx, id, {
      bookingId: h.id,
      reason: 'Client gave this booking reference by email',
    });
    await expect(
      support.caseReceipt(staff.ctx, id, { claimId: h.claim, justification: 'short' }),
    ).rejects.toThrow();
    await expect(
      transaction(staff.ctx, (c) =>
        c.query("SELECT lockd.support_case_receipt($1,$2,'too short')", [id, h.claim]),
      ),
    ).rejects.toThrow(/Explain why/);
    await expect(
      support.caseReceipt(staff.ctx, id, {
        claimId: elsewhere.claim,
        justification: 'Checking a receipt from another DJ',
      }),
    ).rejects.toThrow(/not part of a booking linked/);
    const image = await support.caseReceipt(staff.ctx, id, {
      claimId: h.claim,
      justification: 'Compare the transfer reference with the DJ bank statement',
    });
    const stored = (await admin.query('SELECT image FROM lockd.claims WHERE id=$1', [h.claim]))
      .rows[0].image as Buffer;
    expect(Buffer.compare(image, stored)).toBe(0);
    const audit = await admin.query(
      "SELECT note,details->>'claimId' AS claim FROM lockd.staff_events WHERE kind='CASE_EVIDENCE_VIEWED' AND subject_id=$1",
      [id],
    );
    expect(audit.rows).toEqual([
      { note: 'Compare the transfer reference with the DJ bank statement', claim: h.claim },
    ]);
  });
  it('keeps notes, extensions and closure append-only and tells the DJ about non-fraud cases', async () => {
    const f = await fixture(),
      h = await held(f),
      staff = await supportStaff();
    await drain(recorder().transport);
    const id = await support.openCase(staff.ctx, caseInput(f.account, 'cancellation_refund'));
    await support.linkBooking(staff.ctx, id, {
      bookingId: h.id,
      reason: 'DJ asked for help with this booking',
    });
    await support.addNote(staff.ctx, id, {
      body: 'Called the DJ; refund sent yesterday by bank transfer',
    });
    for (let i = 0; i < 3; i++)
      await support.extendAccess(staff.ctx, id, {
        reason: 'Waiting for the client to confirm receipt',
      });
    await expect(
      support.extendAccess(staff.ctx, id, { reason: 'Waiting for the client to confirm receipt' }),
    ).rejects.toThrow(/three times/);
    await support.closeCase(staff.ctx, id, {
      outcome: 'refund_confirmed',
      note: 'Client confirmed the refund arrived in their account',
    });
    const v = await support.viewCase(staff.ctx, id);
    expect(v.case).toMatchObject({
      state: 'closed',
      outcome: 'refund_confirmed',
      recordsAvailable: false,
    });
    expect(v.notes.map((n) => n.body)).toEqual([
      'Called the DJ; refund sent yesterday by bank transfer',
    ]);
    await expect(
      support.addNote(staff.ctx, id, { body: 'A note after the case was closed' }),
    ).rejects.toThrow(/Closed cases/);
    await expect(
      support.closeCase(staff.ctx, id, { outcome: 'other', note: 'Closing the same case twice' }),
    ).rejects.toThrow(/already closed/);
    await expect(
      admin.query("UPDATE lockd.support_cases SET summary='rewritten summary text' WHERE id=$1", [
        id,
      ]),
    ).rejects.toThrow(/Immutable/);
    await expect(
      admin.query(
        "UPDATE lockd.support_case_notes SET body='rewritten note body' WHERE case_id=$1",
        [id],
      ),
    ).rejects.toThrow(/Immutable/);
    const fraud = await support.openCase(staff.ctx, caseInput(f.account, 'fraud_report'));
    await support.closeCase(staff.ctx, fraud, {
      outcome: 'no_action_needed',
      note: 'Report was not substantiated by the records',
    });
    const { sent, transport } = recorder();
    await drain(transport);
    const mine = sent.filter((m) => m.to === f.email && m.kind.startsWith('SUPPORT_CASE_'));
    expect(mine.map((m) => m.kind).sort()).toEqual(['SUPPORT_CASE_CLOSED', 'SUPPORT_CASE_OPENED']);
    expect(mine.find((m) => m.kind === 'SUPPORT_CASE_CLOSED')!.text).toMatch(/Refund confirmed/);
    const dj = await support.myCases({ session: f.session });
    expect(dj.map((c) => c.category)).toEqual(['cancellation_refund']);
    const { audit } = await ops.directory(
      await (async () => {
        const root = await reviewer({ billing: false });
        await grantScope(root.uid, 'admin');
        return root.ctx;
      })(),
    );
    expect(audit.filter((e) => e.actor === staff.email).map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'CASE_OPENED',
        'CASE_BOOKING_LINKED',
        'CASE_NOTE_ADDED',
        'CASE_ACCESS_EXTENDED',
        'CASE_CLOSED',
      ]),
    );
  });
});
