import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { migrate } from '../scripts/migrate';
import { transaction, hash, closeDatabase } from '../src/lib/db';
import { newToken, passwordHash, login, verifyEmail, resetPassword } from '../src/lib/auth';
import * as s from '../src/lib/service';
import { moneyToMinor } from '../src/lib/validation';
let admin: pg.Client, control: pg.Client;
let testName: string;
let runtimeBase: string;
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
});
afterAll(async () => {
  await closeDatabase();
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
