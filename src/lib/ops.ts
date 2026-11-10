import { z } from 'zod';
import { transaction, type Context } from './db';
// Super Admin operations. Every function is enforced in the database (staff_can + fresh MFA);
// these wrappers only validate shape and map rows.
const note = z.string().trim().min(10).max(1000);
export const scopes = ['billing', 'listings', 'support', 'notifications', 'admin'] as const;
export type Scope = (typeof scopes)[number];
export const listingReason = {
  approved: ['identity_checked', 'profile_complete', 'other'],
  restricted: [
    'impersonation',
    'fraud_report',
    'prohibited_content',
    'payment_dispute',
    'incomplete_profile',
    'other',
  ],
} as const;
export const requeueReasons = [
  'provider_outage',
  'configuration_fixed',
  'recipient_corrected',
  'other',
] as const;
export async function staffAccess(ctx: Context) {
  return transaction(ctx, async (c) => {
    const r = (
      await c.query(
        'SELECT lockd.actor_id() AS self,lockd.staff_secret() IS NOT NULL AS member,lockd.staff_fresh() AS unlocked,lockd.staff_scope_list() AS scopes',
      )
    ).rows[0] as { self: string | null; member: boolean; unlocked: boolean; scopes: Scope[] };
    // Mirrors staff_can(): admin implies the operational scopes, never billing.
    const has = (s: Scope) =>
      r.unlocked && (r.scopes.includes(s) || (s !== 'billing' && r.scopes.includes('admin')));
    return { ...r, has };
  });
}
export type Listing = {
  id: string;
  slug: string;
  stage_name: string;
  parish: string;
  bio: string;
  published: boolean;
  listing_state: 'pending' | 'approved' | 'restricted';
  created_at: string;
  email: string;
  email_verified: boolean;
  active_bookings: number;
  total_bookings: number;
  last_review: { toState: string; reasonCode: string; note: string; createdAt: string } | null;
};
export async function listings(ctx: Context, state?: string) {
  const filter = z
    .enum(['pending', 'approved', 'restricted'])
    .optional()
    .parse(state || undefined);
  return transaction(
    ctx,
    async (c) =>
      (await c.query('SELECT * FROM lockd.staff_listings($1)', [filter ?? null])).rows as Listing[],
  );
}
export const listingDecision = z
  .object({
    accountId: z.uuid(),
    decision: z.enum(['approved', 'restricted']),
    reasonCode: z.string(),
    note,
  })
  .refine((d) => (listingReason[d.decision] as readonly string[]).includes(d.reasonCode), {
    message: 'Reason code does not match the decision',
  });
export async function reviewListing(ctx: Context, input: unknown) {
  const d = listingDecision.parse(input);
  return transaction(
    ctx,
    async (c) =>
      (
        await c.query('SELECT lockd.review_listing($1,$2,$3,$4) AS state', [
          d.accountId,
          d.decision,
          d.reasonCode,
          d.note,
        ])
      ).rows[0].state as string,
  );
}
export type QueuedMessage = {
  id: string;
  kind: string;
  audience: string;
  recipient: string;
  status: string;
  attempts: number;
  last_error: string | null;
  provider: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string;
  stage_name: string | null;
  requeueable: boolean;
};
export async function notifications(ctx: Context, status?: string) {
  const filter = z
    .enum(['pending', 'sent', 'failed', 'suppressed'])
    .optional()
    .parse(status || undefined);
  return transaction(ctx, async (c) => ({
    counts: (await c.query('SELECT lockd.staff_notification_counts() AS c')).rows[0].c as {
      pending: number;
      failed: number;
      sent24h: number;
      oldestPending: string | null;
    },
    messages: (await c.query('SELECT * FROM lockd.staff_notifications($1)', [filter ?? null]))
      .rows as QueuedMessage[],
  }));
}
export async function requeue(ctx: Context, input: unknown) {
  const d = z.object({ id: z.uuid(), reasonCode: z.enum(requeueReasons), note }).parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.requeue_notification($1,$2,$3)', [d.id, d.reasonCode, d.note]);
  });
}
export async function directory(ctx: Context) {
  return transaction(ctx, async (c) => ({
    staff: (await c.query('SELECT * FROM lockd.staff_directory()')).rows as {
      user_id: string;
      email: string;
      enabled: boolean;
      scopes: Scope[];
      created_at: string;
    }[],
    audit: (await c.query('SELECT * FROM lockd.staff_audit(200)')).rows as {
      at: string;
      actor: string;
      scope: string;
      kind: string;
      subject: string | null;
      stage_name: string | null;
      reason_code: string | null;
      note: string;
    }[],
  }));
}
export async function setScope(ctx: Context, input: unknown) {
  const d = z
    .object({ userId: z.uuid(), scope: z.enum(scopes), grant: z.boolean(), note })
    .parse(input);
  await transaction(ctx, async (c) => {
    await c.query('SELECT lockd.set_staff_scope($1,$2,$3,$4)', [
      d.userId,
      d.scope,
      d.grant,
      d.note,
    ]);
  });
}
