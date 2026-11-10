import { z } from 'zod';
// Creative categories (db/014). DJs are the public launch category; the others are the curated
// invite-only beta. Shared by server pages and client components, so no server imports here.
export const categories = [
  { key: 'dj', name: 'DJs', one: 'DJ', note: 'Music & energy', icon: '◉', beta: false },
  {
    key: 'live_music',
    name: 'Live music',
    one: 'Live music',
    note: 'Singers & bands',
    icon: '♫',
    beta: true,
  },
  {
    key: 'host',
    name: 'Hosts & MCs',
    one: 'Host & MC',
    note: 'Make it flow',
    icon: '🎤',
    beta: true,
  },
  {
    key: 'comedian',
    name: 'Comedians',
    one: 'Comedian',
    note: 'Bring the laughs',
    icon: '☺',
    beta: true,
  },
  {
    key: 'creator',
    name: 'Creators',
    one: 'Creator',
    note: 'Social & digital',
    icon: '✦',
    beta: true,
  },
  {
    key: 'photo_film',
    name: 'Photo & film',
    one: 'Photo & film',
    note: 'Capture it all',
    icon: '◫',
    beta: true,
  },
] as const;
export type Category = (typeof categories)[number]['key'];
export const categoryInfo = (key: string) => categories.find((c) => c.key === key) ?? categories[0];
export const isCategory = (key: string | undefined): key is Category =>
  categories.some((c) => c.key === key);

export const socialNetworks = [
  { key: 'instagram', label: 'Instagram', host: /^(www\.)?instagram\.com$/ },
  { key: 'tiktok', label: 'TikTok', host: /^(www\.)?tiktok\.com$/ },
  { key: 'youtube', label: 'YouTube', host: /^((www|m)\.)?youtube\.com$|^youtu\.be$/ },
  { key: 'facebook', label: 'Facebook', host: /^(www\.|m\.)?facebook\.com$/ },
  { key: 'x', label: 'X', host: /^(www\.)?(x|twitter)\.com$/ },
  { key: 'website', label: 'Website', host: /\./ },
] as const;
export type Socials = Partial<Record<(typeof socialNetworks)[number]['key'], string>>;
// Each link must be an https URL on that network (any https site for "website").
export const socialsInput = z
  .object(
    Object.fromEntries(
      socialNetworks.map((n) => [
        n.key,
        z
          .string()
          .trim()
          .max(200)
          .optional()
          .transform((v) => v || undefined)
          .refine((v) => {
            if (!v) return true;
            try {
              const u = new URL(v);
              return u.protocol === 'https:' && n.host.test(u.hostname) && !u.username;
            } catch {
              return false;
            }
          }, `Use a full https:// link to your ${n.label} page`),
      ]),
    ),
  )
  .strict()
  .transform((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v)) as Socials);
