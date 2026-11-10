import { date, money } from '../format';

export type Queued = {
  id: string;
  kind: string;
  audience: 'user' | 'dj' | 'client';
  recipient: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
};
type Booking = {
  id: string;
  status: string;
  clientName: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  priceMinor: number;
  depositMinor: number;
  verifiedMinor: number;
  expiresAt: string;
  graceUsed: boolean;
  djName: string;
  djSlug: string;
  packageName: string;
};
export type NotificationContext = {
  booking?: Booking;
  event?: {
    kind: string;
    actor?: string;
    reason?: string;
    details: Record<string, unknown>;
    createdAt: string;
  };
  claim?: {
    claimedMinor: number;
    onTime: boolean;
    decision: string | null;
    amountMinor: number | null;
    reason: string | null;
  };
  decision?: {
    initiatedBy: 'client' | 'dj';
    decision: 'approved' | 'declined';
    refundMinor: number;
    verifiedMinor: number;
    dueAt: string | null;
    reason: string;
    refunded: boolean;
  };
  amendment?: { proposedBy: 'client' | 'dj'; oldStart: string; newStart: string; state: string };
  invoice?: {
    id: string;
    number: number;
    plan: string;
    amountMinor: number;
    verifiedMinor: number;
    dueAt: string;
    state: string;
    sellerName: string;
  };
  account?: {
    stageName: string;
    slug: string;
    published?: boolean;
    plan: string | null;
    endsAt: string | null;
    graceEndsAt: string | null;
    invoiceOpen: boolean;
  };
};
export type Rendered = {
  subject: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
};
export type RenderResult =
  { ok: true; message: Rendered } | { ok: false; outcome: 'skipped' | 'failed'; reason: string };

// Lifetimes match email_tokens expiry: an undelivered link is useless after it expires.
const linkLifetimeMs: Record<string, number> = { verify: 24 * 3600e3, reset: 30 * 60e3 };
const plans: Record<string, string> = {
  monthly: 'Pro monthly',
  annual: 'Pro annual',
  founding: 'Founding DJ annual',
};
const when = (v: string) => `${date(v)} (Jamaica time)`;
const DIRECT =
  'Lockd never holds booking deposits. Pay the DJ directly using the instructions in your signed agreement. Your date is confirmed only after the DJ verifies the funds actually arrived.';
const skip = (reason: string): RenderResult => ({ ok: false, outcome: 'skipped', reason });
const fail = (reason: string): RenderResult => ({ ok: false, outcome: 'failed', reason });
const ok = (message: Rendered): RenderResult => ({ ok: true, message });

export function render(
  q: Queued,
  ctx: NotificationContext,
  origin: string,
  secret?: string,
  now = Date.now(),
): RenderResult {
  const lifetime = linkLifetimeMs[q.kind];
  if (lifetime) {
    if (!secret) return fail('Link secret unavailable; ask the user to request a new link');
    if (now - new Date(q.created_at).getTime() > lifetime)
      return fail('Link expired before it could be delivered');
    return q.kind === 'verify'
      ? ok({
          subject: 'Verify your Lockd email address',
          heading: 'Confirm your email to set up Lockd.',
          paragraphs: [
            'Use the button below to verify this address. The link works once and expires in 24 hours.',
            'If you did not create a Lockd account, ignore this email.',
          ],
          action: { label: 'Verify email address', url: `${origin}/verify#${secret}` },
        })
      : ok({
          subject: 'Reset your Lockd password',
          heading: 'Choose a new password.',
          paragraphs: [
            'Someone asked to reset the password for this Lockd account. The link works once and expires in 30 minutes. Resetting signs out every existing session.',
            'If this was not you, ignore this email; your password stays the same.',
          ],
          action: { label: 'Reset password', url: `${origin}/reset#${secret}` },
        });
  }
  if (q.audience === 'user') return fail(`No template for ${q.kind}`);
  if (q.kind.startsWith('LISTING_')) return listing(q, ctx, origin);
  if (q.kind.startsWith('SUPPORT_CASE_')) return supportCase(q, ctx, origin);
  if (q.kind.startsWith('renewal_') || q.kind === 'pro_lapsed' || q.payload.invoiceId !== undefined)
    return billing(q, ctx, origin);
  const b = ctx.booking;
  if (!b) return fail('Booking context missing');
  return q.audience === 'client'
    ? client(q, ctx, b, origin, now, secret)
    : dj(q, ctx, b, origin, now);
}
const HOLD_STATES = [
  'AWAITING_SIGNATURE',
  'AWAITING_DEPOSIT',
  'VERIFICATION_PENDING',
  'PROOF_REJECTED',
  'PARTIAL_VERIFIED',
];
// Hold-phase messages are only true while the hold is still running; a message delivered late
// (retries, a requeue, delivery switched on after a backlog) must not invite payment for a
// released date.
const holdLive = (b: Booking, now: number) =>
  HOLD_STATES.includes(b.status) && Date.parse(b.expiresAt) > now;
