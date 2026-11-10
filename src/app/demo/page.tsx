import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  DEMO_DJ_EMAIL,
  DEMO_STAFF_EMAIL,
  PUBLIC_DEMO_DJ_PASSWORD,
  PUBLIC_DEMO_STAFF_PASSWORD,
  stagingMode,
} from '@/lib/env';
export const metadata: Metadata = { title: 'Demo access · Lockd' };
// Staging only: one page to share with reviewers, covering the client, DJ and staff sides.
export default function Page() {
  if (!stagingMode()) notFound();
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">STAGING DEMO</p>
          <h1>Try Lockd from every side.</h1>
        </div>
      </div>
      <p className="notice" role="note">
        Synthetic data only. Use made-up names and contact details, upload any image as a receipt
        and never send money: nothing here is a real booking, and anyone with these logins can see
        what you enter.
      </p>
      <div className="cards">
        <section className="card">
          <p className="eyebrow">CLIENT</p>
          <h2>Book a DJ</h2>
          <p>
            No account needed. Request a date with the demo DJ, sign the agreement and upload any
            image as the deposit receipt. You get a private link to come back to your booking.
          </p>
          <Link className="button" href="/dj/demo-your-business">
            Book the demo DJ →
          </Link>
        </section>
        <section className="card">
          <p className="eyebrow">DJ</p>
          <h2>DJ workspace</h2>
          <dl className="demo-login">
            <dt>Email</dt>
            <dd>{DEMO_DJ_EMAIL}</dd>
            <dt>Password</dt>
            <dd>{PUBLIC_DEMO_DJ_PASSWORD}</dd>
          </dl>
          <p>
            See booking requests, verify deposits to confirm dates, block time, and edit the
            profile, packages and subscription.
          </p>
          <Link className="button" href="/login">
            Sign in as the DJ →
          </Link>
        </section>
        <section className="card">
          <p className="eyebrow">LOCKD STAFF</p>
          <h2>Super Admin</h2>
          <dl className="demo-login">
            <dt>Email</dt>
            <dd>{DEMO_STAFF_EMAIL}</dd>
            <dt>Password</dt>
            <dd>{PUBLIC_DEMO_STAFF_PASSWORD}</dd>
          </dl>
          <p>
            After signing in, the unlock screen shows the demo authenticator code. Review listings,
            open support cases, check subscription payments, manage staff access and read the audit
            trail.
          </p>
          <Link className="button" href="/login">
            Sign in as Super Admin →
          </Link>
        </section>
      </div>
      <p className="fine">
        Suggested walkthrough: book the demo DJ as a client, then sign in as the DJ to verify the
        deposit and lock the date. Sign out and sign in as Super Admin to see the staff side.
      </p>
    </div>
  );
}
