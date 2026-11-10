import { z } from 'zod';
import sharp from 'sharp';
import { hash, transaction, type Context } from './db';
import { newToken } from './auth';
import { attachSecret, linkEmailsConfigured } from './notify/secret';
import {
  blockInput,
  holdInput,
  onboarding,
  signatureInput,
  verificationInput,
  profileUpdate,
  changeProposal,
  changeResponse,
  cancellationRequest,
  cancellationDecision,
  refundRecord,
  refundAcknowledgement,
} from './validation';

export type Package = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  depositMinor: number;
  durationMinutes: number;
};
export type Profile = {
  id: string;
  slug: string;
  stageName: string;
  parish: string;
  bio: string;
  packages: Package[];
};
export async function profiles(slug?: string): Promise<Profile[]> {
  return transaction(
    {},
    async (c) =>
      (await c.query('SELECT lockd.public_profiles($1) AS data', [slug ?? null])).rows[0].data,
  );
}
export async function onboard(ctx: Context, input: unknown) {
  const d = onboarding.parse(input);
  return transaction(
    ctx,
    async (c) => (await c.query('SELECT lockd.onboard($1) AS id', [d])).rows[0].id as string,
  );
}
export async function createHold(input: unknown) {
  const d = holdInput.parse(input);
  const { accessToken, ...body } = d;
  return transaction({}, async (c) => {
    const id = (
      await c.query('SELECT lockd.create_hold($1,$2,$3) AS id', [
        body,
        hash(accessToken),
        hash(JSON.stringify(body)),
      ])
    ).rows[0].id as string;
    // The hold email includes the private link only when link encryption is configured;
    // the browser always receives it directly. Retries are no-ops once attached.
    if (linkEmailsConfigured()) await attachSecret(c, `hold:${id}:client`, accessToken);
    return id;
  });
}
// Emails an additional private link to the booking's client address. The response never
// reveals whether the booking or address matched; existing links keep working.
export async function requestGuestLink(bid: string, input: unknown) {
  z.uuid().parse(bid);
  const { email } = z.object({ email: z.email().max(254) }).parse(input);
  if (!linkEmailsConfigured()) throw new Error('Link recovery email is not configured');
  const token = newToken();
  await transaction({}, async (c) => {
    await c.query('SELECT lockd.request_guest_link($1,$2,$3)', [bid, email, hash(token)]);
    await attachSecret(c, `link:${hash(token)}`, token);
  });
}
export async function expire() {
  return transaction(
    {},
    async (c) => (await c.query('SELECT lockd.expire_all() AS count')).rows[0].count as number,
  );
}
export async function sign(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = signatureInput.parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.sign_agreement($1,$2,$3,$4)', [
      bid,
      d.agreementId,
      d.contentHash,
      d.signer,
    ]);
  });
}
export async function proof(
  ctx: Context,
  bid: string,
  reference: string,
  amount: number,
  bytes: Buffer,
) {
  z.uuid().parse(bid);
  z.string().trim().min(2).max(100).parse(reference);
  z.number().int().positive().max(100000000).parse(amount);
  const clean = await sanitizeReceipt(bytes);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.submit_proof($1,$2,$3,$4,$5) AS id', [
          bid,
          reference.trim(),
          amount,
          clean,
          hash(clean),
        ])
      ).rows[0].id as string,
  );
}
export async function sanitizeReceipt(bytes: Buffer) {
  if (bytes.length > 5 * 1024 * 1024 || bytes.length < 20)
    throw new Error('Receipt must be a PNG or JPEG image, up to 5 MB');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('Receipt must contain a PNG or JPEG image');
  const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
  const meta = await image.metadata();
  if (!['png', 'jpeg'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1)
    throw new Error('Upload a single PNG or JPEG receipt');
  const clean = await image.rotate().png().toBuffer();
  if (clean.length > 5 * 1024 * 1024) throw new Error('Processed receipt exceeds 5 MB');
  return clean;
}
export async function verify(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = verificationInput.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.verify_payment($1,$2,$3,$4,$5,$6,$7) AS status', [
          bid,
          d.claimId,
          d.decision,
          d.amountMinor,
          d.bankReference,
          d.reason,
          d.attest,
        ])
      ).rows[0].status as string,
  );
}
export async function booking(ctx: Context, bid: string) {
  z.uuid().parse(bid);
  // Read authorization before expiry to avoid unauthenticated callers locking unrelated tenants.
  const account = await transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT account_id FROM lockd.bookings WHERE id=$1', [bid])).rows[0]
        ?.account_id as string | undefined,
  );
  if (!account) return null;
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.expire_account($1)', [account]);
  });
  return transaction(ctx, async (c) => {
    const b = (
      await c.query(
        'SELECT id,account_id,package_id,client_name,client_email,venue,starts_at,ends_at,price_minor,deposit_minor,status,original_expires_at,expires_at,grace_used,verified_minor,agreement_version,reschedules_used FROM lockd.bookings WHERE id=$1',
        [bid],
      )
    ).rows[0];
    if (!b) return null;
    const agreements = (
      await c.query(
        'SELECT a.*,s.signer,s.accepted_at FROM lockd.agreements a LEFT JOIN lockd.signatures s ON s.agreement_id=a.id WHERE a.booking_id=$1 ORDER BY a.version',
        [bid],
      )
    ).rows;
    const agreement = agreements.find((a) => a.version === b.agreement_version);
    const amendments = (
      await c.query(
        "SELECT m.id,m.agreement_id,m.proposed_by,m.old_start,m.new_start,m.new_end,m.reason,CASE WHEN m.state='pending' AND m.expires_at<=clock_timestamp() THEN 'expired' ELSE m.state END AS state,m.expires_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('party',x.party,'signer',x.signer,'created_at',x.created_at)) FROM lockd.amendment_acceptances x WHERE x.amendment_id=m.id),'[]'::jsonb) AS acceptances FROM lockd.amendments m WHERE m.booking_id=$1 ORDER BY m.created_at",
        [bid],
      )
    ).rows;
    const cancellations = (
      await c.query(
        'SELECT q.id,q.reason,q.created_at,d.decision FROM lockd.cancellation_requests q LEFT JOIN lockd.cancellation_decisions d ON d.request_id=q.id WHERE q.booking_id=$1 ORDER BY q.created_at',
        [bid],
      )
    ).rows;
    const decisions = (
      await c.query(
        'SELECT d.id,d.request_id,d.initiated_by,d.decision,d.verified_minor,d.suggested_minor,d.refund_minor,d.reason,d.basis,d.due_at,d.created_at,r.reference AS refund_reference,r.created_at AS refunded_at,a.created_at AS acknowledged_at FROM lockd.cancellation_decisions d LEFT JOIN lockd.refund_records r ON r.decision_id=d.id LEFT JOIN lockd.refund_acknowledgements a ON a.decision_id=d.id WHERE d.booking_id=$1 ORDER BY d.created_at',
        [bid],
      )
    ).rows;
    const claims = (
      await c.query(
        'SELECT c.id,c.reference,c.claimed_minor,c.received_at,c.on_time,v.decision,v.amount_minor,v.reason FROM lockd.claims c LEFT JOIN lockd.verifications v ON v.claim_id=c.id WHERE c.booking_id=$1 ORDER BY c.received_at',
        [bid],
      )
    ).rows;
    const events = (
      await c.query(
        'SELECT kind,details,created_at FROM lockd.booking_events WHERE booking_id=$1 ORDER BY id',
        [bid],
      )
    ).rows;
    return {
      ...b,
      agreement,
      agreements,
      amendments,
      cancellations,
      decisions,
      claims,
      events,
    } as Booking;
  });
}
export type Booking = {
  id: string;
  account_id: string;
  package_id: string;
  client_name: string;
  client_email: string;
  venue: string;
  starts_at: Date | string;
  ends_at: Date | string;
  price_minor: number;
  deposit_minor: number;
  status: string;
  original_expires_at: Date | string;
  expires_at: Date | string;
  grace_used: boolean;
  verified_minor: number;
  reschedules_used: number;
  agreement_version: number;
  agreements: Agreement[];
  amendments: {
    id: string;
    agreement_id: string;
    proposed_by: string;
    old_start: string;
    new_start: string;
    new_end: string;
    reason: string;
    state: string;
    expires_at: string;
    acceptances: { party: string; signer: string; created_at: string }[];
  }[];
  cancellations: { id: string; reason: string; created_at: string; decision: string | null }[];
  decisions: {
    id: string;
    request_id: string | null;
    initiated_by: string;
    decision: string;
    verified_minor: number;
    suggested_minor: number;
    refund_minor: number;
    reason: string;
    basis: string;
    due_at: string | null;
    created_at: string;
    refund_reference: string | null;
    refunded_at: string | null;
    acknowledged_at: string | null;
  }[];
  agreement: Agreement;
  claims: {
    id: string;
    reference: string;
    claimed_minor: number;
    received_at: Date | string;
    on_time: boolean;
    decision: string | null;
    amount_minor: number | null;
    reason: string | null;
  }[];
  events: { kind: string; details: Record<string, unknown>; created_at: Date | string }[];
};
export type Agreement = {
  id: string;
  version: number;
  body: string;
  content_hash: string;
  payment_instructions: string;
  signer: string | null;
  accepted_at: Date | string | null;
};
export async function dashboard(ctx: Context) {
  return transaction(ctx, async (c) => {
    const account = (await c.query('SELECT id,slug,stage_name,parish FROM lockd.accounts'))
      .rows[0] as { id: string; slug: string; stage_name: string; parish: string } | undefined;
    if (!account) return null;
    await c.query('SELECT lockd.expire_account($1)', [account.id]);
    const bookings = (
      await c.query(
        'SELECT id,client_name,starts_at,ends_at,deposit_minor,verified_minor,status FROM lockd.bookings ORDER BY starts_at',
      )
    ).rows as Pick<
      Booking,
      'id' | 'client_name' | 'starts_at' | 'ends_at' | 'deposit_minor' | 'verified_minor' | 'status'
    >[];
    const blocks = (
      await c.query(
        'SELECT id,lower(slot) AS starts_at,upper(slot) AS ends_at,reason FROM lockd.occupied_slots WHERE booking_id IS NULL ORDER BY lower(slot)',
      )
    ).rows as { id: string; starts_at: string; ends_at: string; reason: string }[];
    const pro = (await c.query('SELECT lockd.pro_access($1) AS pro', [account.id])).rows[0]
      .pro as boolean;
    return { account, bookings, blocks, pro };
  });
}
export async function receipt(ctx: Context, cid: string) {
  z.uuid().parse(cid);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT image,mime FROM lockd.claims WHERE id=$1', [cid])).rows[0] as
        { image: Buffer; mime: string } | undefined,
  );
}
export async function block(ctx: Context, input: unknown) {
  const d = blockInput.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT lockd.block_time($1,$2,$3) AS id', [d.startsAt, d.endsAt, d.reason]))
        .rows[0].id as string,
  );
}
export async function unblock(ctx: Context, id: string) {
  z.uuid().parse(id);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.unblock_time($1)', [id]);
  });
}
export async function complete(ctx: Context, id: string) {
  z.uuid().parse(id);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.complete_booking($1)', [id]);
  });
}
export type Settings = z.infer<typeof profileUpdate>;
export async function settings(ctx: Context): Promise<Settings | null> {
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query(
          `SELECT a.slug,a.stage_name AS "stageName",a.parish,a.bio,a.deposit_instructions AS "depositInstructions",a.agreement_template AS agreement,a.revision,a.published,p.id AS "packageId",p.name AS "packageName",p.description,p.price_minor AS "priceMinor",p.deposit_minor AS "depositMinor",p.duration_minutes AS "durationMinutes",p.buffer_before AS "bufferBefore",p.buffer_after AS "bufferAfter" FROM lockd.accounts a JOIN lockd.packages p ON p.account_id=a.id ORDER BY p.id LIMIT 1`,
        )
      ).rows[0] ?? null,
  );
}
export async function updateProfile(ctx: Context, input: unknown) {
  const d = profileUpdate.parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.update_profile($1)', [d]);
  });
}
export async function proposeChange(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = changeProposal.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.propose_amendment($1,$2,$3,$4) AS id', [
          bid,
          d.party,
          d.startsAt,
          d.reason,
        ])
      ).rows[0].id as string,
  );
}
export async function respondChange(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = changeResponse.parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.respond_amendment($1,$2,$3,$4,$5,$6)', [
      bid,
      d.amendmentId,
      d.party,
      d.action,
      d.contentHash,
      d.signer,
    ]);
  });
}
export async function requestCancellation(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = cancellationRequest.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT lockd.request_cancellation($1,$2) AS id', [bid, d.reason])).rows[0]
        .id as string,
  );
}
export async function decideCancellation(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = cancellationDecision.parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.decide_cancellation($1,$2,$3,$4,$5,$6,$7)', [
      bid,
      d.requestId,
      d.approve,
      d.refundMinor,
      d.reason,
      d.basis,
      d.attest,
    ]);
  });
}
export async function recordRefund(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = refundRecord.parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.record_refund($1,$2,$3,$4)', [
      bid,
      d.decisionId,
      d.reference,
      d.attest,
    ]);
  });
}
export async function acknowledgeRefund(ctx: Context, bid: string, input: unknown) {
  z.uuid().parse(bid);
  const d = refundAcknowledgement.parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.acknowledge_refund($1,$2,$3)', [bid, d.decisionId, d.attest]);
  });
}