// Evidence received before the original expiry earns one 24-hour verification window; after
// that the expiry is final and further uploads do not move it.
function deadline(b: Booking) {
  if (b.status === 'HOLD_EXPIRED')
    return 'The hold has ended, so the date is no longer reserved. If you already sent money, contact the DJ about a new date or a direct refund; Lockd does not hold or refund deposits.';
  return b.graceUsed
    ? `${b.djName} must verify the funds before ${when(b.expiresAt)}. Uploading more evidence does not extend this deadline, so upload well before then.`
    : `Upload your receipt before ${when(b.expiresAt)}. Evidence received before then gives the DJ one extra 24-hour window to verify the funds.`;
}

function client(
  q: Queued,
  ctx: NotificationContext,
  b: Booking,
  origin: string,
  now: number,
  secret?: string,
): RenderResult {
  const url = `${origin}/booking/${b.id}${secret ? `#${secret}` : ''}`;
  const open = { label: 'Open your private booking', url };
  // Verification messages describe totals as of the decision, not after later top-ups.
  const verified =
    typeof q.payload.verifiedMinor === 'number' ? q.payload.verifiedMinor : b.verifiedMinor;
  const event = `${b.packageName} with ${b.djName} on ${when(b.startsAt)} at ${b.venue}`;
  const linkNote = secret
    ? 'This private link works like a key to your booking. Keep this email and do not forward it.'
    : 'Open your booking from the private link you saved, or request a fresh link by email from the booking page.';
  switch (q.kind) {
    case 'hold_created':
      if (!holdLive(b, now)) return skip('Hold no longer active');
      return ok({
        subject: `Your date with ${b.djName} is on hold`,
        heading: 'Your date is held for 48 hours.',
        paragraphs: [
          `We are holding ${event}.`,
          `Sign the agreement and pay the deposit of ${money(b.depositMinor)} directly to the DJ before ${when(b.expiresAt)}. If you upload payment evidence before then, the DJ gets one extra 24-hour window to verify it.`,
          DIRECT,
          linkNote,
        ],
        action: open,
      });
    case 'booking_link':
      if (!secret) return fail('Link secret unavailable');
      return ok({
        subject: `Your private Lockd booking link`,
        heading: 'Here is a fresh link to your booking.',
        paragraphs: [
          `Someone asked for access to your booking: ${event}. Earlier links still work.`,
          linkNote,
          'If you did not ask for this, you can ignore it; nobody can open your booking without this link.',
        ],
        action: open,
      });
    case 'agreement_signed':
      if (!holdLive(b, now)) return skip('Hold no longer active');
      return ok({
        subject: `Agreement signed for ${b.djName}`,
        heading: 'Agreement signed. Next: pay the deposit directly.',
        paragraphs: [
          `Your signed agreement for ${event} is saved and cannot be changed.`,
          `Pay ${money(b.depositMinor)} directly to ${b.djName}. ${deadline(b)}`,
          DIRECT,
        ],
        action: open,
      });
    case 'agreement_reminder':
      if (b.status !== 'AWAITING_SIGNATURE') return skip('Agreement already signed or hold ended');
      return ok({
        subject: `Reminder: sign your agreement with ${b.djName}`,
        heading: 'Your agreement is waiting for your signature.',
        paragraphs: [
          `Your hold for ${event} ends at ${when(b.expiresAt)} unless you sign and pay the deposit before then.`,
          linkNote,
        ],
        action: open,
      });
    case 'deposit_reminder':
      if (!['AWAITING_DEPOSIT', 'PROOF_REJECTED', 'PARTIAL_VERIFIED'].includes(b.status))
        return skip('Deposit no longer outstanding');
      return ok({
        subject: `Your hold with ${b.djName} ends soon`,
        heading: 'Your hold ends within 12 hours.',
        paragraphs: [
          `The deposit for ${event} is ${money(b.depositMinor)}; ${money(b.verifiedMinor)} has been verified by the DJ so far.`,
          `If the deposit is not verified by ${when(b.expiresAt)}, the date is released. ${deadline(b)}`,
          DIRECT,
        ],
        action: open,
      });
    case 'confirmed_lockd':
      return ok({
        subject: `Confirmed: ${b.djName} on ${date(b.startsAt)}`,
        heading: 'Your date is Lockd.',
        paragraphs: [
          `${b.djName} verified receipt of ${money(verified)}. ${event} is confirmed.`,
          `Balance due under your agreement: ${money(b.priceMinor - verified)}, paid directly to the DJ.`,
        ],
        action: open,
      });
    case 'partial_verified':
      return ok({
        subject: `Part of your deposit was verified by ${b.djName}`,
        heading: 'Payment difference: deposit not yet complete.',
        paragraphs: [
          `${b.djName} verified ${money(ctx.claim?.amountMinor ?? 0)} against the evidence you uploaded${ctx.claim ? ` (you reported ${money(ctx.claim.claimedMinor)})` : ''}. Total verified: ${money(verified)} of the ${money(b.depositMinor)} deposit.`,
          `Your date is not confirmed yet. Pay the remaining ${money(Math.max(b.depositMinor - verified, 0))} directly to the DJ and upload the new receipt. ${deadline(b)}`,
          DIRECT,
        ],
        action: open,
      });
    case 'proof_rejected': {
      // Classified from the DJ's decision; the payload snapshots the status at that moment.
      const ended = q.payload.status === 'HOLD_EXPIRED' || b.status === 'HOLD_EXPIRED';
      return ok({
        subject: `${b.djName} could not verify your payment`,
        heading: 'Your payment evidence needs attention.',
        paragraphs: [
          `${b.djName} could not find the funds shown in your evidence${ctx.claim?.reason ? `. Reason given: “${ctx.claim.reason}”` : ''}.`,
          ...(verified > 0
            ? [`Verified so far: ${money(verified)} of the ${money(b.depositMinor)} deposit.`]
            : []),
          ended
            ? 'Your hold has ended, so the date is no longer reserved. If you did send money, contact the DJ directly; Lockd does not hold or refund deposits.'
            : `Your date is not confirmed. Check with your bank or the DJ, then upload corrected evidence. ${deadline(b)}`,
          DIRECT,
        ],
        action: open,
      });
    }
    case 'hold_expired':
      if (b.status !== 'HOLD_EXPIRED') return skip('Hold no longer expired');
      return ok({
        subject: `Your hold with ${b.djName} has ended`,
        heading: 'The hold ended before payment was verified.',
        paragraphs: [
          `The date for ${event} has been released. Your records and any receipts remain available from your private link.`,
          'If you already paid the DJ, contact them directly; Lockd does not hold or refund deposits.',
        ],
        action: open,
      });
    case 'late_payment_recorded':
      return ok({
        subject: `${b.djName} recorded a payment after your hold ended`,
        heading: 'Payment recorded after the hold ended.',
        paragraphs: [
          `${b.djName} verified ${money(ctx.claim?.amountMinor ?? 0)}, but the hold for ${event} had already ended, so the date is not reserved.`,
          'Contact the DJ to agree a new booking or a direct refund. Lockd does not move these funds.',
        ],
        action: open,
      });
  }
  return change(q, ctx, b, open, 'client');
}

