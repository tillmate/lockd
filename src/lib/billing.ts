import { z } from 'zod';
import { hash, transaction, type Context } from './db';
import { decryptSecret, verifyTotp } from './mfa';
import { sanitizeReceipt } from './service';
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const invoiceInput = z.object({
  plan: z.enum(['monthly', 'annual', 'founding']),
  billingName: text(2, 120),
  billingEmail: z.email().max(254),
  requestId: z.uuid(),
});
export const reconcileInput = z
  .object({
    claimId: z.uuid(),
    decision: z.enum(['received', 'rejected']),
    amountMinor: z.number().int().min(0).max(3600000),
    bankReference: text(0, 100),
    receivedAt: z.iso.datetime({ offset: true }).nullable(),
    reason: text(3, 1000),
    attest: z.boolean(),
  })
  .refine(
    (d) =>
      d.decision === 'received'
        ? d.amountMinor > 0 && d.bankReference.length >= 2 && d.receivedAt && d.attest
        : d.amountMinor === 0 && d.receivedAt === null && d.bankReference === '',
    { message: 'Record actual bank receipt and timestamp, or reject with zero received' },
  );
export async function staffStatus(ctx: Context) {
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query(
          'SELECT lockd.staff_secret() IS NOT NULL AS member,lockd.billing_staff() AS unlocked',
        )
      ).rows[0] as { member: boolean; unlocked: boolean },
  );
}
export async function stepUp(ctx: Context, input: unknown) {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(input);
  const member = await transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT lockd.actor_id() AS id,lockd.staff_secret() AS secret')).rows[0],
  );
  if (!member.id || !member.secret) throw new Error('Billing staff access required');
  const allowed = await transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT lockd.rate_limit($1,6,300) AS ok', [hash(`staff-mfa:${member.id}`)]))
        .rows[0].ok,
  );
  if (!allowed) throw new Error('Too many authenticator attempts. Try again in five minutes.');
  const counter = verifyTotp(decryptSecret(member.secret), code);
  if (counter === null) throw new Error('Authenticator code is invalid or expired');
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.staff_step_up($1)', [counter]);
  });
}
export async function issue(ctx: Context, input: unknown) {
  const d = invoiceInput.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.issue_subscription_invoice($1,$2,$3,$4) AS id', [
          d.plan,
          d.billingName,
          d.billingEmail,
          d.requestId,
        ])
      ).rows[0].id as string,
  );
}
export async function upload(
  ctx: Context,
  id: string,
  reference: string,
  amount: number,
  bytes: Buffer,
) {
  z.uuid().parse(id);
  text(2, 100).parse(reference);
  z.number().int().positive().max(3600000).parse(amount);
  const clean = await sanitizeReceipt(bytes);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.submit_subscription_claim($1,$2,$3,$4,$5) AS id', [
          id,
          reference.trim(),
          amount,
          clean,
          hash(clean),
        ])
      ).rows[0].id as string,
  );
}
export async function reconcile(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = reconcileInput.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.reconcile_subscription($1,$2,$3,$4,$5,$6,$7,$8) AS state', [
          id,
          d.claimId,
          d.decision,
          d.amountMinor,
          d.bankReference,
          d.receivedAt,
          d.reason,
          d.attest,
        ])
      ).rows[0].state as string,
  );
}
export async function approve(ctx: Context, input: unknown) {
  const d = z
    .object({ accountId: z.uuid(), reason: text(10, 1000), attest: z.literal(true) })
    .parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.approve_founding($1,$2,$3)', [d.accountId, d.reason, d.attest]);
  });
}
export async function voidInvoice(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = z.object({ reason: text(3, 1000) }).parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.void_subscription_invoice($1,$2)', [id, d.reason]);
  });
}
export type Invoice = {
  id: string;
  number: string;
  account_id: string;
  plan: string;
  amount_minor: number;
  billing_name: string;
  billing_email: string;
  seller_name: string;
  instructions: string;
  created_at: string;
  due_at: string;
  renewal_for: string | null;
  state: string;
  verified_minor: number;
};
export type BillingClaim = {
  id: string;
  reference: string;
  claimed_minor: number;
  created_at: string;
  decision: string | null;
  amount_minor: number | null;
  reason: string | null;
};
export type InvoiceDetail = Invoice & {
  claims: BillingClaim[];
  events: { kind: string; reason: string; created_at: string }[];
};
export type BillingHome = {
  configured: boolean;
  pro: boolean;
  subscription: { plan: string; starts_at: string; ends_at: string; grace_ends_at: string } | null;
  approved: boolean;
  seat: number | null;
  invoices: Invoice[];
};
export async function home(ctx: Context): Promise<BillingHome | null> {
  return transaction(ctx, async (c) => {
    const account = (await c.query('SELECT id FROM lockd.accounts')).rows[0];
    if (!account) return null;
    const meta = (
      await c.query('SELECT lockd.billing_configured() AS configured,lockd.pro_access($1) AS pro', [
        account.id,
      ])
    ).rows[0];
    const subscription =
      (
        await c.query(
          "SELECT plan,starts_at,ends_at,ends_at+interval '7 days' AS grace_ends_at FROM lockd.subscriptions WHERE account_id=$1",
          [account.id],
        )
      ).rows[0] ?? null;
    const approved = !!(
      await c.query('SELECT 1 FROM lockd.founding_approvals WHERE account_id=$1', [account.id])
    ).rowCount;
    const seat =
      (
        await c.query('SELECT seat FROM lockd.founding_memberships WHERE account_id=$1', [
          account.id,
        ])
      ).rows[0]?.seat ?? null;
    const invoices = (
      await c.query(
        'SELECT * FROM lockd.subscription_invoices WHERE account_id=$1 ORDER BY number DESC',
        [account.id],
      )
    ).rows;
    return { ...meta, subscription, approved, seat, invoices };
  });
}
export async function invoice(ctx: Context, id: string): Promise<InvoiceDetail | null> {
  z.uuid().parse(id);
  return transaction(ctx, async (c) => {
    const i = (await c.query('SELECT * FROM lockd.subscription_invoices WHERE id=$1', [id]))
      .rows[0];
    if (!i) return null;
    const claims = (
      await c.query(
        'SELECT c.id,c.reference,c.claimed_minor,c.created_at,p.decision,p.amount_minor,p.reason FROM lockd.subscription_claims c LEFT JOIN lockd.subscription_payments p ON p.claim_id=c.id WHERE c.invoice_id=$1 ORDER BY c.created_at',
        [id],
      )
    ).rows;
    const events = (
      await c.query(
        'SELECT kind,reason,created_at FROM lockd.billing_events WHERE invoice_id=$1 ORDER BY id',
        [id],
      )
    ).rows;
    return { ...i, claims, events };
  });
}
export async function receipt(ctx: Context, id: string) {
  z.uuid().parse(id);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT image FROM lockd.subscription_claims WHERE id=$1', [id])).rows[0] as
        { image: Buffer } | undefined,
  );
}
export async function queue(ctx: Context) {
  return transaction(ctx, async (c) => {
    const allowed = (await c.query('SELECT lockd.billing_staff() AS ok')).rows[0].ok;
    if (!allowed) throw new Error('Billing staff with fresh MFA required');
    const invoices = (
      await c.query('SELECT * FROM lockd.subscription_invoices ORDER BY number DESC LIMIT 200')
    ).rows as Invoice[];
    const accounts = (await c.query('SELECT * FROM lockd.billing_accounts()')).rows as {
      id: string;
      stage_name: string;
      parish: string;
      approved: boolean;
    }[];
    const totals = (
      await c.query(
        "SELECT coalesce(sum(verified_minor) FILTER(WHERE state='paid'),0)::bigint AS settled,coalesce(sum(verified_minor) FILTER(WHERE state<>'paid'),0)::bigint AS unapplied FROM lockd.subscription_invoices",
      )
    ).rows[0] as { settled: string; unapplied: string };
    const seats = (await c.query('SELECT count(*)::int AS count FROM lockd.founding_memberships'))
      .rows[0].count as number;
    return { invoices, accounts, totals, seats };
  });
}
