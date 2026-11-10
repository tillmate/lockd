import { TokenForm } from '@/components/forms';
export default function Page() {
  return (
    <div className="narrow">
      <p className="eyebrow">ONE MORE STEP</p>
      <h1>Verify your email.</h1>
      <TokenForm mode="verify" />
    </div>
  );
}
