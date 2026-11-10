import type pg from 'pg';
import { decryptSecret } from '../mfa';
import { render, toEmail, type NotificationContext, type Queued } from './templates';
import type { DeliveryConfig } from './transport';

// Seconds before attempt n+1. The database marks a message failed after 8 recorded attempts,
// about 22 hours after the first; claims that never reached a send do not count.
const BACKOFF = [60, 300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
export const backoff = (attempt: number) =>
  BACKOFF[Math.min(Math.max(attempt, 1), BACKOFF.length) - 1];
export type DispatchSummary = { sent: number; retry: number; failed: number; skipped: number };
type Claimed = Queued & { secret_cipher: string | null; attempt: number };

// Claims a leased batch, renews each message's lease as work starts on it, renders it from
// current database state and records every outcome. Only the worker database role can call these
// functions. `stopping` hands unstarted messages back without recording an attempt.
export async function dispatch(
  pool: pg.Pool,
  config: DeliveryConfig,
  origin: string,
  batch = 10,
  stopping: () => boolean = () => false,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  if (!config.transport) return summary;
  const transport = config.transport;
  const rows = (await pool.query('SELECT * FROM lockd.notifier_claim($1,120)', [batch]))
    .rows as Claimed[];
  for (const row of rows) {
    if (stopping()) {
      await pool.query('SELECT lockd.notifier_release($1,$2)', [row.id, row.attempt]);
      continue;
    }
    const finish = async (
      outcome: 'sent' | 'retry' | 'failed' | 'skipped',
      error: string | null,
      messageId: string | null = null,
    ) => {
      const state = (
        await pool.query('SELECT lockd.notifier_finish($1,$2,$3,$4,$5,$6,$7) AS s', [
          row.id,
          row.attempt,
          outcome,
          transport.name,
          messageId,
          error,
          backoff(row.attempt),
        ])
      ).rows[0].s as string;
      if (state === 'failed') summary.failed++;
      else if (state === 'pending') summary.retry++;
      else if (state === 'sent') summary.sent++;
      else if (state === 'suppressed') summary.skipped++;
    };
    try {
      const ctx = (
        await pool.query('SELECT lockd.notifier_context($1,$2) AS c', [row.id, row.attempt])
      ).rows[0].c as NotificationContext | null;
      if (!ctx) continue; // Another worker re-claimed it after our lease lapsed.
      const domain = row.recipient.split('@')[1] ?? '';
      if (config.allowedDomains && !config.allowedDomains.includes(domain)) {
        await finish('skipped', `Recipient domain not in EMAIL_ALLOWED_DOMAINS`);
        continue;
      }
      let secret: string | undefined;
      if (row.secret_cipher) {
        try {
          secret = decryptSecret(row.secret_cipher, 'NOTIFICATION_KEY');
        } catch {
          // A missing or mismatched key is a configuration fault: keep the message and its
          // encrypted link queued so a configuration fix resumes delivery.
          await finish('retry', 'Link secret could not be decrypted with NOTIFICATION_KEY');
          continue;
        }
      }
      const result = render(row, ctx, origin, secret);
      if (!result.ok) {
        await finish(result.outcome, result.reason);
        continue;
      }
      const email = toEmail(result.message);
      const sent = await transport.send({
        id: row.id,
        kind: row.kind,
        to: row.recipient,
        ...email,
        action: result.message.action,
      });
      if (sent.ok) await finish('sent', null, sent.messageId);
      else await finish(sent.retry ? 'retry' : 'failed', sent.error);
    } catch (e) {
      await finish('retry', `Dispatcher error: ${(e as Error).message}`).catch(() => {
        /* Lease expiry makes the row claimable again; no attempt budget is consumed. */
      });
    }
  }
  return summary;
}
export async function enqueueReminders(pool: pg.Pool) {
  return (await pool.query('SELECT lockd.enqueue_due_reminders() AS n')).rows[0].n as number;
}
export async function expireHolds(pool: pg.Pool) {
  return (await pool.query('SELECT lockd.expire_all() AS n')).rows[0].n as number;
}
