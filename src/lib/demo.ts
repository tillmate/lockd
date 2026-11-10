import { stagingMode } from './env';
// Illustrative content (people, photos, ratings) for the staging demo, so visitors see the
// finished design. Never shown in production: real profiles only get ratings from verified reviews.
// Photos: four from the Figma file; the rest are Unsplash photos (Unsplash License), see
// public/demo/CREDITS.md.
export const demoMode = () => stagingMode() || process.env.LOCKD_DEMO_VISUALS === '1';
export const demoHero = '/demo/hero.jpg';
const photo = (slug: string, rating: number, reviews: number) => ({
  photo: `/demo/${slug}.jpg`,
  rating,
  reviews,
});
// Order is the landing page's featured order.
export const demoProfiles: Record<string, { photo: string; rating: number; reviews: number }> = {
  'jordan-p': photo('jordan-p', 4.9, 38),
  'leah-m': photo('leah-m', 4.8, 26),
  'andre-j': photo('andre-j', 4.9, 31),
  'tasha-k': photo('tasha-k', 4.8, 22),
  'rootical-vibes': photo('rootical-vibes', 4.9, 17),
  'orrin-p': photo('orrin-p', 4.9, 41),
  'simone-t': photo('simone-t', 4.7, 15),
  'kerry-ann-b': photo('kerry-ann-b', 4.8, 19),
  'selecta-marlon': photo('selecta-marlon', 4.7, 24),
  'shanice-w': photo('shanice-w', 4.8, 12),
  'nadine-r': photo('nadine-r', 4.9, 20),
  'damion-r': photo('damion-r', 4.6, 14),
  'ayesha-g': photo('ayesha-g', 4.7, 11),
  'javaughn-l': photo('javaughn-l', 4.8, 16),
};
export const demoProfile = (slug: string) => (demoMode() ? demoProfiles[slug] : undefined);
export const demoOrder = (slug: string) => {
  const i = Object.keys(demoProfiles).indexOf(slug);
  return i < 0 ? 99 : i;
};
