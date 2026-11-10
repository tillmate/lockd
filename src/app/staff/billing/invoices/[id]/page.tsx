import { notFound, redirect } from 'next/navigation';
import { context } from '@/lib/http';
import { staffStatus, invoice } from '@/lib/billing';
import { InvoiceView } from '@/components/billing';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await context();
  const access = await staffStatus(ctx);
  if (!access.member) notFound();
  if (!access.unlocked) redirect('/staff/billing');
  const data = await invoice(ctx, (await params).id);
  if (!data) notFound();
  return <InvoiceView initial={JSON.parse(JSON.stringify(data))} staff />;
}
