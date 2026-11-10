import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { context } from '@/lib/http';
import { dashboard } from '@/lib/service';
import { date, money, statusLabel } from '@/lib/format';
import { BlockForm, Logout, RemoveBlock } from '@/components/forms';
export default async function Page() {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const d = await dashboard(ctx);
  if (!d) redirect('/onboarding');
  const active = d.bookings.filter(
    (b) =>
      !['HOLD_EXPIRED', 'COMPLETED', 'CANCELLED'].includes(b.status) &&
      (b.status !== 'CONFIRMED_LOCKD' || new Date(b.ends_at) > new Date()),
  );
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR BUSINESS, IN SYNC</p>
          <h1>{d.account.stage_name}</h1>
        </div>
        <div className="actions">
          <Link className="secondary" href="/dashboard/settings">
            Edit profile & package
          </Link>{' '}
          <Link className="secondary" href="/dashboard/billing">
            Subscription
          </Link>{' '}
          <Logout />
        </div>
      </div>
      <div className="stats">
        <div>
          <span>{d.pro ? 'Pro access' : 'Free plan'}</span>
          <strong>
            {active.length}
            {d.pro ? '' : ' / 3'}
          </strong>
          <p>Active bookings</p>
        </div>
        <div>
          <span>Verified direct deposits</span>
          <strong>{money(d.bookings.reduce((s, b) => s + b.verified_minor, 0))}</strong>
          <p>Received by you · not Lockd revenue</p>
        </div>
        <div>
          <span>Your public booking page</span>
          <Link className="text-link" href={`/dj/${d.account.slug}`}>
            /dj/{d.account.slug} ↗
          </Link>
          <p>Share this link with your clients</p>
        </div>
      </div>
      <section className="section">
        <div className="section-heading">
          <h2>Bookings & holds</h2>
          <span className="pill">All times · Jamaica</span>
        </div>
        {!d.bookings.length ? (
          <div className="empty">
            <h3>Your calendar is ready.</h3>
            <p>Share your booking page to receive your first booking.</p>
          </div>
        ) : (
          <div className="booking-list">
            {d.bookings.map((b) => (
              <Link key={b.id} className="booking-row" href={`/dashboard/bookings/${b.id}`}>
                <div>
                  <strong>{b.client_name}</strong>
                  <p>{date(b.starts_at)}</p>
                </div>
                <span className={`pill ${b.status === 'CONFIRMED_LOCKD' ? 'success' : ''}`}>
                  {statusLabel(b.status)}
                </span>
                <span>Review booking →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
      <section className="split section">
        <div>
          <p className="eyebrow">PROTECT YOUR TIME</p>
          <h2>Blocked dates.</h2>
          <p>
            Reserve personal time, travel, and existing commitments. Blocks cannot overlap an active
            booking.
          </p>
          {d.blocks.map((b) => (
            <div className="card" key={b.id}>
              <strong>{b.reason}</strong>
              <p>
                {date(b.starts_at)} — {date(b.ends_at)}
              </p>
              <RemoveBlock id={b.id} />
            </div>
          ))}
        </div>
        <BlockForm />
      </section>
    </div>
  );
}