function dj(
  q: Queued,
  ctx: NotificationContext,
  b: Booking,
  origin: string,
  now: number,
): RenderResult {
  const open = { label: 'Open booking', url: `${origin}/dashboard/bookings/${b.id}` };
  const event = `${b.clientName} · ${b.packageName} on ${when(b.startsAt)} at ${b.venue}`;
  switch (q.kind) {
    case 'booking_request':
      if (!holdLive(b, now)) return skip('Hold no longer active');
      return ok({
        subject: `New booking request: ${b.clientName}, ${date(b.startsAt)}`,
        heading: 'New booking request, date on hold.',
        paragraphs: [
          `${event}. Total ${money(b.priceMinor)}, deposit ${money(b.depositMinor)}.`,
          `The date is held for you until ${when(b.expiresAt)} while the client signs and pays you directly.`,
        ],
        action: open,
      });
    case 'agreement_signed':
      if (!holdLive(b, now)) return skip('Hold no longer active');
      return ok({
        subject: `${b.clientName} signed the agreement`,
        heading: 'Agreement signed.',
        paragraphs: [
          `${b.clientName} signed the agreement for ${event}.`,
          `The client now pays the ${money(b.depositMinor)} deposit to you directly. Nothing is confirmed until you verify the funds in your account.`,
        ],
        action: open,
      });
    case 'proof_submitted':
      if (b.status === 'HOLD_EXPIRED')
        return ok({
          subject: `Late payment evidence from ${b.clientName}`,
          heading: 'Evidence arrived after the hold ended.',
          paragraphs: [
            `${b.clientName} uploaded evidence of a ${money(ctx.claim?.claimedMinor ?? 0)} payment for ${event}, after the hold ended. The date was released, so this booking cannot be confirmed.`,
            'If the money did arrive in your account, record it in Lockd and agree a new date or a direct refund with the client.',
          ],
          action: { label: 'Review payment evidence', url: open.url },
        });
      return ok({
        subject: `Payment evidence from ${b.clientName}: verify receipt`,
        heading: 'Check your account before confirming.',
        paragraphs: [
          `${b.clientName} uploaded evidence of a ${money(ctx.claim?.claimedMinor ?? 0)} payment for ${event}.`,
          'A screenshot is not proof of funds. Confirm the money actually arrived in your bank or wallet, then record your verification in Lockd.',
          b.graceUsed
            ? `Verify before ${when(b.expiresAt)}. This includes the one-time 24-hour verification window and is final; after it the date is released.`
            : `Verify before ${when(b.expiresAt)}.`,
        ],
        action: { label: 'Review payment evidence', url: open.url },
      });
    case 'verification_reminder':
      if (b.status !== 'VERIFICATION_PENDING')
        return skip('Evidence already reviewed or hold ended');
      return ok({
        subject: `Reminder: verify ${b.clientName}'s payment`,
        heading: 'Payment evidence is waiting for you.',
        paragraphs: [
          `The hold for ${event} ends at ${when(b.expiresAt)}. Check your account and record whether the funds arrived.`,
        ],
        action: { label: 'Review payment evidence', url: open.url },
      });
    case 'refund_due':
      if (!ctx.decision || ctx.decision.refunded) return skip('Refund already recorded');
      return ok({
        subject: `Refund due to ${b.clientName}`,
        heading: 'A refund obligation is due.',
        paragraphs: [
          `You approved a ${money(ctx.decision.refundMinor)} refund for the cancelled booking (${event}), due by ${when(ctx.decision.dueAt ?? b.startsAt)}.`,
          'Send the refund directly, then record the transfer reference in Lockd. Lockd does not move funds.',
        ],
        action: open,
      });
  }
  return change(q, ctx, b, open, 'dj');
}

