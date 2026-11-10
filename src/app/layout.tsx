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
          <nav aria-label="Main" className="main-nav">
            <Link href="/#creatives">Find creatives</Link>
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/register">For creatives</Link>
            <Link href="/#about">About</Link>
          </nav>
          <div className="header-actions">
            <Link href="/dashboard">Log in</Link>
            <Link className="button header-cta" href="/register">
              List your talent ↗
            </Link>
          </div>
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
        <footer id="about">
          <Link className="brand small" href="/">
            <Image src="/lockd-mark.svg" alt="" width={26} height={26} unoptimized />
            Lockd
          </Link>
          <div className="footer-tagline">
            <strong>Great moments begin with great people.</strong>
            <span>
              Booking tools for creatives and their clients. Deposits go directly to your DJ.
            </span>
          </div>
          <nav aria-label="Footer" className="footer-links">
            <Link href="/#creatives">Explore creatives</Link>
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/register">List your talent</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
