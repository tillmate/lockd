import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import './globals.css';
import { localMode } from '@/lib/auth';
import { stagingMode } from '@/lib/env';
export const metadata: Metadata = {
  title: 'Lockd — Lock di date',
  description: 'Direct DJ bookings, signed agreements and verified deposits in Jamaica.',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-JM" data-scroll-behavior="smooth">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="header">
          <Link className="brand" href="/">
            <Image src="/lockd-mark.svg" alt="" width={31} height={31} unoptimized />
            Lockd<span className="dot">.</span>
          </Link>
          <nav aria-label="Main">
            <Link href="/">Find a DJ</Link>
            <Link href="/dashboard">DJ workspace</Link>
          </nav>
        </header>
        {localMode() && (
          <div className="local">
            Local development · No funds move through this app{' '}
            <Link href="/dev/mailbox">Test mailbox ↗</Link>
          </div>
        )}
        {stagingMode() && (
          <div className="local">
            Staging demo · Synthetic data only · No real payments or emails
          </div>
        )}
        <main id="main">{children}</main>
        <footer>
          <Link className="brand small" href="/">
            Lockd.
          </Link>
          <span>Made for your next great event. Jamaica.</span>
          <span>Deposits go directly to your DJ.</span>
        </footer>
      </body>
    </html>
  );
}