function change(
  q: Queued,
  ctx: NotificationContext,
  b: Booking,
  open: { label: string; url: string },
  role: 'client' | 'dj',
): RenderResult {
  const other = role === 'client' ? b.djName : b.clientName;
  const actor =
    ctx.event?.actor === 'client' ? 'client' : ctx.event?.actor === 'system' ? 'system' : 'dj';
  const byMe = actor === role;
  const who = byMe ? 'You' : role === 'client' ? b.djName : b.clientName;
  const m = ctx.amendment;
  const d = ctx.decision;
  const base = `${b.packageName} on ${when(b.startsAt)}`;
  switch (q.kind) {
    case 'DATE_CHANGE_PROPOSED':
      return ok({
        subject: byMe ? 'Date change proposed' : `${other} proposed a new date`,
        heading: 'A date change needs both signatures.',
        paragraphs: [
          `${who} proposed moving ${base} to ${m ? when(m.newStart) : 'a new date'}.`,
          'The original date stays reserved until both of you accept the exact amended agreement. The proposal expires after 48 hours.',
        ],
        action: open,
      });
    case 'DATE_CHANGE_ACCEPT':
      // The final acceptance also emits DATE_CHANGE_APPLIED, which is the message that matters.
      if (m?.state === 'applied') return skip('Superseded by the applied date change');
      return ok({
        subject: byMe ? 'You accepted the date change' : `${other} accepted the date change`,
        heading: 'Date change accepted.',
        paragraphs: [
          `${who} accepted the amended agreement${m ? ` moving the event to ${when(m.newStart)}` : ''}.`,
          'It applies once both parties accept; until then the original date stays reserved.',
        ],
        action: open,
      });
    case 'DATE_CHANGE_APPLIED':
      return ok({
        subject: `New date confirmed: ${date(b.startsAt)}`,
        heading: 'Your booking has moved.',
        paragraphs: [
          `Both parties signed. The event is now ${base} at ${b.venue}${m ? ` (previously ${when(m.oldStart)})` : ''}.`,
          'Your original agreement and verified deposit are preserved.',
        ],
        action: open,
      });
    case 'DATE_CHANGE_DECLINE':
    case 'DATE_CHANGE_WITHDRAW':
      return ok({
        subject:
          q.kind === 'DATE_CHANGE_DECLINE' ? 'Date change declined' : 'Date change withdrawn',
        heading: 'The original date stands.',
        paragraphs: [
          `${who} ${q.kind === 'DATE_CHANGE_DECLINE' ? 'declined' : 'withdrew'} the proposed date change. ${base} at ${b.venue} is unchanged.`,
        ],
        action: open,
      });
    case 'CANCELLATION_REQUESTED':
      return ok({
        subject: byMe ? 'Cancellation request sent' : `${b.clientName} asked to cancel`,
        heading: 'Cancellation requested.',
        paragraphs: [
          role === 'client'
            ? `Your request to cancel ${base} was sent to ${b.djName}. ${b.status === 'CONFIRMED_LOCKD' ? 'The date stays reserved until the DJ reviews it.' : `Your hold still ends ${when(b.expiresAt)} unless the deposit is verified before then; a pending request does not extend it.`}`
            : `${b.clientName} asked to cancel ${base}. Review the signed agreement and decide any refund of verified funds.`,
        ],
        action: open,
      });
    case 'CANCELLED': {
      const refund = d && d.refundMinor > 0;
      return ok({
        subject: `Booking cancelled: ${date(b.startsAt)}`,
        heading: 'Booking cancelled.',
        paragraphs: [
          `${base} at ${b.venue} is cancelled${d?.initiatedBy === 'dj' ? ' by the DJ' : ''} and the date released.`,
          refund
            ? `${role === 'client' ? `${b.djName} owes you` : 'You owe the client'} a direct refund of ${money(d.refundMinor)} by ${when(d.dueAt!)}. Lockd does not move funds; the DJ records the transfer and the client confirms receipt.`
            : 'No refund of verified funds was recorded for this cancellation.',
        ],
        action: open,
      });
    }
    case 'CANCELLATION_DECLINED':
      return ok({
        subject: 'Cancellation request declined',
        heading: 'The booking remains active.',
        paragraphs: [
          `${role === 'client' ? b.djName : 'You'} declined the cancellation request${d?.reason ? `: “${d.reason}”` : ''}. ${b.status === 'CONFIRMED_LOCKD' ? `${base} stays confirmed.` : `${base} is still an unconfirmed hold that ends ${when(b.expiresAt)} unless the DJ verifies the deposit before then.`}`,
        ],
        action: open,
      });
    case 'REFUND_ATTESTED':
      return ok({
        subject:
          role === 'client' ? `${b.djName} recorded your refund` : 'Refund transfer recorded',
        heading: 'Refund transfer recorded.',
        paragraphs: [
          role === 'client'
            ? `${b.djName} says a refund of ${money(d?.refundMinor ?? 0)} was sent. Check your account, then confirm receipt in Lockd only when the funds arrive.`
            : `Your refund transfer of ${money(d?.refundMinor ?? 0)} is recorded. The client will confirm when it arrives.`,
        ],
        action: open,
      });
    case 'REFUND_RECEIPT_ACKNOWLEDGED':
      return ok({
        subject: 'Refund receipt confirmed',
        heading: 'Refund received.',
        paragraphs: [
          `${role === 'client' ? 'You' : b.clientName} confirmed the ${money(d?.refundMinor ?? 0)} refund arrived. This cancellation is settled.`,
        ],
        action: open,
      });
  }
  return fail(`No template for ${q.kind}`);
}

