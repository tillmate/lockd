import { describe, expect, it } from 'vitest';
import { socialsInput } from '../src/lib/creatives';
import { search } from '../src/lib/listing';
import type { Profile } from '../src/lib/service';

describe('social links', () => {
  it('keeps https links on the matching network and drops empty boxes', () => {
    expect(
      socialsInput.parse({
        instagram: 'https://www.instagram.com/lockd',
        youtube: 'https://youtu.be/abc',
        tiktok: '',
        website: 'https://example.com/me',
      }),
    ).toEqual({
      instagram: 'https://www.instagram.com/lockd',
      youtube: 'https://youtu.be/abc',
      website: 'https://example.com/me',
    });
  });
  it.each([
    ['instagram', 'http://instagram.com/lockd'],
    ['instagram', 'https://evil.example/instagram.com'],
    ['tiktok', 'javascript:alert(1)'],
    ['x', 'https://user:pw@x.com/lockd'],
  ])('rejects %s %s', (key, url) => {
    expect(() => socialsInput.parse({ [key]: url })).toThrow();
  });
  it('rejects unknown networks', () => {
    expect(() => socialsInput.parse({ myspace: 'https://myspace.com/x' })).toThrow();
  });
});

describe('creative search', () => {
  const p = (slug: string, category: Profile['category'], parish: string, price: number) =>
    ({
      id: slug,
      slug,
      stageName: slug,
      parish,
      bio: 'Synthetic profile for tests.',
      category,
      headline: null,
      socials: {},
      packages: [
        {
          id: `${slug}-p`,
          name: 'Set',
          description: 'd',
          priceMinor: price,
          depositMinor: 1,
          durationMinutes: 60,
        },
      ],
    }) as Profile;
  const all = [
    p('a', 'dj', 'Kingston', 300),
    p('b', 'comedian', 'St. James', 100),
    p('c', 'dj', 'St. James', 200),
  ];
  it('filters by category, parish and text, and sorts by price', () => {
    expect(search(all, { category: 'dj' }).map((x) => x.slug)).toEqual(['a', 'c']);
    expect(search(all, { parish: 'St. James', sort: 'price' }).map((x) => x.slug)).toEqual([
      'b',
      'c',
    ]);
    expect(search(all, { q: 'comedian' }).map((x) => x.slug)).toEqual(['b']);
  });
});
