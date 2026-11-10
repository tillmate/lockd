'use client';
import { useState, type ReactNode } from 'react';
import type { Booking } from '@/lib/service';
import { date, money } from '@/lib/format';
import { moneyToMinor } from '@/lib/validation';
import { api, Area, Field, Notice, Submit, jamaicaISO } from './forms';
function ActionForm({
  label,
  children,
  run,
}: {
  label: string;
  children: ReactNode;
  run: (d: FormData) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const d = new FormData(e.currentTarget);
        try {
          await run(d);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <Notice error={error} />
      <Submit busy={busy}>{label}</Submit>
    </form>
  );
}
const val = (d: FormData, k: string) => String(d.get(k) ?? '');
export function BookingChanges({
  b,
  dj,
  refresh,
}: {
  b: Booking;
  dj: boolean;
  refresh: () => Promise<void>;
}) {
  const party = dj ? 'dj' : 'client',
    pending = b.amendments.find((m) => m.state === 'pending'),
    request = b.cancellations.find((q) => !q.decision);
  const active =
    !['CANCELLED', 'COMPLETED', 'HOLD_EXPIRED'].includes(b.status) &&
    new Date(b.starts_at) > new Date();
  async function act(action: string, data: unknown) {
    await api(`bookings/${b.id}/${action}`, data);
    await refresh();
  }
  return (
    <div className="section form">
      <div className="section-heading">
        <h2>Changes, kept clear.</h2>
        <span className="pill">History preserved</span>
      </div>
      <div className="split">
        <section className="card form">
          <p className="eyebrow">DATE CHANGES</p>
          <h3>{active ? 'Your original date stays reserved.' : 'Your date-change history.'}</h3>
          <p>
            A proposed date is not held. It replaces the original only when both parties accept the
            exact amendment and the date is still available, including setup and travel time.
          </p>
          {b.status === 'CONFIRMED_LOCKD' && !b.reschedules_used && !pending && !request && (
            <details>
              <summary>Propose a complimentary date change</summary>
              <p>
                One move requested at least 14 days before your event, within 90 days of the
                original date. The service, venue and price stay the same. Both signatures are
                required within 48 hours.
              </p>
              <ActionForm
                label="Propose date change"
                run={(d) =>
                  act('propose-change', {
                    party,
                    startsAt: jamaicaISO(val(d, 'startsAt')),
                    reason: val(d, 'reason'),
                  })
                }
              >
                <Field
                  label="Proposed start (Jamaica time)"
                  name="startsAt"
                  type="datetime-local"
                />
                <Area label="Reason for date change" name="reason" minLength={3} maxLength={1000} />
              </ActionForm>
            </details>
          )}
          {!!b.reschedules_used && (
            <p className="notice">The complimentary date change has been used.</p>
          )}
          {b.amendments.map((m) => {
            const a = b.agreements.find((a) => a.id === m.agreement_id)!;
            const signed = m.acceptances.some((x) => x.party === party);
            return (
              <article className="note form" key={m.id}>
                <div className="section-heading">
                  <strong>Agreement amendment · v{a.version}</strong>
                  <span className="pill">{m.state}</span>
                </div>
                <dl>
                  <dt>Original start</dt>
                  <dd>{date(m.old_start)}</dd>
                  <dt>Proposed start</dt>
                  <dd>{date(m.new_start)}</dd>
                  <dt>Proposed end</dt>
                  <dd>{date(m.new_end)}</dd>
                  <dt>Reason</dt>
                  <dd>{m.reason}</dd>
                  <dt>Verified deposit carried forward</dt>
                  <dd>{money(b.verified_minor)}</dd>
                </dl>
                <details>
                  <summary>Read exact amended agreement</summary>
                  <pre className="agreement">{a.body}</pre>
                  <p className="fine hash">SHA-256: {a.content_hash}</p>
                </details>
                {m.acceptances.map((x) => (
                  <p key={x.party}>
                    {x.party === 'dj' ? 'DJ' : 'Client'} accepted as {x.signer} ·{' '}
                    {date(x.created_at)}
                  </p>
                ))}
                {m.state === 'pending' && (
                  <>
                    <p className="notice">
                      Acceptance deadline: {date(m.expires_at)}.{' '}
                      {request
                        ? 'Resolve the cancellation request before accepting this change.'
                        : 'The original date remains reserved until both parties accept.'}
                    </p>
                    {!signed && !request && (
                      <ActionForm
                        label="Accept amended agreement"
                        run={(d) =>
                          act('respond-change', {
                            amendmentId: m.id,
                            party,
                            action: 'accept',
                            contentHash: a.content_hash,
                            signer: val(d, 'signer'),
                            accept: d.get('accept') === 'on',
                          })
                        }
                      >
                        <Field
                          label="Full name for amended agreement"
                          name="signer"
                          minLength={2}
                          maxLength={120}
                        />
                        <label className="check">
                          <input type="checkbox" name="accept" required />
                          <span>
                            I read and accept this exact amended agreement. I understand the date
                            changes only after both parties accept and availability is checked.
                          </span>
                        </label>
                      </ActionForm>
                    )}
                    <ActionForm
                      label={
                        m.proposed_by === party ? 'Withdraw date change' : 'Decline date change'
                      }
                      run={() =>
                        act('respond-change', {
                          amendmentId: m.id,
                          party,
                          action: m.proposed_by === party ? 'withdraw' : 'decline',
                          contentHash: a.content_hash,
                          signer: '',
                          accept: false,
                        })
                      }
                    >
                      {null}
                    </ActionForm>
                  </>
                )}
              </article>
            );
          })}
          {!b.amendments.length && <p className="fine">No date changes requested.</p>}
        </section>
        <section className="card form">
          <p className="eyebrow">CANCELLATION & DIRECT REFUNDS</p>
          <h3>Know where things stand.</h3>
          <p>
            A client request keeps the existing reservation until the DJ approves cancellation or
            the original hold expires. Lockd records the decision and any refund obligation. It does
            not transfer money.
          </p>
          {b.cancellations.map((q) => (
            <div className="note" key={q.id}>
              <strong>
                {q.decision ? `Client request ${q.decision}` : 'Client cancellation requested'}
              </strong>
              <p>{q.reason}</p>
              <p>{date(q.created_at)}</p>
            </div>
          ))}
          {active && !dj && !request && (
            <details>
              <summary>Request cancellation</summary>
              <ActionForm
                label="Send cancellation request"
                run={(d) => act('request-cancellation', { reason: val(d, 'reason') })}
              >
                <Area
                  label="Reason for cancellation request"
                  name="reason"
                  minLength={3}
                  maxLength={1000}
                />
              </ActionForm>
            </details>
          )}
          {active && dj && (
            <details>
              <summary>
                {request ? 'Review client cancellation request' : 'Cancel as the DJ'}
              </summary>
              <CancellationForm b={b} request={request} act={act} />
            </details>
          )}
          {b.decisions.map((d) => (
            <article className="note form" key={d.id}>
              <div className="section-heading">
                <strong>
                  {d.initiated_by === 'dj' ? 'DJ cancellation' : 'Client cancellation decision'}
                </strong>
                <span className="pill">{d.decision}</span>
              </div>
              <p>{d.reason}</p>
              <p>Recorded contract / legal basis: {d.basis}</p>
              {d.decision === 'approved' && (
                <>
                  <p>
                    <strong>Refund owed directly by DJ: {money(d.refund_minor)}</strong>
                  </p>
                  {d.due_at && (
                    <p>
                      Recorded due date: {date(d.due_at)}. This uses a conservative seven calendar
                      days, within the seven business day limit.
                    </p>
                  )}
                  {d.refund_minor > 0 && !d.refund_reference && (
                    <>
                      <p className="notice">Refund outstanding. No transfer has been recorded.</p>
                      {dj && (
                        <ActionForm
                          label="Record direct refund attestation"
                          run={(f) =>
                            act('record-refund', {
                              decisionId: d.id,
                              reference: val(f, 'reference'),
                              attest: f.get('attest') === 'on',
                            })
                          }
                        >
                          <Field
                            label="Refund transfer reference"
                            name="reference"
                            minLength={2}
                            maxLength={100}
                          />
                          <label className="check">
                            <input type="checkbox" name="attest" required />
                            <span>
                              I have already returned the full recorded refund directly to the
                              client and checked my payment account. This records a past transfer.
                            </span>
                          </label>
                        </ActionForm>
                      )}
                    </>
                  )}
                  {d.refund_reference && (
                    <>
                      <p>
                        DJ attested transfer · {d.refund_reference} · {date(d.refunded_at!)}.
                      </p>
                      {d.acknowledged_at ? (
                        <p className="notice">
                          Client acknowledged actual receipt on {date(d.acknowledged_at)}.
                        </p>
                      ) : (
                        <>
                          <p>Awaiting client acknowledgement of receipt.</p>
                          {!dj && (
                            <ActionForm
                              label="Acknowledge refund received"
                              run={(f) =>
                                act('acknowledge-refund', {
                                  decisionId: d.id,
                                  attest: f.get('attest') === 'on',
                                })
                              }
                            >
                              <label className="check">
                                <input type="checkbox" name="attest" required />
                                <span>
                                  I checked my own account and actually received the full recorded
                                  refund.
                                </span>
                              </label>
                            </ActionForm>
                          )}
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
function CancellationForm({
  b,
  request,
  act,
}: {
  b: Booking;
  request: Booking['cancellations'][number] | undefined;
  act: (action: string, data: unknown) => Promise<void>;
}) {
  const [approve, setApprove] = useState(true);
  const suggested = request
    ? new Date(b.starts_at).getTime() - new Date(request.created_at).getTime() >= 14 * 86400000
      ? Math.ceil(b.verified_minor / 2)
      : 0
    : b.verified_minor;
  return (
    <ActionForm
      label="Record cancellation decision"
      run={(d) =>
        act('decide-cancellation', {
          requestId: request?.id ?? null,
          approve,
          refundMinor: approve ? moneyToMinor(val(d, 'refund')) : 0,
          reason: val(d, 'reason'),
          basis: val(d, 'basis'),
          attest: d.get('attest') === 'on',
        })
      }
    >
      <p>
        Proposed default: client notice of at least 14 days returns 50% of the verified deposit;
        shorter notice returns 0%. A DJ cancellation returns 100%. These defaults await legal
        validation. Review the actual signed terms and applicable obligations before recording a
        decision.
      </p>
      {request && (
        <label className="field">
          <span>Cancellation decision</span>
          <select
            value={approve ? 'approve' : 'decline'}
            onChange={(e) => setApprove(e.target.value === 'approve')}
          >
            <option value="approve">Approve cancellation and release date</option>
            <option value="decline">Decline request and keep reservation</option>
          </select>
        </label>
      )}
      {approve && (
        <>
          <p>
            Suggested refund based on request time: {money(suggested)}. Actual verified funds:{' '}
            {money(b.verified_minor)}.
          </p>
          <Field
            label="Refund owed (JMD)"
            name="refund"
            inputMode="decimal"
            defaultValue={(suggested / 100).toFixed(2)}
            readOnly={!request}
          />
        </>
      )}
      <Area label="Cancellation decision reason" name="reason" minLength={3} maxLength={1000} />
      <Area
        label="Signed agreement / legal basis for this decision"
        name="basis"
        minLength={10}
        maxLength={1000}
      />
      <label className="check">
        <input type="checkbox" name="attest" required />
        <span>
          I reviewed the signed agreement and applicable refund obligations. I accept responsibility
          for any refund recorded here. Approval releases the reserved date.
        </span>
      </label>
    </ActionForm>
  );
}
