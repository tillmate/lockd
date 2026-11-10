import { AuthForm } from '@/components/forms';
export default function Page() {
  return (
    <div className="narrow">
      <p className="eyebrow">YOUR DJ WORKSPACE</p>
      <h1>Welcome back.</h1>
      <AuthForm mode="login" />
    </div>
  );
}
