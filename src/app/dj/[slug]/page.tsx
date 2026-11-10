import { notFound } from 'next/navigation';
import { profiles } from '@/lib/service';
import { HoldForm } from '@/components/forms';
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [dj] = await profiles(slug);
  if (!dj) notFound();
  return (
    <div className="shell">
      <section className="profile-hero">
        <div>
          <p className="eyebrow">{dj.parish}, Jamaica · DJ</p>
          <h1>{dj.stageName}</h1>
          <p className="lede">{dj.bio}</p>
        </div>
        <aside className="note">
          <p className="eyebrow">YOUR EVENT. YOUR MUSIC.</p>
          <h3>Your date starts here.</h3>
          <p>
            Choose a package, sign your agreement, and pay the DJ directly. Your DJ confirms once
            the deposit is received.
          </p>
          <span className="pill">No client account needed</span>
        </aside>
      </section>
      <HoldForm dj={dj} />
    </div>
  );
}
