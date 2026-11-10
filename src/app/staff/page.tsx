import Link from 'next/link';
import { listings, notifications } from '@/lib/ops';
import { cases } from '@/lib/support';
import { staffPage, StaffNav } from './access';
export default async function Page() {
  const page = await staffPage();
  if ('gate' in page) return page.gate;
  const { ctx, access } = page;
  const pending = access.has('listings') ? await listings(ctx, 'pending') : null;
  const queue = access.has('notifications') ? (await notifications(ctx, 'failed')).counts : null;
  const open = access.has('support') ? await cases(ctx, 'open') : null;
  const tiles = [
    {
      href: '/staff/listings',
      show: access.has('listings') || access.has('support'),
      title: 'Listings',
      value: pending ? `${pending.length} awaiting review` : 'Support view',
      text: 'Approve DJs for the directory or restrict a booking page.',
    },
    {
      href: '/staff/cases',
      show: access.has('support'),
      title: 'Support cases',
      value: open ? `${open.length} open` : '',
      text: 'Case-scoped, time-limited access to the bookings a problem concerns.',
    },
    {
      href: '/staff/notifications',
      show: access.has('notifications'),
      title: 'Notifications',
      value: queue ? `${queue.failed} failed · ${queue.pending} queued` : '',
      text: 'Inspect delivery failures and requeue messages.',
    },
    {
      href: '/staff/billing',
      show: access.has('billing'),
      title: 'Billing',
      value: 'Invoices & founding places',
      text: 'Reconcile actual software-invoice receipts.',
    },
    {
      href: '/staff/admin',
      show: access.has('admin'),
      title: 'Admin & audit',
      value: 'Staff scopes',
      text: 'Grant or revoke staff scopes and review every staff action.',
    },
  ];
  return (
    <div className="shell">
      <Link href="/dashboard">← DJ workspace</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOCKD STAFF · MFA VERIFIED</p>
          <h1>Operations.</h1>
          <p>Your scopes: {access.scopes.length ? access.scopes.join(', ') : 'none yet'}.</p>
        </div>
      </div>
      <StaffNav />
      <div className="stats">
        {tiles
          .filter((t) => t.show)
          .map((t) => (
            <Link key={t.href} href={t.href} className="card">
              <span>{t.title}</span>
              <strong>{t.value}</strong>
              <p>{t.text}</p>
            </Link>
          ))}
      </div>
    </div>
  );
}
