import { CreativeProfile } from '@/components/profile';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ package?: string }>;
}) {
  const [{ slug }, { package: pkg }] = await Promise.all([params, searchParams]);
  return <CreativeProfile slug={slug} pkg={pkg} />;
}
