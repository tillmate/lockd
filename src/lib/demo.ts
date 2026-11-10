import { stagingMode } from './env';
// Illustrative Figma content (people, photos, ratings) for the staging demo, so visitors see the
// finished design. Never shown in production: real profiles only get ratings from verified reviews.
export const demoMode = () => stagingMode() || process.env.LOCKD_DEMO_VISUALS === '1';
export const demoHero = '/demo/hero.jpg';
export const demoProfiles: Record<string, { photo: string; role: string; rating: number }> = {
  'jordan-p': { photo: '/demo/jordan-p.jpg', role: 'DJ & event curator', rating: 4.9 },
  'leah-m': { photo: '/demo/leah-m.jpg', role: 'Wedding singer', rating: 4.8 },
  'andre-j': { photo: '/demo/andre-j.jpg', role: 'Comedian & host', rating: 4.9 },
  'tasha-k': { photo: '/demo/tasha-k.jpg', role: 'Host & content creator', rating: 4.8 },
};
export const demoProfile = (slug: string) => (demoMode() ? demoProfiles[slug] : undefined);
