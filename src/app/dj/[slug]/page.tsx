import { CreativeProfile } from '@/components/profile';
// Shared DJ booking links (/dj/<slug>) stay valid; they render the same profile as /creatives.
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
