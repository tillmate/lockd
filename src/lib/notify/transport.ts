import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { localMode } from '../auth';

export type Outgoing = {
  id: string;
  kind: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  action?: { label: string; url: string };
};
export type SendResult =
  { ok: true; messageId: string } | { ok: false; retry: boolean; error: string };
export type Transport = { name: string; send(m: Outgoing): Promise<SendResult> };

const MAILBOX = '.local/mailbox';
// Development transport: writes rendered messages to an ignored local folder. Same id
// overwrites the same file, so retries never duplicate a message. Written to a temporary file
// and renamed, so a reader never sees a half-written message.
export const localTransport: Transport = {
  name: 'local',
  async send(m) {
    await mkdir(MAILBOX, { recursive: true });
    const target = `${MAILBOX}/${m.id}.json`,
      temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ ...m, createdAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    await rename(temp, target);
    return { ok: true, messageId: `local-${m.id}` };
  },
};
export type LocalLetter = Outgoing & { createdAt: string };
export async function localMailbox(): Promise<LocalLetter[]> {
  const files = (await readdir(MAILBOX).catch(() => [] as string[])).filter((f) =>
    /^[0-9a-f-]{36}\.json$/.test(f),
  );
  const letters = await Promise.all(
    files.map(async (f) => {
      try {
        return JSON.parse(await readFile(`${MAILBOX}/${f}`, 'utf8')) as LocalLetter;
      } catch {
        return null; // Unreadable leftovers are skipped rather than breaking the mailbox.
      }
    }),
  );
  return letters
    .filter((l): l is LocalLetter => l !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// https://resend.com/docs/api-reference/emails/send-email — the outbox id is the idempotency
// key, so a resend after a crash or lease expiry is deduplicated by the provider.
export function resendTransport(
  apiKey: string,
  from: string,
  replyTo?: string,
  fetcher: typeof fetch = fetch,
): Transport {
  return {
    name: 'resend',
    async send(m) {
      let res: Response;
      try {
        res = await fetcher('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `lockd-${m.id}`,
          },
          body: JSON.stringify({
            from,
            to: [m.to],
            subject: m.subject,
            html: m.html,
            text: m.text,
            ...(replyTo ? { reply_to: replyTo } : {}),
            tags: [{ name: 'kind', value: m.kind.replace(/[^A-Za-z0-9_-]/g, '_') }],
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        return { ok: false, retry: true, error: `Network error: ${(e as Error).message}` };
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && body.id) return { ok: true, messageId: body.id };
      // Validation errors (bad address, rejected content) are permanent; auth, rate-limit and
      // server errors are retried so a configuration fix resumes delivery without losing mail.
      const permanent = [400, 404, 422].includes(res.status);
      return {
        ok: false,
        retry: !permanent,
        error: `Resend ${res.status}: ${String(body.message ?? 'no detail').slice(0, 300)}`,
      };
    },
  };
}

export type DeliveryConfig = { transport: Transport | null; allowedDomains: string[] | null };
export function deliveryConfig(
  env: Record<string, string | undefined> = process.env,
): DeliveryConfig {
  const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  const allowedDomains = env.EMAIL_ALLOWED_DOMAINS
    ? env.EMAIL_ALLOWED_DOMAINS.split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    : null;
  if (!provider || provider === 'disabled') return { transport: null, allowedDomains };
  if (provider === 'local') {
    if (!localMode()) throw new Error('EMAIL_PROVIDER=local is restricted to explicit local mode');
    return { transport: localTransport, allowedDomains };
  }
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM)
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
    if (!(env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || '').startsWith('https://'))
      throw new Error('Real email delivery requires an https APP_ORIGIN for links');
    return {
      transport: resendTransport(env.RESEND_API_KEY, env.EMAIL_FROM, env.EMAIL_REPLY_TO),
      allowedDomains,
    };
  }
  throw new Error(`Unknown EMAIL_PROVIDER "${provider}"`);
}
