import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listings } from '@/lib/ops';
import { categories, labels, requesters } from '@/lib/support';
import { OpenCaseForm } from '@/components/support';
import { staffPage, StaffNav } from '../../access';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const page = await staffPage('support');
  if ('gate' in page) return page.gate;
  const { account } = await searchParams;
  // staff_listings already excludes the staff member's own account.
  const dj = (await listings(page.ctx)).find((l) => l.id === account);
  if (!dj) notFound();
  return (
    <div className="narrow">
      <p className="eyebrow">SUPPORT · NEW CASE</p>
      <h1>Open a case about {dj.stage_name}.</h1>
      <p>
        /dj/{dj.slug} · {dj.parish} · {dj.email}
      </p>
      <StaffNav />
      <div className="card">
        <p>
          The DJ is told a case exists, except for fraud reports. You will link specific bookings
          next; nothing private is visible until you do.
        </p>
        <OpenCaseForm
          accountId={dj.id}
          categories={categories}
          requesters={requesters}
          labels={labels}
        />
      </div>
      <Link href="/staff/listings">← Back to listings</Link>
    </div>
  );
}
