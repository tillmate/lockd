'use client';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { BillingHome, InvoiceDetail } from '@/lib/billing';
import { date, money } from '@/lib/format';
import { moneyToMinor } from '@/lib/validation';
import { api, Area, Field, Notice, Submit, jamaicaISO } from './forms';
const names: Record<string, string> = {
  monthly: 'Pro Monthly',
  annual: 'Pro Annual',
  founding: 'Founding DJ',
};
export function BillingForm({
  label,
  run,
  children,
  disabled = false,
}: {
  label: string;
  run: (d: FormData) => Promise<void>;
  children: ReactNode;
  disabled?: boolean;
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
      {disabled ? (
        <button className="button" disabled type="button">
          Collection not configured
        </button>
      ) : (
        <Submit busy={busy}>{label}</Submit>
      )}
    </form>
  );
}
export function PlanPicker({ data }: { data: BillingHome }) {
  const router = useRouter(),
    [plan, setPlan] = useState(data.subscription?.plan ?? 'monthly');
  const outstanding = data.invoices.some(
    (i) => i.state === 'open' || i.state === 'requires_resolution',
  );
  return (
    <div className="card form">
      <p className="eyebrow">LOCKD FOR CREATIVES</p>
      <h2>Choose the plan that fits.</h2>
      <p>
        Your software subscription is separate from client deposits. There is no card charge or
        automatic renewal.
      </p>
      <div className="note">
        <strong>Free · J$0</strong>
        <p>Up to three active bookings. Records remain accessible after a downgrade.</p>
      </div>
      {!data.configured && (
        <p className="notice">
          Subscription collection is not configured. No payment is requested. Your Free account
          remains available.
        </p>
      )}
      {outstanding ? (
        <p className="notice">Open your existing invoice below before requesting another.</p>
      ) : (
        <BillingForm
          label="Create manual JMD invoice"
          disabled={!data.configured}
          run={async (d) => {
            const res = await api('billing/invoices', {
              plan,
              billingName: String(d.get('billingName')),
              billingEmail: String(d.get('billingEmail')),
              requestId: crypto.randomUUID(),
            });
            router.push(`/dashboard/billing/${res.id}`);
          }}
        >
          <fieldset disabled={!data.configured} className="form">
            <legend>Subscription plan</legend>
            {[
              ['monthly', 350000, 'Flexible monthly software subscription.'],
              ['annual', 3600000, 'One year, equivalent to J$3,000 per month.'],
              [
                'founding',
                2500000,
                'First 50 approved and verified-paying Jamaican DJs. An invoice does not reserve a place.',
              ],
            ].map(([key, amount, description]) => (
              <label className={`plan-option ${plan === key ? 'selected' : ''}`} key={key}>
                <input
                  type="radio"
                  name="plan"
                  value={key}
                  checked={plan === key}
                  disabled={key === 'founding' && !data.approved}
                  onChange={() => setPlan(String(key))}
                />
                <span>
                  <strong>
                    {names[key]} · {money(Number(amount))}
                    {key === 'monthly' ? '/month' : '/year'}
                  </strong>
                  <span className="fine">{description}</span>
                </span>
              </label>
            ))}
            {!data.approved && (
              <p className="fine">
                Founding selection requires independent staff approval of Jamaican DJ eligibility.
              </p>
            )}
            {plan === 'founding' && (
              <p className="notice">
                The annual J$25,000 rate is retained only when every renewal is paid within seven
                calendar days of its due date. Membership is non-transferable.
              </p>
            )}
            <Field label="Business billing name" name="billingName" minLength={2} maxLength={120} />
            <Field label="Billing email" name="billingEmail" type="email" maxLength={254} />
          </fieldset>
        </BillingForm>
      )}
    </div>
  );
}
export function StaffMFA({ area = 'billing' }: { area?: 'billing' | 'operations' }) {
  const router = useRouter();
  return (
    <div className="narrow card">
      <p className="eyebrow">{area === 'billing' ? 'BILLING STAFF' : 'LOCKD STAFF'}</p>
      <h1>Verify it’s you.</h1>
      <p>
        {area === 'billing'
          ? 'Use your authenticator to unlock billing review for ten minutes. Billing access does not include clients’ booking agreements or DJ deposit evidence.'
          : 'Use your authenticator to unlock staff tools for ten minutes. Every action is recorded with your reason. Staff tools never show clients’ agreements, receipts or private links.'}
      </p>
      <BillingForm
        label={area === 'billing' ? 'Unlock billing review' : 'Unlock staff tools'}
        run={async (d) => {
          await api('staff/mfa', { code: String(d.get('code')) });
          router.refresh();
        }}
      >
        <Field
          label="Authenticator code"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          autoComplete="one-time-code"
        />
      </BillingForm>
    </div>
  );
}
export function ApproveFounder({ id }: { id: string }) {
  const router = useRouter();
  return (
    <details>
      <summary>Review founding eligibility</summary>
      <BillingForm
        label="Approve founding eligibility"
        run={async (d) => {
          await api('staff/approve-founding', {
            accountId: id,
            reason: String(d.get('reason')),
            attest: d.get('attest') === 'on',
          });
          router.refresh();
        }}
      >
        <Area label="Eligibility review reason" name="reason" minLength={10} maxLength={1000} />
        <label className="check">
          <input type="checkbox" name="attest" required />
          <span>
            I independently reviewed this Jamaican DJ’s eligibility. Approval alone does not
            allocate a founding place or activate paid access.
          </span>
        </label>
      </BillingForm>
    </details>
  );
}
export function InvoiceView({
  initial,
  staff = false,
}: {
  initial: InvoiceDetail;
  staff?: boolean;
}) {
  const [i, setI] = useState(initial);
  async function refresh() {
    const res = await fetch(`/api/invoices/${i.id}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Invoice access expired. Sign in or renew staff verification.');
    setI(await res.json());
  }
  return (
    <div className="shell">
      <Link href={staff ? '/staff/billing' : '/dashboard/billing'}>
        ← {staff ? 'Billing review' : 'My subscription'}
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOCKD SOFTWARE SUBSCRIPTION</p>
          <h1>{i.state === 'paid' ? 'Invoice reconciled.' : 'Review your subscription.'}</h1>
          <p>
            Invoice LKD-SUB-{i.number} · {names[i.plan]}
          </p>
        </div>
        <span className="pill">{i.state.replaceAll('_', ' ')}</span>
      </div>
      {i.state === 'requires_resolution' && (
        <div className="notice error">
          <strong>Verified funds require billing resolution.</strong>
          <p>
            Paid access was not granted. A founding place may no longer be available, renewal may
            have been late, or the subscription changed. Staff must arrange an authorized
            alternative or refund. No automatic downgrade, refund or additional charge has occurred.
          </p>
        </div>
      )}
      <div className="split">
        <section className="card form">
          <p className="eyebrow">PLAN SUMMARY</p>
          <h2>{money(i.amount_minor)}</h2>
          <dl>
            <dt>Bill to</dt>
            <dd>
              {i.billing_name}
              <br />
              {i.billing_email}
            </dd>
            <dt>Software plan</dt>
            <dd>
              {names[i.plan]} · {i.plan === 'monthly' ? 'Monthly' : 'Yearly'}
            </dd>
            <dt>Issued</dt>
            <dd>{date(i.created_at)}</dd>
            <dt>Due</dt>
            <dd>{date(i.due_at)}</dd>
            <dt>Actual bank receipts verified</dt>
            <dd>{money(i.verified_minor)}</dd>
          </dl>
          <div className="note">
            <strong>{i.seller_name}</strong>
            <p className="instructions">{i.instructions}</p>
            <p>Use invoice LKD-SUB-{i.number} as the reference.</p>
          </div>
          <p className="fine">
            No tax invoice compliance is claimed for this local test document. Legal business and
            tax particulars must be configured before live collection.
          </p>
          {i.state === 'paid' ? (
            <p className="notice">
              Staff reconciled the full invoice. View your subscription for current paid access and
              renewal dates.
            </p>
          ) : i.state === 'open' ? (
            <p className="notice">
              Uploading a receipt does not activate Pro. Staff must verify actual receipt in Lockd’s
              business account.
            </p>
          ) : (
            <p>No further payment is requested on this invoice.</p>
          )}
          {!staff && i.state === 'open' && !i.claims.length && i.verified_minor === 0 && (
            <details>
              <summary>Cancel this unpaid invoice</summary>
              <BillingForm
                label="Cancel unpaid invoice"
                run={async (d) => {
                  await api(`invoices/${i.id}/void`, { reason: String(d.get('reason')) });
                  await refresh();
                }}
              >
                <Area
                  label="Invoice cancellation reason"
                  name="reason"
                  minLength={3}
                  maxLength={1000}
                />
              </BillingForm>
            </details>
          )}
        </section>
        <section className="card form">
          <p className="eyebrow">PAYMENT EVIDENCE</p>
          <h2>Keep the reference clear.</h2>
          {!staff && i.state === 'open' && (
            <BillingForm
              label="Submit subscription evidence"
              run={async (d) => {
                d.set('amountMinor', String(moneyToMinor(String(d.get('amount')))));
                await api(`invoices/${i.id}/proof`, d);
                await refresh();
              }}
            >
              <Field
                label="Subscription payment reference"
                name="reference"
                minLength={2}
                maxLength={100}
              />
              <Field label="Subscription amount sent (JMD)" name="amount" inputMode="decimal" />
              <Field
                label="Subscription receipt image"
                name="file"
                type="file"
                accept="image/png,image/jpeg"
              />
            </BillingForm>
          )}
          {i.claims.map((c) => (
            <article className="note form" key={c.id}>
              <strong>{c.reference}</strong>
              <p>
                Claimed {money(c.claimed_minor)} · {c.decision ?? 'Awaiting staff review'}
              </p>
              <a className="text-link" href={`/api/invoice-receipts/${c.id}`}>
                Download private subscription receipt
              </a>
              {c.decision && (
                <p>
                  Verified {money(c.amount_minor ?? 0)} · {c.reason}
                </p>
              )}
              {staff && !c.decision && i.state === 'open' && (
                <ReconcileForm id={i.id} claimId={c.id} refresh={refresh} />
              )}
            </article>
          ))}
          {!i.claims.length && <p className="fine">No subscription receipt submitted yet.</p>}
        </section>
      </div>
      <section className="card section">
        <p className="eyebrow">INVOICE AUDIT</p>
        <ol className="timeline">
          {i.events.map((e, index) => (
            <li key={index}>
              <strong>{e.kind.replaceAll('_', ' ')}</strong>
              <span>
                {date(e.created_at)} · {e.reason}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
function ReconcileForm({
  id,
  claimId,
  refresh,
}: {
  id: string;
  claimId: string;
  refresh: () => Promise<void>;
}) {
  const [choice, setChoice] = useState('received');
  return (
    <BillingForm
      label="Record subscription reconciliation"
      run={async (d) => {
        await api(`invoices/${id}/reconcile`, {
          claimId,
          decision: choice,
          amountMinor: choice === 'received' ? moneyToMinor(String(d.get('amount'))) : 0,
          bankReference: choice === 'received' ? String(d.get('reference')) : '',
          receivedAt: choice === 'received' ? jamaicaISO(String(d.get('receivedAt'))) : null,
          reason: String(d.get('reason')),
          attest: d.get('attest') === 'on',
        });
        await refresh();
      }}
    >
      <label className="field">
        <span>Bank reconciliation decision</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="received">Actual business-bank funds received</option>
          <option value="rejected">Reject evidence</option>
        </select>
      </label>
      {choice === 'received' && (
        <>
          <Field
            label="Actual subscription funds received (JMD)"
            name="amount"
            inputMode="decimal"
          />
          <Field
            label="Business-bank transaction reference"
            name="reference"
            minLength={2}
            maxLength={100}
          />
          <Field
            label="Bank received at (Jamaica time)"
            name="receivedAt"
            type="datetime-local"
            step="1"
          />
          <label className="check">
            <input type="checkbox" name="attest" required />
            <span>
              I checked Lockd’s business-bank record and attest actual receipt of this amount at
              this time. I am not relying on the uploaded receipt alone.
            </span>
          </label>
        </>
      )}
      <Area
        label="Subscription reconciliation reason"
        name="reason"
        minLength={3}
        maxLength={1000}
      />
    </BillingForm>
  );
}
