import Link from 'next/link';
import { notFound } from 'next/navigation';
import { profiles } from '@/lib/service';
import { categoryInfo, socialNetworks } from '@/lib/creatives';
import { demoProfile } from '@/lib/demo';
import { money } from '@/lib/format';
import { HoldForm } from '@/components/forms';
import { ShareProfile } from '@/components/creatives';
// Public creative profile after Figma "WEB 07 / Creative Profile — Desktop": large portrait,
// identity and calls to action, services, how booking works, then the booking form itself.
export async function CreativeProfile({ slug, pkg }: { slug: string; pkg?: string }) {
  const [p] = await profiles(slug);
  if (!p) notFound();
  const info = categoryInfo(p.category);
  const demo = demoProfile(p.slug);
  // "Jordan P." reads as Jordan; band and stage names stay whole.
  const name = p.stageName.replace(/^DEMO · /, '');
  const first = name.endsWith('.') ? name.split(' ')[0] : name;
  const socials = socialNetworks.filter((n) => p.socials?.[n.key]);
  const packages = p.packages ?? [];
  return (
    <div className="cp">
      <section className="cp-hero">
        <figure className="cp-photo">
          {demo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={demo.photo} alt={`${p.stageName}, ${p.headline ?? info.one}`} />
          ) : (
            <span aria-hidden="true">
              {p.stageName
                .replace(/^DEMO · /, '')
                .split(/\s+/)
                .map((w) => w[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </span>
          )}
        </figure>
        <div className="cp-intro">
          <p className="lp-kicker">
            {info.beta ? 'CURATED BETA · ' : ''}
            {info.one.toUpperCase()} · {p.parish.toUpperCase()}, JAMAICA
          </p>
          <h1>{p.stageName}</h1>
          <p className="cp-headline">{p.headline ?? info.one}</p>
          <p className="cp-meta">
            {demo ? (
              <span className="lp-rating">
                ★ {demo.rating.toFixed(1)}{' '}
                <span className="cp-muted">({demo.reviews} reviews, illustrative)</span>
              </span>
            ) : (
              <span className="lp-new">New to Lockd</span>
            )}
            <span className="cp-muted">
              {p.parish}, Jamaica · {packages.length} service{packages.length === 1 ? '' : 's'}
            </span>
          </p>
          <p className="cp-bio">{p.bio}</p>
          <p className="cp-tags">
            {packages.slice(0, 4).map((x) => (
              <span key={x.id}>{x.name.split(' · ')[0]}</span>
            ))}
          </p>
          <div className="cp-actions">
            <a className="button" href="#book">
              Request a booking →
            </a>
            <ShareProfile name={p.stageName} />
          </div>
          {socials.length > 0 && (
            <ul className="cp-socials" aria-label={`${p.stageName} on social media`}>
              {socials.map((n) => (
                <li key={n.key}>
                  <a href={p.socials[n.key]} target="_blank" rel="noopener noreferrer nofollow">
                    {n.label} ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="lp-section" id="services">
        <div className="lp-heading">
          <div>
            <h2>Services and booking options</h2>
            <p>Select the service that fits your event. All rates are in Jamaican dollars.</p>
          </div>
        </div>
        <div className="cp-services">
          {packages.map((x) => (
            <article key={x.id} className={x.id === pkg ? 'cp-service selected' : 'cp-service'}>
              <h3>{x.name}</h3>
              <p>{x.description}</p>
              <p className="cp-price">From {money(x.priceMinor)}</p>
              <p className="cp-muted">
                Deposit {money(x.depositMinor)} · {Math.round(x.durationMinutes / 60)} h
              </p>
              <Link href={`?package=${x.id}#book`} scroll={false} className="lp-link">
                Check availability →
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-steps-band">
        <div className="lp-section">
          <h2>How booking {first} works</h2>
          <div className="lp-steps">
            {[
              ['01', 'Choose your date', 'Select a service and request an available time.'],
              ['02', 'Review terms', 'Review the event details and sign the agreement.'],
              [
                '03',
                'Lockd in',
                `Pay ${first} directly. Your booking is confirmed once they verify the deposit.`,
              ],
            ].map(([n, t, d]) => (
              <div key={n} className="lp-step">
                <span className="lp-icon">{n}</span>
                <div>
                  <strong>{t}</strong>
                  <p>{d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section" id="book">
        <div className="lp-heading">
          <div>
            <h2>Request {first} for your date</h2>
            <p>No client account needed. Your date is held while you sign and pay the deposit.</p>
          </div>
        </div>
        <HoldForm key={pkg ?? 'default'} dj={p} initialPackage={pkg} />
      </section>
    </div>
  );
}
