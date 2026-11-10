import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { context } from '@/lib/http';
import { dashboard } from '@/lib/service';
import { OnboardForm } from '@/components/forms';
export default async function Page() {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  if (await dashboard(ctx)) redirect('/dashboard');
  return (
    <div className="shell setup">
      <p className="eyebrow">SET UP YOUR BUSINESS</p>
      <h1>Make it yours.</h1>
      <p className="lede">
        Your profile, your package, your payment instructions. Clients book directly with you.
      </p>
      <OnboardForm />
    </div>
  );
}
