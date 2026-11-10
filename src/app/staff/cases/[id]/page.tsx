import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { labels, outcomes, viewCase } from '@/lib/support';
import { date, money, statusLabel } from '@/lib/format';
import {
  CloseCaseForm,
  EvidenceViewer,
  ExtendForm,
  LinkBookingForm,
  NoteForm,
} from '@/components/support';
import { staffPage, StaffNav } from '../../access';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const page = await staffPage('support');
  if ('gate' in page) return page.gate;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  // Unknown cases and cases about the staff member's own account look the same: not found.
  const v = await viewCase(page.ctx, id).catch((e: Error & { code?: string }) => {
    if (/not found/i.test(e.message) || e.code === '42501') notFound();
    throw e;
  });
  const c = v.case;
  const open = c.state === 'open';
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            SUPPORT CASE #{c.number} · {c.state.toUpperCase()}
          </p>
          <h1>{c.stageName}</h1>
          <p>
            {labels[c.category]} · raised by {labels[c.requester].toLowerCase()} · opened{' '}
            {date(c.createdAt)} by {c.openedBy}
          </p>
        </div>
        <span className={`pill ${open ? '' : 'success'}`}>
          {open ? 'Open' : `Closed · ${labels[c.outcome ?? ''] ?? c.outcome}`}
        </span>
      </div>
      <StaffNav />
      <div className="notice" role="status">
        <strong>
          {c.recordsAvailable
            ? `Record access ends ${date(c.accessExpiresAt)}.`
            : open
              ? 'Record access has ended.'
              : 'This case is closed; booking records are no longer shown.'}
        </strong>
        <p>
          {c.summary} · DJ contact: {c.djEmail} · listing {c.listingState}
        </p>
      </div>
      <div className="split section">
        <div className="form">
          {v.records?.map((r) => (
            <section className="card" key={r.booking.id} aria-label={`Booking ${r.booking.id}`}>
              <p className="eyebrow">LINKED BOOKING · {r.booking.id}</p>
              <h2>
                {r.booking.clientName} · {statusLabel(r.booking.status)}
              </h2>
              <dl>
                <dt>Client contact</dt>
                <dd>{r.booking.clientEmail}</dd>
                <dt>Performance</dt>
                <dd>
                  {date(r.booking.startsAt)} — {date(r.booking.endsAt)} · {r.booking.venue}
                </dd>
                <dt>Total / deposit / verified</dt>
                <dd>
                  {money(r.booking.priceMinor)} / {money(r.booking.depositMinor)} /{' '}
                  {money(r.booking.verifiedMinor)}
                </dd>
                <dt>Hold</dt>
                <dd>
                  Created {date(r.booking.createdAt)} · original expiry{' '}
                  {date(r.booking.originalExpiresAt)}
                  {r.booking.graceUsed ? ` · grace until ${date(r.booking.expiresAt)}` : ''}
                </dd>
              </dl>
              <h3>Payment evidence and DJ decisions</h3>
              {r.claims.map((k) => (
                <article className="claim" key={k.id}>
                  <p>
                    <strong>{k.reference}</strong> · claimed {money(k.claimedMinor)} ·{' '}
                    {date(k.receivedAt)} ·{' '}
                    {k.onTime ? 'before original expiry' : 'after original expiry'}
                  </p>
                  <p>
                    {k.decision
                      ? `DJ ${k.decision}: ${money(k.amountMinor ?? 0)}${k.bankReference ? ` · bank ref ${k.bankReference}` : ''} · ${k.reason} · ${date(k.decidedAt!)}`
                      : 'Awaiting DJ decision'}
                  </p>
                  {c.recordsAvailable && <EvidenceViewer caseId={c.id} claimId={k.id} />}
                </article>
              ))}
              {!r.claims.length && <p className="fine">No evidence submitted.</p>}
              {(r.cancellations.length > 0 || r.openRequests.length > 0) && (
                <>
                  <h3>Cancellation and refunds</h3>
                  {r.openRequests.map((q, i) => (
                    <p key={i}>
                      Open client request {date(q.requestedAt)}: {q.reason}
                    </p>
                  ))}
                  {r.cancellations.map((d, i) => (
                    <p key={i}>
                      {d.initiatedBy === 'dj' ? 'DJ cancelled' : `Client request ${d.decision}`}{' '}
                      {date(d.decidedAt)} · refund {money(d.refundMinor)} of{' '}
                      {money(d.verifiedMinor)} verified (suggested {money(d.suggestedMinor)})
                      {d.dueAt ? ` · due ${date(d.dueAt)}` : ''} ·{' '}
                      {d.refundedAt
                        ? `DJ recorded transfer ${d.refundReference} on ${date(d.refundedAt)}`
                        : d.refundMinor > 0
                          ? 'transfer not yet recorded'
                          : 'no refund'}
                      {d.acknowledgedAt ? ` · client confirmed ${date(d.acknowledgedAt)}` : ''}
                    </p>
                  ))}
                </>
              )}
              {r.amendments.length > 0 && (
                <>
                  <h3>Date changes</h3>
                  {r.amendments.map((m, i) => (
                    <p key={i}>
                      {m.proposedBy} proposed {date(m.newStart)} (from {date(m.oldStart)}) ·{' '}
                      {m.state} · {m.reason}
                    </p>
                  ))}
                </>
              )}
              <details>
                <summary>Agreements ({r.agreements.length})</summary>
                {r.agreements.map((a) => (
                  <div key={a.id}>
                    <p className="fine">
                      Version {a.version} · SHA-256 {a.contentHash}
                      {a.signatures.map((s) => ` · signed by ${s.signer} ${date(s.acceptedAt)}`)}
                    </p>
                    <pre className="agreement">{a.body}</pre>
                  </div>
                ))}
              </details>
              <details>
                <summary>History ({r.events.length} events)</summary>
                <ol className="timeline">
                  {r.events.map((e, i) => (
                    <li key={i}>
                      <strong>
                        {e.kind.replaceAll('_', ' ').toLowerCase()} · {e.actor}
                      </strong>
                      <span>{date(e.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              </details>
              <details>
                <summary>Email delivery ({r.deliveries.length})</summary>
                <ul>
                  {r.deliveries.map((d, i) => (
                    <li key={i}>
                      {d.kind} → {d.audience} {d.recipient} · {d.status} · {d.attempts} attempt
                      {d.attempts === 1 ? '' : 's'}
                      {d.deliveredAt ? ` · delivered ${date(d.deliveredAt)}` : ''}
                      {d.lastError ? ` · ${d.lastError}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ))}
          {c.recordsAvailable && v.candidates && (
            <section className="card">
              <h2>Link a booking</h2>
              <LinkBookingForm caseId={c.id} candidates={v.candidates} />
            </section>
          )}
          {!c.recordsAvailable && v.linked.length > 0 && (
            <p className="fine">
              {v.linked.length} booking{v.linked.length === 1 ? '' : 's'} linked; records hidden.
            </p>
          )}
        </div>
        <div className="form">
          <section className="card">
            <h2>Notes</h2>
            {v.notes.map((n, i) => (
              <article className="note" key={i}>
                <p>{n.body}</p>
                <p className="fine">
                  {n.author} · {date(n.createdAt)}
                </p>
              </article>
            ))}
            {!v.notes.length && <p className="fine">No notes yet.</p>}
            {open && <NoteForm caseId={c.id} />}
          </section>
          {open && (
            <section className="card">
              <h2>Access and closure</h2>
              {c.extensions < 3 && <ExtendForm caseId={c.id} />}
              <CloseCaseForm caseId={c.id} outcomes={outcomes} labels={labels} />
            </section>
          )}
          <section className="card">
            <h2>Linked bookings</h2>
            {v.linked.map((l) => (
              <p key={l.bookingId}>
                {l.bookingId.slice(0, 8)} · {l.reason} · {l.linkedBy} · {date(l.createdAt)}
              </p>
            ))}
            {!v.linked.length && <p className="fine">None yet.</p>}
          </section>
          <Link href="/staff/cases">← All cases</Link>
        </div>
      </div>
    </div>
  );
}
