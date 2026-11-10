import { PUBLIC_DEMO_STAFF_TOTP, stagingMode } from './env'; // Also applies staging defaults first.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(secret: string) {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of secret.replace(/=+$/, '').toUpperCase()) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw new Error('Invalid authenticator secret');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
// RFC 6238: 30-second time steps, HMAC-SHA1, dynamic truncation. Test vectors cover 64-bit time.
export function totp(secret: string, seconds = Date.now() / 1000, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const mac = createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function verifyTotp(secret: string, code: string, seconds = Date.now() / 1000) {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(seconds / 30);
  for (const drift of [0, -1, 1]) {
    if (timingSafeEqual(Buffer.from(totp(secret, (counter + drift) * 30)), Buffer.from(code)))
      return counter + drift;
  }
  return null;
}
// Staging demo only: the published demo Super Admin authenticator's current code, shown on the
// unlock screen so reviewers need no authenticator app. Verification itself is unchanged.
export const demoStaffCode = () => (stagingMode() ? totp(PUBLIC_DEMO_STAFF_TOTP) : undefined);
// Separate 256-bit keys per purpose: staff authenticator secrets and queued email link tokens.
export type KeyName = 'STAFF_MFA_KEY' | 'NOTIFICATION_KEY';
// 64 hex characters (db:local) or base64 of exactly 32 bytes (hosting-generated secrets).
function keyBytes(name: KeyName) {
  const value = process.env[name] ?? '';
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const bytes = Buffer.from(
      value,
      value.includes('-') || value.includes('_') ? 'base64url' : 'base64',
    );
    if (bytes.length === 32) return bytes;
  }
  return null;
}
export const keyConfigured = (name: KeyName) => keyBytes(name) !== null;
function key(name: KeyName) {
  const bytes = keyBytes(name);
  if (!bytes)
    throw new Error(
      name === 'STAFF_MFA_KEY'
        ? 'Staff MFA encryption is not configured'
        : 'Notification encryption is not configured',
    );
  return bytes;
}
export function encryptSecret(secret: string, name: KeyName = 'STAFF_MFA_KEY') {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(name), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.');
}
export function decryptSecret(value: string, name: KeyName = 'STAFF_MFA_KEY') {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret');
  const [iv, tag, encrypted] = parts.map((s) => Buffer.from(s, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', key(name), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
