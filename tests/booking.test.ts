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
});
