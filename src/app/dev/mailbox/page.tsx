import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readdir } from 'node:fs/promises';
import { localMode, readLocalToken } from '@/lib/auth';
export default async function Page() {
  if (!localMode()) notFound();
  const files = await readdir('.local/mailbox').catch(() => []);
  const letters = await Promise.all(
    files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).map((f) => readLocalToken(f.slice(0, -5))),
  );
  return (
    <div className="shell">
      <p className="eyebrow">LOCAL DEVELOPMENT ONLY</p>
      <h1>Test mailbox</h1>
      <p>No emails are sent. These links are for synthetic local accounts only.</p>
      {letters.length ? (
        letters
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((l) => (
            <article className="card" key={l.token}>
              <h3>{l.recipient}</h3>
              <p>{l.kind === 'verify' ? 'Verify email' : 'Reset password'}</p>
              <Link
                className="button"
                href={`/${l.kind === 'verify' ? 'verify' : 'reset'}#${l.token}`}
              >
                Open {l.kind} link
              </Link>
            </article>
          ))
      ) : (
        <div className="empty">No local messages yet.</div>
      )}
    </div>
  );
}
