import Link from 'next/link';
import { cases, labels } from '@/lib/support';
import { date } from '@/lib/format';
import { staffPage, StaffNav } from '../access';
const states = ['open', 'closed'] as const;
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const page = await staffPage('support');
  if ('gate' in page) return page.gate;
  const { state } = await searchParams;
  const filter = states.find((s) => s === state) ?? 'open';
  const rows = await cases(page.ctx, filter);
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SUPPORT · MFA VERIFIED</p>
          <h1>Support cases.</h1>
          <p>
            Open a case from a DJ in Listings. Booking records become visible only after you link a
            booking to an open case, for 72 hours at a time, and every view is recorded.
          </p>
        </div>
      </div>
      <StaffNav />
      <nav className="staff-filter" aria-label="Case state">
        {states.map((s) => (
          <Link key={s} className={s === filter ? 'button' : 'secondary'} href={`?state=${s}`}>
            {s[0].toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </nav>
      <section className="section form">
        {rows.map((c) => (
          <Link className="card" key={c.id} href={`/staff/cases/${c.id}`}>
            <div className="section-heading">
              <h3>
                Case #{c.number} · {c.stage_name}
              </h3>
              <span className="pill">{c.state}</span>
            </div>
            <p>
              {labels[c.category]} · raised by {labels[c.requester].toLowerCase()} · opened{' '}
              {date(c.created_at)} by {c.opened_by}
            </p>
            <p className="fine">
              {c.linked} linked booking{c.linked === 1 ? '' : 's'} · {c.notes} note
              {c.notes === 1 ? '' : 's'} ·{' '}
              {c.state === 'open'
                ? `record access until ${date(c.access_expires_at)}`
                : `outcome: ${labels[c.outcome ?? ''] ?? c.outcome}`}
            </p>
          </Link>
        ))}
        {!rows.length && <div className="empty">No {filter} cases.</div>}
      </section>
    </div>
  );
}
