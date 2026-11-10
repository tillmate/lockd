import Link from 'next/link';
import { profiles } from '@/lib/service';
import { categories } from '@/lib/creatives';
import { demoHero, demoMode } from '@/lib/demo';
import { search, toCard } from '@/lib/listing';
import { FeaturedCreatives } from '@/components/creatives';
// Landing page after Figma "14 · Public Website — Light & Minimal" (WEB 01 / Landing). Figma's
// sample people, photos and star ratings are illustrative: only real, approved DJs appear here,
// and ratings stay hidden until verified reviews exist.
const steps = [
  {
    n: '01',
    title: 'Discover',
    text: 'Explore talent and choose someone right for your occasion.',
    icon: '⌕',
  },
  {
    n: '02',
    title: 'Request',
    text: 'Share your date and details, then review the agreement.',
    icon: '▦',
  },
  {
    n: '03',
    title: 'Get it Lockd',
    text: 'Pay the creative directly. The date is confirmed once they verify the deposit.',
    icon: '✓',
  },
];
export default async function Home() {
  const all = await profiles();
  const demo = demoMode();
  const cards = search(all, {}).map(toCard);
  const count = (key: string) => all.filter((p) => p.category === key).length;
  // Search suggestions: names, categories and parishes of listed creatives.
  const suggestions = [
    ...new Set([
      ...categories.map((c) => c.name),
      ...all.map((p) => p.stageName),
      ...all.map((p) => p.parish),
    ]),
  ];
  return (
    <div className="lp">
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <p className="lp-chip">MADE FOR MEMORABLE MOMENTS</p>
          <h1>
            Your event.
            <br />
            The right people.
            <br />
            All Lockd in.
          </h1>
          <p className="lp-lede">
            Discover Jamaican DJs you can book now, with wedding singers, comedians, hosts, creators
            and photographers joining through a curated beta.
          </p>
          <form className="lp-search" action="/creatives" method="get" role="search">
            <label className="sr-only" htmlFor="lp-q">
              Who are you looking for?
            </label>
            <span aria-hidden="true">⌕</span>
            <input
              id="lp-q"
              name="q"
              list="lp-suggestions"
              autoComplete="off"
              placeholder="Who are you looking for?"
            />
            <datalist id="lp-suggestions">
              {suggestions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <button className="button" type="submit">
              Find creatives →
            </button>
          </form>
          <p className="lp-quick">
            Popular:
            <Link href="/creatives?q=wedding">Wedding</Link>
            <Link href="/creatives?category=dj">Party DJ</Link>
            <Link href="/creatives?category=live_music">Live band</Link>
            <Link href="/creatives?category=host">MC</Link>
            <Link href="/creatives?category=photo_film">Photographer</Link>
          </p>
        </div>
        <figure className="lp-hero-visual">
          {demo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="lp-hero-photo"
              src={demoHero}
              alt="Guests celebrating at an outdoor wedding reception by the sea"
            />
          ) : (
            <div className="lp-visual-card" aria-hidden="true">
              <span className="lp-visual-pill">Confirmed · Lockd</span>
              <strong>Date, Lockd.</strong>
              <p>Deposit verified by your DJ. Agreement signed. Your night is set.</p>
            </div>
          )}
          <figcaption>THE PERFECT MATCH, FOR EVERY MOMENT</figcaption>
        </figure>
      </section>

      <section className="lp-section">
        <div className="lp-heading">
          <div>
            <h2>Find the right creative</h2>
            <p>Book DJs today. Explore other creatives joining our curated beta.</p>
          </div>
          <Link className="lp-link" href="/creatives">
            Explore all categories →
          </Link>
        </div>
        <div className="lp-categories">
          {categories.map((c) => (
            <Link key={c.key} className="lp-category" href={`/creatives?category=${c.key}`}>
              <span className="lp-icon">{c.icon}</span>
              <strong>{c.name}</strong>
              <span>
                {c.note}
                {c.beta ? ' · curated beta' : ''}
              </span>
              <em>
                {count(c.key)} {count(c.key) === 1 ? 'creative' : 'creatives'} →
              </em>
            </Link>
          ))}
        </div>
      </section>

      <section className="lp-section" id="creatives">
        <div className="lp-heading">
          <div>
            <h2>Featured creatives</h2>
            <p>
              {demo
                ? 'Featured DJ profiles and invited-creator previews.'
                : 'Creatives you can book on Lockd today.'}
            </p>
          </div>
        </div>
        {cards.length ? (
          <FeaturedCreatives cards={cards} />
        ) : (
          <div className="empty">
            <h3>The next great booking starts here.</h3>
            <p>No creatives are listed yet.</p>
          </div>
        )}
        <p className="lp-fine">
          {demo
            ? 'Illustrative creative profiles and ratings for design only; live ratings require 3 eligible verified reviews.'
            : 'Ratings appear only after three verified reviews of completed bookings.'}
        </p>
      </section>

      <section className="lp-steps-band" id="how-it-works">
        <div className="lp-section">
          <h2>A smoother way to make it happen</h2>
          <p className="lp-sub">Simple steps. Clear details. No unnecessary back-and-forth.</p>
          <div className="lp-steps">
            {steps.map((s) => (
              <div key={s.n} className="lp-step">
                <span className="lp-icon">{s.icon}</span>
                <div>
                  <strong>
                    {s.n} {s.title}
                  </strong>
                  <p>{s.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-talent">
        <div>
          <p className="lp-kicker">FOR THE PEOPLE WHO MAKE IT HAPPEN</p>
          <h2>
            Your talent deserves
            <br />
            more than a DM.
          </h2>
          <p>
            Bring bookings, agreements and deposits into one professional workflow—without losing
            your personal touch.
          </p>
        </div>
        <div className="lp-talent-card">
          <h3>Ready to take bookings?</h3>
          <p>Build a shareable booking page and manage your business in one place.</p>
          <Link className="lp-dark-button" href="/register">
            Create your free page →
          </Link>
        </div>
      </section>
    </div>
  );
}
