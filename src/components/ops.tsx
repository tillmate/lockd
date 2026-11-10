'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, Area, Notice } from './forms';
import { BillingForm } from './billing';

const labels: Record<string, string> = {
  identity_checked: 'Identity and stage name checked',
  profile_complete: 'Profile and package complete',
  impersonation: 'Impersonation',
  fraud_report: 'Fraud report',
  prohibited_content: 'Prohibited content',
  payment_dispute: 'Unresolved payment dispute',
  incomplete_profile: 'Incomplete or misleading profile',
  provider_outage: 'Email provider outage',
  configuration_fixed: 'Delivery configuration fixed',
  recipient_corrected: 'Recipient issue resolved',
  other: 'Other (explain in note)',
};
function Reason({ name, options }: { name: string; options: readonly string[] }) {
  return (
    <label className="field">
      <span>Reason code</span>
      <select name={name} required defaultValue="">
        <option value="" disabled>
          Choose a reason
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ListingDecision({
  accountId,
  decision,
  options,
}: {
  accountId: string;
  decision: 'approved' | 'restricted';
  options: readonly string[];
}) {
  const router = useRouter();
  const [done, setDone] = useState('');
  if (done) return <Notice message={done} />;
  return (
    <BillingForm
      label={decision === 'approved' ? 'Approve listing' : 'Restrict listing'}
      run={async (d) => {
        await api('staff/listings/review', {
          accountId,
          decision,
          reasonCode: String(d.get('reasonCode')),
          note: String(d.get('note')),
        });
        setDone(decision === 'approved' ? 'Listing approved.' : 'Listing restricted.');
        router.refresh();
      }}
    >
      <Reason name="reasonCode" options={options} />
      <Area
        label={decision === 'approved' ? 'Review note' : 'Reason shown to the DJ'}
        name="note"
        minLength={10}
        maxLength={1000}
        rows={2}
      />
    </BillingForm>
  );
}
export function Requeue({ id, options }: { id: string; options: readonly string[] }) {
  const router = useRouter();
  return (
    <details>
      <summary>Requeue</summary>
      <BillingForm
        label="Requeue for one more attempt"
        run={async (d) => {
          await api('staff/notifications/requeue', {
            id,
            reasonCode: String(d.get('reasonCode')),
            note: String(d.get('note')),
          });
          router.refresh();
        }}
      >
        <Reason name="reasonCode" options={options} />
        <Area label="Note" name="note" minLength={10} maxLength={1000} rows={2} />
      </BillingForm>
    </details>
  );
}
export function ScopeChange({
  userId,
  scope,
  grant,
}: {
  userId: string;
  scope: string;
  grant: boolean;
}) {
  const router = useRouter();
  return (
    <details>
      <summary>{grant ? `Grant ${scope}` : `Revoke ${scope}`}</summary>
      <BillingForm
        label={grant ? `Grant ${scope}` : `Revoke ${scope}`}
        run={async (d) => {
          await api('staff/scopes', { userId, scope, grant, note: String(d.get('note')) });
          router.refresh();
        }}
      >
        <Area label="Reason" name="note" minLength={10} maxLength={1000} rows={2} />
      </BillingForm>
    </details>
  );
}
