import { AuthForm } from '@/components/forms';
import { DEMO_DJ_EMAIL, PUBLIC_DEMO_DJ_PASSWORD, stagingMode } from '@/lib/env';
export default function Page() {
  return (
    <div className="narrow">
      <p className="eyebrow">YOUR DJ WORKSPACE</p>
      <h1>Welcome back.</h1>
      {stagingMode() && (
        <p className="notice" role="note">
          Demo DJ login: <strong>{DEMO_DJ_EMAIL}</strong> /{' '}
          <strong>{PUBLIC_DEMO_DJ_PASSWORD}</strong>. Synthetic data only; anyone with this demo can
          use it.
        </p>
      )}
      <AuthForm mode="login" />
    </div>
  );
}
