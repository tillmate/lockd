import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { context } from '@/lib/http';
import { staffAccess, type Scope } from '@/lib/ops';
import { StaffMFA } from '@/components/billing';
// UI gate only; every query and mutation is independently enforced by staff_can() in PostgreSQL.
export async function staffPage(scope?: Scope) {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const access = await staffAccess(ctx);
  if (!access.member) notFound();
  if (!access.unlocked) return { gate: <StaffMFA area="operations" /> } as const;
  if (scope && !access.has(scope)) notFound();
  return { ctx, access } as const;
}
export function StaffNav() {
  return (
    <nav className="staff-nav" aria-label="Staff tools">
      <Link href="/staff">Staff home</Link>
      <Link href="/staff/listings">Listings</Link>
      <Link href="/staff/notifications">Notifications</Link>
      <Link href="/staff/billing">Billing</Link>
      <Link href="/staff/admin">Admin & audit</Link>
    </nav>
  );
}
