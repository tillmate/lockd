import { z } from 'zod';
import { transaction, type Context } from './db';
// Case-scoped support access. Authorization, record visibility, expiry and audit are enforced
// by the support_* functions in PostgreSQL; these wrappers validate shape and map rows.
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const categories = [
  'payment_discrepancy',
  'cancellation_refund',
  'date_change',
  'no_show',
  'fraud_report',
  'account_access',
  'delivery_problem',
  'other',
] as const;
export const requesters = ['client', 'dj', 'staff'] as const;
export const outcomes = [
  'resolved_between_parties',
  'refund_confirmed',
  'no_action_needed',
  'listing_restricted',
  'referred_externally',
  'duplicate',
  'other',
] as const;
export const labels: Record<string, string> = {
  payment_discrepancy: 'Payment discrepancy',
  cancellation_refund: 'Cancellation or refund',
  date_change: 'Date change',
  no_show: 'No-show',
  fraud_report: 'Fraud report',
  account_access: 'Account access',
  delivery_problem: 'Email delivery problem',
  other: 'Other',
  client: 'Client',
  dj: 'DJ',
  staff: 'Lockd staff',
  resolved_between_parties: 'Resolved between the parties',
  refund_confirmed: 'Refund confirmed',
  no_action_needed: 'No action needed',
  listing_restricted: 'Listing restricted',
  referred_externally: 'Referred elsewhere',
  duplicate: 'Duplicate case',
};
export type CaseSummary = {
  id: string;
  number: number;
  state: 'open' | 'closed';
  category: string;
  requester: string;
  stage_name: string;
  slug: string;
  opened_by: string;
  created_at: string;
  access_expires_at: string;
  linked: number;
  notes: number;
  outcome: string | null;
};
export type CaseRecord = {
  booking: {
    id: string;
    status: string;
    clientName: string;
    clientEmail: string;
    venue: string;
    startsAt: string;
    endsAt: string;
    priceMinor: number;
    depositMinor: number;
    verifiedMinor: number;
    createdAt: string;
    originalExpiresAt: string;
    expiresAt: string;
    graceUsed: boolean;
    agreementVersion: number;
    reschedulesUsed: number;
  };
  agreements: {
    id: string;
    version: number;
    body: string;
    contentHash: string;
    createdAt: string;
    signatures: { signer: string; acceptedAt: string }[];
  }[];
  claims: {
    id: string;
    reference: string;
    claimedMinor: number;
    receivedAt: string;
    onTime: boolean;
    decision: string | null;
    amountMinor: number | null;
    bankReference: string | null;
    reason: string | null;
    decidedAt: string | null;
  }[];
  amendments: {
    proposedBy: string;
    oldStart: string;
    newStart: string;
    reason: string;
    state: string;
    createdAt: string;
  }[];
  cancellations: {
    initiatedBy: string;
    decision: string;
    requestReason: string | null;
    requestedAt: string | null;
    verifiedMinor: number;
    suggestedMinor: number;
    refundMinor: number;
    reason: string;
    basis: string;
    dueAt: string | null;
    decidedAt: string;
    refundReference: string | null;
    refundedAt: string | null;
    acknowledgedAt: string | null;
  }[];
  openRequests: { reason: string; requestedAt: string }[];
  events: { kind: string; actor: string; createdAt: string }[];
  deliveries: {
    kind: string;
    audience: string;
    recipient: string;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    deliveredAt: string | null;
  }[];
};
export type CaseView = {
  case: {
    id: string;
    number: number;
    accountId: string;
    stageName: string;
    slug: string;
    djEmail: string;
    listingState: string;
    category: string;
    requester: string;
    summary: string;
    state: 'open' | 'closed';
    createdAt: string;
    openedBy: string;
    accessExpiresAt: string;
    extensions: number;
    closedAt: string | null;
    outcome: string | null;
    recordsAvailable: boolean;
  };
  notes: { body: string; author: string; createdAt: string }[];
  linked: { bookingId: string; reason: string; linkedBy: string; createdAt: string }[];
  candidates?: { id: string; startsAt: string; status: string; createdAt: string }[];
  records?: CaseRecord[];
};
export async function cases(ctx: Context, state?: string) {
  const filter = z
    .enum(['open', 'closed'])
    .optional()
    .parse(state || undefined);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT * FROM lockd.staff_support_cases($1)', [filter ?? null]))
        .rows as CaseSummary[],
  );
}
export async function openCase(ctx: Context, input: unknown) {
  const d = z
    .object({
      accountId: z.uuid(),
      category: z.enum(categories),
      requester: z.enum(requesters),
      summary: text(10, 1000),
    })
    .parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.open_support_case($1,$2,$3,$4) AS id', [
          d.accountId,
          d.category,
          d.requester,
          d.summary,
        ])
      ).rows[0].id as string,
  );
}
export async function viewCase(ctx: Context, id: string) {
  z.uuid().parse(id);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT lockd.support_case_view($1) AS v', [id])).rows[0].v as CaseView,
  );
}
export async function linkBooking(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = z.object({ bookingId: z.uuid(), reason: text(10, 1000) }).parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.link_support_booking($1,$2,$3)', [id, d.bookingId, d.reason]);
  });
}
export async function addNote(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = z.object({ body: text(10, 2000) }).parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.add_support_note($1,$2)', [id, d.body]);
  });
}
export async function extendAccess(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = z.object({ reason: text(10, 1000) }).parse(input);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT lockd.extend_support_access($1,$2) AS until', [id, d.reason])).rows[0]
        .until as string,
  );
}
export async function closeCase(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = z.object({ outcome: z.enum(outcomes), note: text(10, 1000) }).parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.close_support_case($1,$2,$3)', [id, d.outcome, d.note]);
  });
}
export async function caseReceipt(ctx: Context, id: string, input: unknown) {
  z.uuid().parse(id);
  const d = z.object({ claimId: z.uuid(), justification: text(10, 1000) }).parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.support_case_receipt($1,$2,$3) AS image', [
          id,
          d.claimId,
          d.justification,
        ])
      ).rows[0].image as Buffer,
  );
}
export async function myCases(ctx: Context) {
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT * FROM lockd.my_support_cases()')).rows as {
        number: number;
        category: string;
        state: string;
        outcome: string | null;
        created_at: string;
        closed_at: string | null;
      }[],
  );
}
