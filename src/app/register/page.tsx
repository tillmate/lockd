import Link from 'next/link';
import { AuthForm } from '@/components/forms';
import { emailEnabled, stagingMode } from '@/lib/env';
export default function Page() {
  return (
    <div className="auth-grid shell">
      <section>
        <p className="eyebrow">WELCOME TO LOCKD</p>
        <h1>
          Take bookings.
          <br />
          Get paid first.
        </h1>
        <p className="lede">
          Set up a professional booking page and let clients sign, pay a deposit and lock your date.
        </p>
        <div className="ink-panel">
          <p className="eyebrow">LOCK DI DATE.</p>
          <h2>
            No more lost
            <br />
            bookings.
          </h2>
          <p>One link for packages, agreements and deposits.</p>
        </div>
      </section>
      {stagingMode() && !emailEnabled() ? (
        <div className="card form">
          <h2>Sign-up is off on this demo.</h2>
          <p>
            New accounts need a verification email, and email is not enabled on the staging demo.
            Sign in with the demo DJ account instead.
          </p>
          <Link className="button" href="/login">
            Go to sign in
          </Link>
        </div>
      ) : (
        <AuthForm mode="register" />
      )}
    </div>
  );
}
