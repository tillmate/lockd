import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { context } from '@/lib/http';
import { currentUser } from '@/lib/auth';
import { staffStatus, queue } from '@/lib/billing';
import { money } from '@/lib/format';
import { StaffMFA, ApproveFounder } from '@/components/billing';
export default async function Page() {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const access = await staffStatus(ctx);
  if (!access.member) notFound();
  if (!access.unlocked) return <StaffMFA />;
  // Billing is its own scope; other staff scopes (even admin) do not include it.
  if (!access.billing) notFound();
  const data = await queue(ctx);
  return (
    <div className="shell">
      <Link href="/dashboard">← DJ workspace</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">BILLING STAFF · MFA VERIFIED</p>
          <h1>Reconcile with confidence.</h1>
          <p>
            Review actual software-payment receipts. Client event deposits are outside this ledger.
          </p>
        </div>
      </div>
      <div className="stats">
        <div>
          <span>Settled software invoices</span>
          <strong>{money(Number(data.totals.settled))}</strong>
        </div>
        <div>
          <span>Verified unapplied receipts</span>
          <strong>{money(Number(data.totals.unapplied))}</strong>
        </div>
        <div>
          <span>Founding places allocated</span>
          <strong>{data.seats} / 50</strong>
        </div>
      </div>
      <section className="section">
        <h2>Software invoices</h2>
        {data.invoices.map((i) => (
          <Link className="booking-row" key={i.id} href={`/staff/billing/invoices/${i.id}`}>
            <span>
              LKD-SUB-{i.number} · {i.billing_name}
            </span>
            <span>{money(i.amount_minor)}</span>
            <span className="pill">{i.state.replaceAll('_', ' ')}</span>
          </Link>
        ))}
        {!data.invoices.length && <p>No invoices to review.</p>}
      </section>
      <section className="section">
        <h2>Founding eligibility</h2>
        <p>
          Approval does not reserve a place. The first 50 approved, verified-paying DJs are
          allocated transactionally.
        </p>
        <div className="form">
          {data.accounts.map((a) => (
            <article className="card" key={a.id}>
              <h3>{a.stage_name}</h3>
              <p>
                {a.parish} · {a.approved ? 'Eligibility approved' : 'Not yet approved'}
              </p>
              {!a.approved && <ApproveFounder id={a.id} />}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
