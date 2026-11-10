import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { context } from '@/lib/http';
import { booking } from '@/lib/service';
import { BookingView } from '@/components/booking';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await context();
  if (!(await currentUser(ctx))) redirect('/login');
  const { id } = await params;
  const b = await booking({ session: ctx.session }, id);
  if (!b) notFound();
  return <BookingView initial={JSON.parse(JSON.stringify(b))} dj />;
}
