import { categoryInfo } from './creatives';
import { demoMode, demoOrder, demoProfile } from './demo';
import { money } from './format';
import type { Profile } from './service';
import type { Card } from '@/components/creatives';
// Directory cards and search over the public profiles. The staging demo adds illustrative photos
// and ratings and lists the Figma creatives first.
export const lowestPrice = (p: Profile) =>
  p.packages?.length ? Math.min(...p.packages.map((x) => x.priceMinor)) : Infinity;
export function toCard(p: Profile): Card {
  const demo = demoProfile(p.slug);
  return {
    slug: p.slug,
    name: p.stageName,
    headline: p.headline ?? categoryInfo(p.category).one,
    parish: p.parish,
    category: p.category,
    priceFrom: Number.isFinite(lowestPrice(p)) ? money(lowestPrice(p)) : '',
    ...(demo && { photo: demo.photo, rating: demo.rating, reviews: demo.reviews }),
  };
}
export function search(
  all: Profile[],
  { q = '', category = '', parish = '', sort = '' }: Record<string, string | undefined>,
) {
  const term = q.trim().toLowerCase();
  const found = all.filter(
    (p) =>
      (!category || p.category === category) &&
      (!parish || p.parish === parish) &&
      (!term ||
        [
          p.stageName,
          p.parish,
          p.bio,
          p.headline ?? '',
          categoryInfo(p.category).name,
          ...(p.packages ?? []).map((x) => x.name),
        ].some((v) => v.toLowerCase().includes(term))),
  );
  const order =
    sort === 'price'
      ? (a: Profile, b: Profile) => lowestPrice(a) - lowestPrice(b)
      : sort === 'name'
        ? (a: Profile, b: Profile) => a.stageName.localeCompare(b.stageName)
        : demoMode()
          ? (a: Profile, b: Profile) => demoOrder(a.slug) - demoOrder(b.slug)
          : () => 0;
  return [...found].sort(order);
}
