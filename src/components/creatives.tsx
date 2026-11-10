'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { categories, categoryInfo } from '@/lib/creatives';
// Card data is prepared on the server (src/lib/listing.ts): only public profile fields, plus the
// staging demo's illustrative photo and rating.
export type Card = {
  slug: string;
  name: string;
  headline: string;
  parish: string;
  category: string;
  priceFrom: string;
  photo?: string;
  rating?: number;
  reviews?: number;
};
const initials = (name: string) =>
  name
    .replace(/^DEMO · /, '')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
export function CreativeCard({ c }: { c: Card }) {
  const info = categoryInfo(c.category);
  return (
    <Link href={`/creatives/${c.slug}`} className="lp-creative">
      <span className="lp-portrait-wrap">
        {c.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="lp-portrait" src={c.photo} alt="" loading="lazy" />
        ) : (
          <span className="lp-portrait" aria-hidden="true">
            {initials(c.name)}
          </span>
        )}
        <span className="lp-badge">
          {info.icon} {info.one}
        </span>
      </span>
      <span className="lp-creative-top">
        <strong>{c.name}</strong>
        {c.rating ? (
          <span className="lp-rating" title={`${c.reviews} illustrative reviews`}>
            ★ {c.rating.toFixed(1)}
          </span>
        ) : (
          <span className="lp-new">New to Lockd</span>
        )}
      </span>
      <span>{c.headline}</span>
      <span className="lp-creative-bottom">
        <span>{c.parish}, Jamaica</span>
        <span>{c.priceFrom ? `from ${c.priceFrom}` : ''} · View →</span>
      </span>
    </Link>
  );
}
// Landing page: switch the featured creatives by category without leaving the page.
export function FeaturedCreatives({ cards }: { cards: Card[] }) {
  const [active, setActive] = useState('all');
  const present = categories.filter((c) => cards.some((x) => x.category === c.key));
  const shown = (active === 'all' ? cards : cards.filter((c) => c.category === active)).slice(0, 8);
  return (
    <>
      <div className="lp-pills" role="tablist" aria-label="Filter featured creatives">
        {[{ key: 'all', name: 'All' }, ...present].map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={active === c.key}
            className={active === c.key ? 'lp-pill active' : 'lp-pill'}
            onClick={() => setActive(c.key)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="lp-creatives">
        {shown.map((c) => (
          <CreativeCard key={c.slug} c={c} />
        ))}
      </div>
      <p className="lp-more">
        <Link
          className="lp-link"
          href={active === 'all' ? '/creatives' : `/creatives?category=${active}`}
        >
          See all {active === 'all' ? 'creatives' : categoryInfo(active).name.toLowerCase()} →
        </Link>
      </p>
    </>
  );
}
// Search page filters: every change updates the URL, so results are shareable and server-rendered.
export function CreativeFilters({ parishes }: { parishes: string[] }) {
  const router = useRouter(),
    path = usePathname(),
    params = useSearchParams();
  const [pending, start] = useTransition();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    start(() => router.replace(`${path}?${next}`, { scroll: false }));
  };
  return (
    <form
      className="cr-filters"
      role="search"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        set('q', String(new FormData(e.currentTarget).get('q') ?? '').trim());
      }}
    >
      <label className="sr-only" htmlFor="cr-q">
        Search creatives
      </label>
      <input
        id="cr-q"
        name="q"
        defaultValue={params.get('q') ?? ''}
        placeholder="Search by name, style or occasion"
      />
      <select
        aria-label="Category"
        value={params.get('category') ?? ''}
        onChange={(e) => set('category', e.target.value)}
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c.key} value={c.key}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Location"
        value={params.get('parish') ?? ''}
        onChange={(e) => set('parish', e.target.value)}
      >
        <option value="">All of Jamaica</option>
        {parishes.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <select
        aria-label="Sort"
        value={params.get('sort') ?? ''}
        onChange={(e) => set('sort', e.target.value)}
      >
        <option value="">Recommended</option>
        <option value="price">Price: low to high</option>
        <option value="name">Name</option>
      </select>
      <button className="button" type="submit">
        Search
      </button>
    </form>
  );
}
export function ShareProfile({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cp-dark"
      onClick={async () => {
        const url = location.href.split('#')[0];
        try {
          if (navigator.share) await navigator.share({ title: `${name} on Lockd`, url });
          else {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        } catch {
          /* share sheet dismissed */
        }
      }}
    >
      {copied ? 'Link copied ✓' : 'Share profile ↗'}
    </button>
  );
}
