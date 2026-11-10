import { BookingAccess } from '@/components/booking';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookingAccess id={id} />;
}
