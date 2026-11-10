'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { Booking } from '@/lib/service';
import { date, money, statusLabel } from '@/lib/format';
import { moneyToMinor } from '@/lib/validation';
import { api, Area, Field, Notice, Submit } from './forms';
import { BookingChanges } from './booking-changes';
export function BookingAccess({ id }: { id: string }) {
  const [data, setData] = useState<Booking | null>(null),
    [error, setError] = useState(''),
    [link, setLink] = useState('');
  const access = useRef<{ token: string; link: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (location.hash) access.current = { token: location.hash.slice(1), link: location.href };
    history.replaceState(null, '', location.pathname);
    void (async () => {
      try {
        if (access.current) {
          await api('access', { id, token: access.current.token });
          if (active) setLink(access.current.link);
        }
        const res = await fetch(`/api/bookings/${id}`, { cache: 'no-store' });
        if (!res.ok)
          throw new Error(
            'Open the original private booking link to access this booking. The link expires 90 days after your event.',
          );
        const b = await res.json();
        if (active) setData(b);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);
  if (!data)
    return (
      <div className="narrow">
        <h1>Your private booking.</h1>
        {error ? (
          <>
            <Notice error={error} />
            <LinkRecovery id={id} />
          </>
        ) : (
          <p role="status">Opening your booking…</p>
        )}
      </div>
    );
  return <BookingView initial={data} privateLink={link} />;
}
function LinkRecovery({ id }: { id: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(`bookings/${id}/request-link`, {
            email: String(new FormData(e.currentTarget).get('email') ?? ''),
          });
          setMessage(
            'If that email matches this booking, a fresh private link is on its way. Earlier links keep working.',
          );
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Lost your link?</h2>
      <p>Enter the email address you used when you held this date and we’ll send a new link.</p>
      <Field label="Booking email address" name="email" type="email" autoComplete="email" />
      <Notice error={error} message={message} />
      {!message && <Submit busy={busy}>Email me a private link</Submit>}
    </form>
  );
}
export function BookingView({
  initial,
  dj = false,
  privateLink = '',
}: {
  initial: Booking;
  dj?: boolean;
  privateLink?: string;
}) {
  const [b, setB] = useState(initial),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/bookings/${initial.id}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Access expired. Sign in again or reopen your private link.');
    setB(await res.json());
  }, [initial.id]);
  useEffect(() => {
    const t = setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 30000);
    return () => clearInterval(t);
  }, [refresh]);
  const expired = b.status === 'HOLD_EXPIRED',
    confirmed = b.status === 'CONFIRMED_LOCKD' || b.status === 'COMPLETED';
  return (
    <div className="shell booking-detail">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{dj ? 'DJ WORKSPACE' : 'YOUR PRIVATE BOOKING'}</p>
          <h1>
            {confirmed
              ? 'Date, Lockd.'
              : b.status === 'CANCELLED'
                ? 'Booking cancelled.'
                : expired
                  ? 'Let’s find a way forward.'
                  : 'Your event is taking shape.'}
          </h1>
        </div>
        <span className={`pill ${confirmed ? 'success' : ''}`}>{statusLabel(b.status)}</span>
      </div>
      {privateLink && (
        <div className="notice">
          <strong>Save your private access link.</strong>
          <p>
            Anyone with this link can access this booking. Keep it private; there is no client
            account.
          </p>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(privateLink);
                setCopied(true);
              } catch {
                setError('Copy the private link below and keep it safe.');
              }
            }}
          >
            {copied ? 'Copied' : 'Copy private booking link'}
          </button>
          <details>
            <summary>Show private link</summary>
            <input aria-label="Private booking link" readOnly value={privateLink} />
          </details>
        </div>
      )}
      <Notice error={error} />
      <ol className="progress" aria-label="Booking progress">
        <li className="done">01 · Date held</li>
        <li className={b.agreement.signer ? 'done' : ''}>02 · Agreement</li>
        <li className={b.claims.length ? 'done' : ''}>03 · Deposit evidence</li>
        <li className={confirmed ? 'done' : ''}>04 · DJ confirmation</li>
      </ol>
      {confirmed ? (
        <div className="confirmation">
          <h2>Your booking is confirmed.</h2>
          <p>
            The DJ attested receipt of {money(b.verified_minor)} directly. Your event date is
            reserved.
          </p>
        </div>
      ) : b.status === 'CANCELLED' ? (
        <div className="notice">
          <strong>The date has been released.</strong>
          <p>
            Signed agreements and payment history remain available. Any refund is managed directly
            by the DJ; see the cancellation record below.
          </p>
        </div>
      ) : expired ? (
        <div className="notice error">
          <strong>Your slot has been released.</strong>
          <p>
            Evidence and verified funds remain recorded. Contact the DJ for a new date or DJ-managed
            refund. A late payment cannot restore this slot automatically.
          </p>
        </div>
      ) : (
        <div className="notice">
          <strong>
            {b.grace_used ? 'One-time verification grace' : 'Provisional hold'} ends{' '}
            {date(b.expires_at)}.
          </strong>
          <p>
            {b.grace_used
              ? 'Further uploads will not extend this deadline.'
              : 'Sign and submit deposit evidence before the original expiry for one additional 24-hour review period.'}{' '}
            Confirmation requires the DJ’s actual receipt verification.
          </p>
        </div>
      )}
      <div className="split section">
        <div className="form">
          <section className="card">
            <p className="eyebrow">EVENT DETAILS</p>
            <h2>{b.client_name}</h2>
            <dl>
              <dt>Performance</dt>
              <dd>
                {date(b.starts_at)} — {date(b.ends_at)}
              </dd>
              <dt>Venue</dt>
              <dd>{b.venue}</dd>
              <dt>Service total</dt>
              <dd>{money(b.price_minor)}</dd>
              <dt>Required deposit</dt>
              <dd>{money(b.deposit_minor)}</dd>
              <dt>Actual funds verified</dt>
              <dd>{money(b.verified_minor)}</dd>
            </dl>
          </section>
          <section className="card">
            <p className="eyebrow">IMMUTABLE AGREEMENT · VERSION {b.agreement.version}</p>
            <h2>The details, agreed.</h2>
            <pre className="agreement">{b.agreement.body}</pre>
            <p className="fine hash">Content hash: {b.agreement.content_hash}</p>
            {b.agreement.signer ? (
              <div className="notice">
                Signed by {b.agreement.signer} on {date(b.agreement.accepted_at!)}.
              </div>
            ) : (
              !dj && b.status === 'AWAITING_SIGNATURE' && <SignForm b={b} refresh={refresh} />
            )}
          </section>
          {b.agreements
            .filter((a) => a.id !== b.agreement.id)
            .map((a) => (
              <details className="card" key={a.id}>
                <summary>
                  Preserved agreement · version {a.version}
                  {a.signer ? ' · signed' : ' · proposed'}
                </summary>
                <pre className="agreement">{a.body}</pre>
                <p className="fine hash">SHA-256: {a.content_hash}</p>
                {a.signer && (
                  <p>
                    Signed by {a.signer} on {date(a.accepted_at!)}.
                  </p>
                )}
              </details>
            ))}
        </div>
        <div className="form">
          <section className="card">
            <p className="eyebrow">DIRECT TO YOUR DJ</p>
            <h2>{b.status === 'CANCELLED' ? 'Your payment history.' : 'Secure your date.'}</h2>
            <div className="ink-panel deposit">
              <p className="eyebrow">
                {b.status === 'CANCELLED'
                  ? 'ORIGINAL AGREED DEPOSIT'
                  : 'DEPOSIT DUE DIRECTLY TO THE DJ'}
              </p>
              <strong>{money(b.deposit_minor)}</strong>
              <p>Of {money(b.price_minor)} total service fee</p>
            </div>
            <div className="note">
              <strong>
                {b.status === 'CANCELLED'
                  ? 'Original payment instructions · archived'
                  : 'Direct payment instructions'}
              </strong>
              <p className="instructions">
                {b.agreement.payment_instructions ||
                  b.agreement.body.slice(
                    b.agreement.body.lastIndexOf('Direct payment instructions: ') + 29,
                  )}
              </p>
              <p className="fine">Booking reference: {b.id}</p>
            </div>
            <h3>Deposit evidence</h3>
            <p>
              {b.status === 'CANCELLED'
                ? 'This booking is cancelled. Do not send further deposits. Existing evidence and verification decisions remain recorded.'
                : 'Follow the DJ’s payment instructions in the agreement. A receipt is a claim; the DJ checks their own account before confirming.'}
            </p>
            {!b.agreement.signer ? (
              <div className="note">Sign the agreement before uploading evidence.</div>
            ) : (
              !dj && !confirmed && b.status !== 'CANCELLED' && <ProofForm b={b} refresh={refresh} />
            )}
            <div className="claims">
              {b.claims.map((c) => (
                <article className="claim" key={c.id}>
                  <div className="section-heading">
                    <strong>{c.reference}</strong>
                    <span className="pill">{c.decision ?? 'Awaiting review'}</span>
                  </div>
                  <p>
                    Claimed {money(c.claimed_minor)} · {date(c.received_at)}
                  </p>
                  <p>
                    {c.on_time
                      ? 'Received before original hold expiry'
                      : 'Received after original hold expiry'}
                  </p>
                  <a href={`/api/receipts/${c.id}`} className="text-link">
                    Download private receipt ↓
                  </a>
                  {c.decision && (
                    <p>
                      Verified: {money(c.amount_minor ?? 0)} · {c.reason}
                    </p>
                  )}
                  {dj && !c.decision && !confirmed && b.status !== 'CANCELLED' && (
                    <VerifyForm b={b} claimId={c.id} refresh={refresh} />
                  )}
                </article>
              ))}
            </div>
            {!b.claims.length && <p className="fine">No deposit evidence submitted yet.</p>}
          </section>
          <section className="card">
            <p className="eyebrow">BOOKING HISTORY</p>
            <h2>Every step recorded.</h2>
            <ol className="timeline">
              {b.events.map((e, i) => (
                <li key={i}>
                  <strong>{statusLabel(e.kind).replaceAll('_', ' ')}</strong>
                  <span>{date(e.created_at)}</span>
                </li>
              ))}
            </ol>
          </section>
          {dj && b.status === 'CONFIRMED_LOCKD' && new Date(b.ends_at) < new Date() && (
            <button
              onClick={async () => {
                try {
                  await api(`bookings/${b.id}/complete`, {});
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Mark event completed
            </button>
          )}
        </div>
      </div>
      <BookingChanges b={b} dj={dj} refresh={refresh} />
      {dj && <Link href="/dashboard">← All bookings</Link>}
    </div>
  );
}
function SignForm({ b, refresh }: { b: Booking; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const d = new FormData(e.currentTarget);
          await api(`bookings/${b.id}/sign`, {
            agreementId: b.agreement.id,
            contentHash: b.agreement.content_hash,
            signer: String(d.get('signer')),
            accept: d.get('accept') === 'on',
          });
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Full name as your signature" name="signer" minLength={2} maxLength={120} />
      <label className="check">
        <input type="checkbox" name="accept" required />
        <span>
          I have read and accept this exact agreement and intend my typed name to be my signature.
        </span>
      </label>
      <Notice error={error} />
      <Submit busy={busy}>Sign agreement →</Submit>
    </form>
  );
}
function ProofForm({ b, refresh }: { b: Booking; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = new FormData(e.currentTarget);
      d.set('amountMinor', String(moneyToMinor(String(d.get('amount')))));
      await api(`bookings/${b.id}/proof`, d);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Payment reference" name="reference" minLength={2} maxLength={100} />
      <Field label="Amount you sent (JMD)" name="amount" inputMode="decimal" />
      <Field
        label="Receipt image (PNG or JPEG, up to 5 MB)"
        name="file"
        type="file"
        accept="image/png,image/jpeg"
      />
      <Notice error={error} />
      <Submit busy={busy}>Submit evidence for DJ review</Submit>
    </form>
  );
}
function VerifyForm({
  b,
  claimId,
  refresh,
}: {
  b: Booking;
  claimId: string;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [decision, setDecision] = useState('received');
  return (
    <form
      className="form verify-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const d = new FormData(e.currentTarget);
          await api(`bookings/${b.id}/verify`, {
            claimId,
            decision,
            amountMinor: decision === 'received' ? moneyToMinor(String(d.get('amount'))) : 0,
            bankReference: decision === 'received' ? String(d.get('bankReference')) : '',
            reason: String(d.get('reason')),
            attest: d.get('attest') === 'on',
          });
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Check your payment account.</h3>
      <label className="field">
        <span>Verification decision</span>
        <select value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="received">Actual funds received</option>
          <option value="rejected">Reject evidence</option>
        </select>
      </label>
      {decision === 'received' && (
        <>
          <Field label="Actual amount received (JMD)" name="amount" inputMode="decimal" />
          <Field
            label="Reference in your payment account"
            name="bankReference"
            minLength={2}
            maxLength={100}
          />
          <label className="check">
            <input type="checkbox" name="attest" required />
            <span>
              I checked my own payment account and attest that these funds were actually received. I
              am not relying on the uploaded receipt alone.
            </span>
          </label>
        </>
      )}
      <Area label="Reconciliation notes / reason" name="reason" minLength={3} maxLength={1000} />
      <p className="fine">
        This decision is permanent and recorded with your identity. Record only this receipt’s
        amount; previous verified funds are already counted.
      </p>
      <Notice error={error} />
      <Submit busy={busy}>Record verification decision</Submit>
    </form>
  );
}