function listing(q: Queued, ctx: NotificationContext, origin: string): RenderResult {
  const a = ctx.account;
  if (!a) return fail('Account context missing');
  const action = { label: 'Open your dashboard', url: `${origin}/dashboard` };
  const reason = String(q.payload.note ?? '');
  // Visibility also needs the DJ's own published switch; say so instead of promising it.
  const hidden =
    a.published === false
      ? ' Your public profile is switched off in your settings, so it is not visible until you turn it back on.'
      : '';
  if (q.kind === 'LISTING_APPROVED')
    return ok({
      subject:
        q.payload.from === 'restricted'
          ? 'Your Lockd booking page is active again'
          : 'Your Lockd listing is approved',
      heading:
        q.payload.from === 'restricted' ? 'Restriction lifted.' : 'Your listing is approved.',
      paragraphs: [
        (q.payload.from === 'restricted'
          ? `${a.stageName} can take new holds again through ${origin}/dj/${a.slug}.`
          : `${a.stageName} is approved for the Lockd DJ directory. Keep sharing ${origin}/dj/${a.slug} with clients.`) +
          hidden,
      ],
      action,
    });
  if (q.kind === 'LISTING_RESTRICTED')
    return ok({
      subject: 'Your Lockd booking page has been restricted',
      heading: 'New bookings are paused.',
      paragraphs: [
        `Lockd restricted ${a.stageName}'s booking page. It is hidden and cannot take new holds. Existing bookings, agreements and records remain available to you and your clients.`,
        ...(reason ? [`Reason: ${reason}`] : []),
        'If you believe this is a mistake, reply to this email with any information that helps us review it.',
      ],
      action,
    });
  return fail(`No template for ${q.kind}`);
}

