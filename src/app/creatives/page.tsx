import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { profiles } from '@/lib/service';
import { categories, categoryInfo, isCategory } from '@/lib/creatives';
import { search, toCard } from '@/lib/listing';
import { demoMode } from '@/lib/demo';
import { parishNames } from '@/lib/validation';
import { CreativeCard, CreativeFilters } from '@/components/creatives';
export const metadata: Metadata = { title: 'Find creatives · Lockd' };
// Search page after Figma "WEB 05 / Find Creatives": search, category, location and sort filters
// over approved public profiles. Filters live in the URL, so every result list can be shared.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const category = isCategory(params.category) ? params.category : '';
  const all = await profiles();
  const found = search(all, { ...params, category }).map(toCard);
  const info = category ? categoryInfo(category) : null;
  return (
    <div className="lp">
      <section className="lp-section cr-head">
        <p className="lp-chip">{info ? info.name.toUpperCase() : 'FIND CREATIVES'}</p>
        <h1>{info ? `${info.name} for your event.` : 'Find someone exceptional.'}</h1>
        <p className="lp-lede">
          {info?.beta
            ? `${info.name} are joining Lockd through our curated beta.`
            : 'Who are you looking for? Book directly, sign online and pay the creative.'}
        </p>
        <Suspense>
          <CreativeFilters parishes={[...parishNames]} />
        </Suspense>
        <nav className="lp-pills" aria-label="Categories">
          <Link
            className={category ? 'lp-pill' : 'lp-pill active'}
            href={{ pathname: '/creatives', query: { ...params, category: undefined } }}
          >
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.key}
              className={category === c.key ? 'lp-pill active' : 'lp-pill'}
              href={{ pathname: '/creatives', query: { ...params, category: c.key } }}
            >
              {c.icon} {c.name} ({all.filter((p) => p.category === c.key).length})
            </Link>
          ))}
        </nav>
      </section>
      <section className="lp-section">
        <div className="lp-heading">
          <div>
            <h2>
              {found.length} {found.length === 1 ? 'creative' : 'creatives'}
              {params.q ? ` for “${params.q}”` : ''}
            </h2>
            <p>Featured and available talent.</p>
          </div>
        </div>
        {found.length ? (
          <div className="lp-creatives">
            {found.map((c) => (
              <CreativeCard key={c.slug} c={c} />
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>No creatives match those filters yet.</h3>
            <p>
              Try another parish or category, or <Link href="/creatives">see everyone</Link>.
            </p>
          </div>
        )}
        <p className="lp-fine">
          {demoMode()
            ? 'Illustrative creative profiles, photos and ratings for the staging demo; live ratings require 3 eligible verified reviews.'
            : 'Ratings appear only after three verified reviews of completed bookings.'}
        </p>
      </section>
    </div>
  );
}
