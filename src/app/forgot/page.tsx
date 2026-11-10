import { ForgotForm } from '@/components/forms';
import { emailEnabled, stagingMode } from '@/lib/env';
export default function Page() {
  return (
    <div className="narrow">
      <h1>Let’s get you back in.</h1>
      {stagingMode() && !emailEnabled() ? (
        <p className="notice">
          Password reset needs email, which is not enabled on this demo. Demo passwords are managed
          by the Lockd team.
        </p>
      ) : (
        <ForgotForm />
      )}
    </div>
  );
}