const caseCategories: Record<string, string> = {
  payment_discrepancy: 'a payment discrepancy',
  cancellation_refund: 'a cancellation or refund',
  date_change: 'a date change',
  no_show: 'a reported no-show',
  account_access: 'account access',
  delivery_problem: 'an email delivery problem',
  other: 'a support request',
};
const caseOutcomes: Record<string, string> = {
  resolved_between_parties: 'Resolved between you and your client.',
  refund_confirmed: 'Refund confirmed.',
  no_action_needed: 'No action was needed.',
  listing_restricted: 'Your listing was restricted; see your dashboard for the reason.',
  referred_externally: 'Referred to the appropriate party outside Lockd.',
  duplicate: 'Closed as a duplicate of another case.',
  other: 'Closed by Lockd support.',
};
function supportCase(q: Queued, ctx: NotificationContext, origin: string): RenderResult {
  const a = ctx.account;
  if (!a) return fail('Account context missing');
  const n = q.payload.caseNumber;
  const about = caseCategories[String(q.payload.category)] ?? 'a support request';
  const action = { label: 'Open your dashboard', url: `${origin}/dashboard` };
  if (q.kind === 'SUPPORT_CASE_OPENED')
    return ok({
      subject: `Lockd support case #${n} opened`,
      heading: 'Lockd support is looking into something with you.',
      paragraphs: [
        `We opened case #${n} about ${about} on ${a.stageName}'s account. Lockd staff may review the booking records linked to this case for a limited time; every view is recorded.`,
        'Reply to this email if you have information that helps. Lockd does not move money between you and your clients.',
      ],
      action,
    });
  if (q.kind === 'SUPPORT_CASE_CLOSED')
    return ok({
      subject: `Lockd support case #${n} closed`,
      heading: 'Support case closed.',
      paragraphs: [
        `Case #${n} about ${about} is closed. ${caseOutcomes[String(q.payload.outcome)] ?? caseOutcomes.other}`,
        'Staff access to the linked booking records has ended.',
      ],
      action,
    });
  return fail(`No template for ${q.kind}`);
}

