import type { PoolClient } from 'pg';
import { hash } from '../db';
import { encryptSecret, keyConfigured } from '../mfa';
// Attach a link token to the outbox row created in the same transaction. Only the hash is
// otherwise stored; the encrypted copy is erased once the message is sent or fails.
export async function attachSecret(c: PoolClient, dedupeKey: string, token: string) {
  return (
    await c.query('SELECT lockd.attach_notification_secret($1,$2,$3) AS ok', [
      dedupeKey,
      hash(token),
      encryptSecret(token, 'NOTIFICATION_KEY'),
    ])
  ).rows[0].ok as boolean;
}
export const linkEmailsConfigured = () => keyConfigured('NOTIFICATION_KEY');
