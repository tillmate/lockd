import type pg from 'pg';
import { decryptSecret } from '../mfa';
import { render, toEmail, type NotificationContext, type Queued } from './templates';
import type { DeliveryConfig } from './transport';

// Seconds before attempt n+1; after 8 attempts (~1.5 days) the database marks the message failed.
const BACKOFF = [60, 300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
export const backoff = (attempt: number) =>
  BACKOFF[Math.min(Math.max(attempt, 1), BACKOFF.length) - 1];
export type DispatchSummary = { sent: number; retry: number; failed: number; skipped: number };
type Claimed = Queued & { secret_cipher: string | null; attempt: number };

// Claims a leased batch, renders it from current database state and records every outcome.
// Only the notifier database role can call these functions.
export async function dispatch(
  pool: pg.Pool,
  config: DeliveryConfig,
  origin: string,
  batch = 20,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  if (!config.transport) return summary;
  const transport = config.transport;
  const rows = (await pool.query('SELECT * FROM lockd.notifier_claim($1,120)', [batch]))
    .rows as Claimed[];
  for (const row of rows) {
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
      const ctx = (await pool.query('SELECT lockd.notifier_context($1) AS c', [row.id])).rows[0]
        .c as NotificationContext | null;
      if (!ctx) continue; // Lease lost to another worker.
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
          await finish('failed', 'Link secret could not be decrypted with NOTIFICATION_KEY');
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
        /* Lease expiry will make the row claimable again. */
      });
    }
  }
  return summary;
}
export async function enqueueReminders(pool: pg.Pool) {
  return (await pool.query('SELECT lockd.enqueue_due_reminders() AS n')).rows[0].n as number;
}