function billing(q: Queued, ctx: NotificationContext, origin: string): RenderResult {
  const i = ctx.invoice;
  const a = ctx.account;
  const url = i ? `${origin}/dashboard/billing/${i.id}` : `${origin}/dashboard/billing`;
  const action = { label: i ? 'Open invoice' : 'Open subscription', url };
  const label = i
    ? `invoice #${i.number} (${plans[i.plan] ?? i.plan}, ${money(i.amountMinor)})`
    : '';
  const term = (q.payload.endsAt as string | undefined) ?? '';
  const sameTerm = a?.endsAt && term && new Date(a.endsAt).getTime() === new Date(term).getTime();
  switch (q.kind) {
    case 'renewal_due':
      if (!sameTerm || a?.invoiceOpen) return skip('Subscription renewed or invoice already open');
      return ok({
        subject: 'Your Lockd Pro renewal is due soon',
        heading: 'Renew to keep unlimited bookings.',
        paragraphs: [
          `Your ${plans[a!.plan!] ?? 'Pro'} term ends ${when(term)}. Request a renewal invoice and pay it by bank transfer; access continues while payment is reviewed during the seven-day grace period.`,
        ],
        action,
      });
    case 'renewal_overdue':
      if (!sameTerm) return skip('Subscription renewed');
      return ok({
        subject: 'Lockd Pro payment not received: grace period started',
        heading: 'Your renewal payment has not been verified.',
        paragraphs: [
          `Your term ended ${when(term)}. Pro access continues until ${when(a!.graceEndsAt!)}. After that your account moves to Free (three active bookings); your data and existing bookings are kept.`,
          a!.plan === 'founding'
            ? 'Founding pricing is kept only if the renewal payment reaches the Lockd account within the grace period.'
            : 'Upload your bank receipt on the invoice once paid.',
        ],
        action,
      });
    case 'pro_lapsed':
      if (!sameTerm) return skip('Subscription renewed');
      return ok({
        subject: 'Your Lockd account is now on the Free plan',
        heading: 'Pro access has ended.',
        paragraphs: [
          'The seven-day grace period ended without a verified renewal payment. Your bookings and records are kept; new holds are limited to three active bookings.',
          'You can request a new invoice at any time.',
        ],
        action,
      });
  }
  const e = ctx.event;
  // Billing messages snapshot the invoice total at the event (outbox_classify), so a later
  // reconciliation cannot change what an earlier notice says.
  const invoiceVerified =
    typeof q.payload.invoiceVerifiedMinor === 'number'
      ? q.payload.invoiceVerifiedMinor
      : (i?.verifiedMinor ?? 0);
  switch (q.kind) {
    case 'INVOICE_ISSUED':
      return ok({
        subject: `Lockd ${label}`,
        heading: 'Your software invoice is ready.',
        paragraphs: [
          `${label[0].toUpperCase()}${label.slice(1)} is due ${when(i!.dueAt)}. Pay by bank transfer to ${i!.sellerName} using the instructions on the invoice, then upload your receipt.`,
          'This is a Lockd software subscription. It is separate from event deposits, which clients always pay to you directly.',
        ],
        action,
      });
    case 'SUBSCRIPTION_PROOF_SUBMITTED':
      return ok({
        subject: `Receipt received for ${label}`,
        heading: 'We received your payment evidence.',
        paragraphs: [
          'Billing staff will confirm the funds arrived in the Lockd business account. Paid access starts only after that verification, not from the upload.',
        ],
        action,
      });
    case 'SUBSCRIPTION_RECONCILED': {
      const rejected = e?.details?.decision === 'rejected';
      return ok({
        subject: rejected
          ? `Payment not verified for ${label}`
          : `Partial payment recorded for ${label}`,
        heading: rejected
          ? 'We could not find your payment.'
          : 'Payment difference on your invoice.',
        paragraphs: [
          rejected
            ? `Billing staff could not match your evidence to funds in the Lockd account${e?.reason ? `: “${e.reason}”` : ''}.`
            : `We verified ${money(Number(e?.details?.amountMinor ?? 0))}. ${money(i!.amountMinor - invoiceVerified)} remains outstanding.`,
          'Upload corrected or additional evidence on the invoice once the funds are sent.',
        ],
        action,
      });
    }
    case 'SUBSCRIPTION_ACTIVATED':
      return ok({
        subject: `${plans[i!.plan] ?? 'Pro'} is active`,
        heading: 'Payment verified. Pro is active.',
        paragraphs: [
          `We verified ${money(invoiceVerified)} for ${label}.${a?.endsAt ? ` Your term runs until ${when(a.endsAt)}.` : ''}`,
        ],
        action,
      });
    case 'PAID_REQUIRES_RESOLUTION':
      return ok({
        subject: `Billing review needed for ${label}`,
        heading: 'Payment received, plan needs review.',
        paragraphs: [
          'Your payment was verified, but it could not be applied automatically (for example, the founding cohort filled or the renewal deadline passed). Billing staff will contact you; your funds are recorded and not lost.',
        ],
        action,
      });
    case 'FOUNDING_APPROVED':
      return ok({
        subject: 'You are approved for Founding DJ pricing',
        heading: 'Founding DJ eligibility approved.',
        paragraphs: [
          'You can now request a Founding DJ annual invoice (J$25,000). Places go to the first 50 approved DJs whose payment is verified; approval alone does not reserve a place.',
        ],
        action,
      });
    case 'INVOICE_VOIDED':
      return ok({
        subject: `Lockd ${label} cancelled`,
        heading: 'Invoice cancelled.',
        paragraphs: ['This unpaid invoice was cancelled. No payment is due for it.'],
        action,
      });
  }
  return fail(`No template for ${q.kind}`);
}

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => entities[c]);
// Subject lines carry user-entered names; strip control characters before handing to a provider.
export const cleanSubject = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);
export function toEmail(m: Rendered) {
  const footer =
    'Lockd · Jamaican DJ booking software. This is a transactional message about your account or booking.';
  const text = [
    m.heading,
    '',
    ...m.paragraphs.flatMap((p) => [p, '']),
    ...(m.action ? [`${m.action.label}: ${m.action.url}`, ''] : []),
    '—',
    footer,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#fbf7ee;font-family:Inter,Arial,sans-serif;color:#14110a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td style="font-weight:800;font-size:20px;letter-spacing:-0.02em;padding-bottom:16px">Lockd</td></tr>
<tr><td style="font-size:22px;font-weight:700;line-height:1.25;padding-bottom:12px">${escape(m.heading)}</td></tr>
${m.paragraphs.map((p) => `<tr><td style="font-size:15px;line-height:1.55;padding-bottom:12px">${escape(p)}</td></tr>`).join('\n')}
${m.action ? `<tr><td style="padding:8px 0 16px"><a href="${escape(m.action.url)}" style="display:inline-block;background:#f5b83d;color:#14110a;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:999px">${escape(m.action.label)}</a></td></tr>` : ''}
<tr><td style="font-size:12px;line-height:1.5;color:#6b6457;border-top:1px solid #eee5d3;padding-top:14px">${escape(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: cleanSubject(m.subject), text, html };
}
