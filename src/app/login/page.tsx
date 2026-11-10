import Link from 'next/link';
import { AuthForm } from '@/components/forms';
import {
  DEMO_DJ_EMAIL,
  DEMO_STAFF_EMAIL,
  PUBLIC_DEMO_DJ_PASSWORD,
  PUBLIC_DEMO_STAFF_PASSWORD,
  stagingMode,
} from '@/lib/env';
export default function Page() {
  return (
    <div className="narrow">
      <p className="eyebrow">YOUR DJ WORKSPACE</p>
      <h1>Welcome back.</h1>
      {stagingMode() && (
        <p className="notice" role="note">
          Demo DJ: <strong>{DEMO_DJ_EMAIL}</strong> / <strong>{PUBLIC_DEMO_DJ_PASSWORD}</strong>
          <br />
          Demo Super Admin: <strong>{DEMO_STAFF_EMAIL}</strong> /{' '}
          <strong>{PUBLIC_DEMO_STAFF_PASSWORD}</strong>
          <br />
          Synthetic data only; anyone with this demo can use these logins.{' '}
          <Link href="/demo">All demo access →</Link>
        </p>
      )}
      <AuthForm mode="login" />
    </div>
  );
}
