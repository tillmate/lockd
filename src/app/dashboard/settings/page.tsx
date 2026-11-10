import Link from 'next/link';
import { redirect } from 'next/navigation';
import { context } from '@/lib/http';
import { currentUser } from '@/lib/auth';
import { settings } from '@/lib/service';
import { OnboardForm } from '@/components/forms';
export default async function Page() {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const initial = await settings(ctx);
  if (!initial) redirect('/onboarding');
  return (
    <div className="shell">
      <Link href="/dashboard">← Dashboard</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR PROFILE & PACKAGE</p>
          <h1>Keep your page current.</h1>
          <p>
            Changes apply to new bookings. Existing agreements, prices, payment instructions and
            reserved travel time stay as agreed.
          </p>
        </div>
      </div>
      <OnboardForm initial={initial} />
    </div>
  );
}
