import Link from 'next/link';
import { profiles } from '@/lib/service';
import { money } from '@/lib/format';
// Landing page after Figma "14 · Public Website — Light & Minimal" (WEB 01 / Landing). Figma's
// sample people, photos and star ratings are illustrative: only real, approved DJs appear here,
// and ratings stay hidden until verified reviews exist.
const categories = [
  { name: 'DJs', note: 'Music & energy', icon: '◉', live: true },
  { name: 'Live music', note: 'Singers & bands', icon: '♫', live: false },
  { name: 'Hosts & MCs', note: 'Make it flow', icon: '🎤', live: false },
  { name: 'Comedians', note: 'Bring the laughs', icon: '☺', live: false },
  { name: 'Creators', note: 'Social & digital', icon: '✦', live: false },
  { name: 'Photo & film', note: 'Capture it all', icon: '◫', live: false },
];
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
export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = '' } = await searchParams;
  const all = await profiles();
  const term = q.trim().toLowerCase();
  const djs = term
    ? all.filter((d) =>
        [d.stageName, d.parish, d.bio, ...d.packages.map((p) => p.name)].some((v) =>
          v.toLowerCase().includes(term),
        ),
      )
    : all;
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
          <form className="lp-search" action="/#creatives" method="get" role="search">
            <label className="sr-only" htmlFor="lp-q">
              Who are you looking for?
            </label>
            <span aria-hidden="true">⌕</span>
            <input id="lp-q" name="q" defaultValue={q} placeholder="Who are you looking for?" />
            <button className="button" type="submit">
              Find creatives →
            </button>
          </form>
          <p className="lp-fine">
            Browse talent for weddings, private events, brand campaigns and everything in between.
          </p>
        </div>
        <figure className="lp-hero-visual">
          <div className="lp-visual-card" aria-hidden="true">
            <span className="lp-visual-pill">Confirmed · Lockd</span>
            <strong>Date, Lockd.</strong>
            <p>Deposit verified by your DJ. Agreement signed. Your night is set.</p>
          </div>
          <figcaption>THE PERFECT MATCH, FOR EVERY MOMENT</figcaption>
        </figure>
      </section>

      <section className="lp-section">
        <div className="lp-heading">
          <div>
            <h2>Find the right creative</h2>
            <p>Book DJs today. Explore other creatives joining our curated beta.</p>
          </div>
          <Link className="lp-link" href="/#creatives">
            Explore all categories →
          </Link>
        </div>
        <div className="lp-categories">
          {categories.map((c) =>
            c.live ? (
              <Link key={c.name} className="lp-category" href="/#creatives">
                <span className="lp-icon">{c.icon}</span>
                <strong>{c.name}</strong>
                <span>{c.note}</span>
              </Link>
            ) : (
              <div key={c.name} className="lp-category muted">
                <span className="lp-icon">{c.icon}</span>
                <strong>{c.name}</strong>
                <span>{c.note} · curated beta</span>
              </div>
            ),
          )}
        </div>
      </section>

      <section className="lp-section" id="creatives">
        <div className="lp-heading">
          <div>
            <h2>{term ? `Results for “${q.trim()}”` : 'Featured creatives'}</h2>
            <p>DJs you can book on Lockd today.</p>
          </div>
          {term && (
            <Link className="lp-link" href="/#creatives">
              Show all →
            </Link>
          )}
        </div>
        {djs.length ? (
          <div className="lp-creatives">
            {djs.slice(0, term ? 24 : 8).map((d) => (
              <Link key={d.id} href={`/dj/${d.slug}`} className="lp-creative">
                <span className="lp-portrait" aria-hidden="true">
                  {d.stageName
                    .replace(/^DEMO · /, '')
                    .split(/\s+/)
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span className="lp-creative-top">
                  <strong>{d.stageName}</strong>
                  <span className="lp-new">New to Lockd</span>
                </span>
                <span>{d.packages[0]?.name ?? 'DJ'}</span>
                <span className="lp-creative-bottom">
                  <span>{d.parish}, Jamaica</span>
                  <span>
                    {d.packages.length
                      ? `from ${money(Math.min(...d.packages.map((p) => p.priceMinor)))}`
                      : ''}{' '}
                    · View →
                  </span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>
              {term ? 'No DJs match that search yet.' : 'The next great booking starts here.'}
            </h3>
            <p>{term ? 'Try a parish or a style of event.' : 'No DJs are listed yet.'}</p>
          </div>
        )}
        <p className="lp-fine">
          Ratings appear only after three verified reviews of completed bookings.
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
