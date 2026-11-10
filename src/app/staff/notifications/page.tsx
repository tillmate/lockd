import Link from 'next/link';
import { notifications, requeueReasons } from '@/lib/ops';
import { date } from '@/lib/format';
import { Requeue } from '@/components/ops';
import { staffPage, StaffNav } from '../access';
const states = ['failed', 'pending', 'sent', 'suppressed'] as const;
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const page = await staffPage('notifications');
  if ('gate' in page) return page.gate;
  const { status } = await searchParams;
  const filter = states.find((s) => s === status) ?? 'failed';
  const { counts, messages } = await notifications(page.ctx, filter);
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NOTIFICATIONS · MFA VERIFIED</p>
          <h1>Every message accounted for.</h1>
          <p>
            Delivery metadata for the last 30 days. Message bodies, links and full addresses are not
            shown.
          </p>
        </div>
      </div>
      <StaffNav />
      <div className="stats">
        <div>
          <span>Failed</span>
          <strong>{counts.failed}</strong>
        </div>
        <div>
          <span>Queued</span>
          <strong>{counts.pending}</strong>
          <p>{counts.oldestPending ? `Oldest ${date(counts.oldestPending)}` : 'Nothing waiting'}</p>
        </div>
        <div>
          <span>Sent in 24 hours</span>
          <strong>{counts.sent24h}</strong>
        </div>
      </div>
      <nav className="staff-filter" aria-label="Delivery status">
        {states.map((s) => (
          <Link key={s} className={s === filter ? 'button' : 'secondary'} href={`?status=${s}`}>
            {s[0].toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </nav>
      <section className="section form">
        {messages.map((m) => (
          <article className="card" key={m.id} aria-label={`${m.kind} to ${m.recipient}`}>
            <div className="section-heading">
              <h3>{m.kind.replaceAll('_', ' ').toLowerCase()}</h3>
              <span className="pill">{m.status}</span>
            </div>
            <p>
              To {m.audience} {m.recipient}
              {m.stage_name ? ` · ${m.stage_name}` : ''} · queued {date(m.created_at)} ·{' '}
              {m.attempts} attempt{m.attempts === 1 ? '' : 's'}
              {m.provider ? ` via ${m.provider}` : ''}
            </p>
            {m.delivered_at && <p className="fine">Delivered {date(m.delivered_at)}</p>}
            {m.last_error && <p className="fine">Last result: {m.last_error}</p>}
            {m.status === 'pending' && (
              <p className="fine">Next attempt {date(m.next_attempt_at)}</p>
            )}
            {m.requeueable ? (
              <Requeue id={m.id} options={requeueReasons} />
            ) : (
              m.status === 'failed' && (
                <p className="fine">
                  Link email: cannot be resent. Ask the person to request a new link.
                </p>
              )
            )}
          </article>
        ))}
        {!messages.length && <div className="empty">No {filter} messages.</div>}
      </section>
    </div>
  );
}
