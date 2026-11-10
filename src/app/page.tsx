import Link from 'next/link';
import { profiles } from '@/lib/service';
import { money } from '@/lib/format';
export default async function Home() {
  const djs = await profiles();
  return (
    <div className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">JAMAICAN DJs. ONE SIMPLE BOOKING.</p>
          <h1>
            Good music.
            <br />
            Great memories.
            <br />
            <em>Date, Lockd.</em>
          </h1>
          <p className="lede">
            Find your DJ, agree the details, and secure your date with a direct deposit verified by
            the person playing your event.
          </p>
          <a className="button" href="#djs">
            Find your sound <span>↗</span>
          </a>
        </div>
        <aside className="process">
          <p className="eyebrow">FROM FIRST CLICK TO CONFIRMED</p>
          <ol>
            <li>
              <span>01</span>
              <div>
                <strong>Choose your DJ</strong>
                <p>A package, a date, a great fit.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Make it official</strong>
                <p>Review and sign your agreement.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Lock di date</strong>
                <p>Pay your DJ directly. They verify receipt.</p>
              </div>
            </li>
          </ol>
          <p className="fine">No client account required. A private link keeps you up to date.</p>
        </aside>
      </section>
      <section id="djs" className="section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE PEOPLE BEHIND THE MUSIC</p>
            <h2>Find your DJ.</h2>
          </div>
          <span className="pill">Jamaica · DJ bookings</span>
        </div>
        {djs.length ? (
          <div className="cards">
            {djs.map((d) => (
              <Link key={d.id} href={`/dj/${d.slug}`} className="card profile-card">
                <span className="monogram">{d.stageName.slice(0, 2).toUpperCase()}</span>
                <p className="eyebrow">{d.parish}, Jamaica</p>
                <h3>{d.stageName}</h3>
                <p>{d.bio}</p>
                <div className="card-bottom">
                  <strong>{money(Math.min(...d.packages.map((p) => p.priceMinor)))}</strong>
                  <span>View packages ↗</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>The next great booking starts here.</h3>
            <p>No DJs have published a booking page yet.</p>
            <Link href="/register" className="button">
              Set up your DJ page →
            </Link>
          </div>
        )}
      </section>
      <section className="cta-band">
        <div>
          <p className="eyebrow">FOR WORKING DJs</p>
          <h2>
            Your business.
            <br />
            All on one link.
          </h2>
          <p>Packages, agreements, deposits and dates. Start with three active bookings on Free.</p>
        </div>
        <Link href="/register" className="button">
          Create your booking page ↗
        </Link>
      </section>
    </div>
  );
}
