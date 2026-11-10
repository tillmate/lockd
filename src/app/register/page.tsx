import { AuthForm } from '@/components/forms';
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
      <AuthForm mode="register" />
    </div>
  );
}
