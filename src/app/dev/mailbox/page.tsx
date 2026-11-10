import { notFound } from 'next/navigation';
import { localMode } from '@/lib/auth';
import { localMailbox } from '@/lib/notify/transport';
export const dynamic = 'force-dynamic';
export default async function Page() {
  if (!localMode()) notFound();
  const letters = await localMailbox();
  return (
    <div className="shell">
      <p className="eyebrow">LOCAL DEVELOPMENT ONLY</p>
      <h1>Test mailbox</h1>
      <p>
        No emails are sent. The notification worker (<code>npm run worker</code>) renders queued
        messages here for synthetic local accounts only.
      </p>
      {letters.length ? (
        letters.map((l) => (
          <article className="card" key={l.id} aria-label={l.subject}>
            <h3>{l.to}</h3>
            <p>
              <strong>{l.subject}</strong>
            </p>
            <details>
              <summary>Read message</summary>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{l.text}</pre>
            </details>
            {l.action && (
              // Plain anchor: link fragments carry one-time tokens and must load as written.
              <a className="button" href={l.action.url}>
                {l.action.label}
              </a>
            )}
          </article>
        ))
      ) : (
        <div className="empty">No local messages yet. Is the worker running?</div>
      )}
    </div>
  );
}
