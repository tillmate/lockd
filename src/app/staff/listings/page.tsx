import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listingReason, listings } from '@/lib/ops';
import { date } from '@/lib/format';
import { ListingDecision } from '@/components/ops';
import { staffPage, StaffNav } from '../access';
const states = ['pending', 'restricted', 'approved'] as const;
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const page = await staffPage();
  if ('gate' in page) return page.gate;
  const { ctx, access } = page;
  if (!access.has('listings') && !access.has('support')) notFound();
  const { state } = await searchParams;
  const filter = states.find((s) => s === state) ?? 'pending';
  const rows = await listings(ctx, filter);
  const canReview = access.has('listings');
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">LISTINGS · MFA VERIFIED</p>
          <h1>Who clients can book.</h1>
          <p>
            Approval puts a DJ in the public directory. Restriction hides their page and pauses new
            holds; existing bookings and records stay intact.
          </p>
        </div>
      </div>
      <StaffNav />
      <nav className="staff-filter" aria-label="Listing state">
        {states.map((s) => (
          <Link key={s} className={s === filter ? 'button' : 'secondary'} href={`?state=${s}`}>
            {s[0].toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </nav>
      <section className="section form">
        {rows.map((a) => (
          <article className="card" key={a.id} aria-label={a.stage_name}>
            <div className="section-heading">
              <h3>{a.stage_name}</h3>
              <span className={`pill ${a.listing_state === 'approved' ? 'success' : ''}`}>
                {a.listing_state}
              </span>
            </div>
            <p>
              /dj/{a.slug} · {a.parish} · joined {date(a.created_at)} ·{' '}
              {a.email_verified ? 'email verified' : 'email unverified'} ·{' '}
              {a.published ? 'published by DJ' : 'unpublished by DJ'}
            </p>
            <p>
              {a.email} · {a.active_bookings} active / {a.total_bookings} total bookings
            </p>
            <details>
              <summary>Profile text</summary>
              <p>{a.bio}</p>
            </details>
            {a.last_review && (
              <p className="fine">
                Last decision: {a.last_review.toState} ({a.last_review.reasonCode}) —{' '}
                {a.last_review.note} · {date(a.last_review.createdAt)}
              </p>
            )}
            {canReview && (
              <div className="grid-2">
                {a.listing_state !== 'approved' && (
                  <ListingDecision
                    accountId={a.id}
                    decision="approved"
                    options={listingReason.approved}
                  />
                )}
                {a.listing_state !== 'restricted' && (
                  <ListingDecision
                    accountId={a.id}
                    decision="restricted"
                    options={listingReason.restricted}
                  />
                )}
              </div>
            )}
            {access.has('support') && (
              <Link className="secondary" href={`/staff/cases/new?account=${a.id}`}>
                Open support case
              </Link>
            )}
          </article>
        ))}
        {!rows.length && <div className="empty">No {filter} listings.</div>}
      </section>
    </div>
  );
}
