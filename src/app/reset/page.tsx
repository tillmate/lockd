import { TokenForm } from '@/components/forms';
export default function Page() {
  return (
    <div className="narrow">
      <h1>Reset your password.</h1>
      <TokenForm mode="reset" />
    </div>
  );
}
