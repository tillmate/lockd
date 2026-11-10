import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="narrow">
      <h1>We couldn’t find that page.</h1>
      <p>Private bookings need their original access link or the owning DJ’s session.</p>
      <Link className="button" href="/">
        Back to Lockd
      </Link>
    </div>
  );
}
