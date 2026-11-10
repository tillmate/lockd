import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, transaction, type Context } from './db';
import { credentials } from './validation';
import { attachSecret } from './notify/secret';
const scrypt = promisify(scryptCallback);
export const newToken = () => randomBytes(32).toString('hex');
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
async function matches(password: string, encoded: string) {
  const [, salt, key] = encoded.split(':');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(derived, Buffer.from(key, 'hex'));
}
export function localMode() {
  return (
    process.env.LOCKD_LOCAL_ONLY === '1' &&
    ['http://127.0.0.1:3100', 'http://localhost:3100'].includes(process.env.APP_ORIGIN ?? '')
  );
}
// Tokens are never returned in API responses. The queued email carries an encrypted copy
// committed atomically with the token; the notification worker delivers it.
export async function register(input: unknown) {
  const d = credentials.parse(input);
  const token = newToken();
  const p = await passwordHash(d.password);
  await transaction({}, async (c) => {
    const id = (
      await c.query('SELECT lockd.register_user($1,$2,$3) AS id', [d.email, p, hash(token)])
    ).rows[0].id as string | null;
    if (id) await attachSecret(c, `verify:${hash(token)}`, token);
  });
}
export async function verifyEmail(token: string) {
  return transaction(
    {},
    async (c) =>
      (await c.query('SELECT lockd.consume_email_token($1) AS ok', [hash(token)])).rows[0]
        .ok as boolean,
  );
}
export async function login(input: unknown) {
  const d = credentials.parse(input);
  const row = await transaction(
    {},
    async (c) =>
      (await c.query('SELECT * FROM lockd.auth_lookup($1)', [d.email])).rows[0] as
        { id: string; password_hash: string; verified: boolean } | undefined,
  );
  const fallback = 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);
  const valid = await matches(d.password, row?.password_hash ?? fallback);
  if (!row || !valid || !row.verified)
    throw new Error('Check your credentials and verify your email before signing in.');
  const token = newToken();
  await transaction({}, async (c) => {
    await c.query('SELECT lockd.new_session($1,$2)', [row.id, hash(token)]);
  });
  return token;
}
export async function requestReset(email: string) {
  const token = newToken();
  // Same work whether or not the account exists; attachment is a no-op without a queued row.
  await transaction({}, async (c) => {
    await c.query('SELECT lockd.request_reset($1,$2)', [email, hash(token)]);
    await attachSecret(c, `reset:${hash(token)}`, token);
  });
}
export async function resetPassword(token: string, password: string) {
  const p = await passwordHash(password);
  return transaction(
    {},
    async (c) =>
      (await c.query('SELECT lockd.consume_email_token($1,$2) AS ok', [hash(token), p])).rows[0]
        .ok as boolean,
  );
}
export async function currentUser(ctx: Context) {
  return transaction(
    ctx,
    async (c) => (await c.query('SELECT lockd.actor_id() AS id')).rows[0].id as string | null,
  );
}
