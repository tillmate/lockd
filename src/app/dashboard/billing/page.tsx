import Link from 'next/link';
import { redirect } from 'next/navigation';
import { context } from '@/lib/http';
import { currentUser } from '@/lib/auth';
import { home } from '@/lib/billing';
import { date, money } from '@/lib/format';
import { PlanPicker } from '@/components/billing';
export default async function Page() {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const data = await home(ctx);
  if (!data) redirect('/onboarding');
  return (
    <div className="shell">
      <Link href="/dashboard">← Dashboard</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SOFTWARE BILLING</p>
          <h1>Your plan, clearly.</h1>
          <p>Event deposits go directly to you. These invoices are only for Lockd software.</p>
        </div>
        <span className="pill">{data.pro ? 'Pro access active' : 'Free access'}</span>
      </div>
      {data.subscription && (
        <section className="notice">
          <strong>
            {data.subscription.plan} subscription · renewal {date(data.subscription.ends_at)}
          </strong>
          <p>
            {data.pro
              ? 'Paid features continue through the seven-day renewal grace.'
              : 'Paid access has ended. New holds use the three-active-booking Free cap; all existing records remain accessible.'}{' '}
            Grace ends {date(data.subscription.grace_ends_at)}.
          </p>
          {data.seat && (
            <p>
              Founding allocation #{data.seat}. Annual rate retention depends on timely verified
              renewal payments.
            </p>
          )}
        </section>
      )}
      <PlanPicker data={JSON.parse(JSON.stringify(data))} />
      <section className="section">
        <h2>Invoices & receipts</h2>
        {!data.invoices.length && <p>No software invoices yet.</p>}
        {data.invoices.map((i) => (
          <Link key={i.id} className="booking-row" href={`/dashboard/billing/${i.id}`}>
            <span>
              LKD-SUB-{i.number} · {i.plan}
            </span>
            <span>{money(i.amount_minor)}</span>
            <span className="pill">{i.state.replaceAll('_', ' ')}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
