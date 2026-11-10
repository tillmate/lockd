'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="narrow" role="alert">
      <h1>Something needs attention.</h1>
      <p>We could not load this page. Check that the local database is running, then try again.</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
