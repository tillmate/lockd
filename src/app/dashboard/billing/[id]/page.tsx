import { notFound, redirect } from 'next/navigation';
import { context } from '@/lib/http';
import { currentUser } from '@/lib/auth';
import { invoice } from '@/lib/billing';
import { InvoiceView } from '@/components/billing';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const data = await invoice(ctx, (await params).id);
  if (!data) notFound();
  return <InvoiceView initial={JSON.parse(JSON.stringify(data))} />;
}
