'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, Area, Notice, Submit } from './forms';
import { BillingForm } from './billing';
import { date } from '@/lib/format';

function Choice({
  label,
  name,
  options,
  labels,
}: {
  label: string;
  name: string;
  options: readonly string[];
  labels: Record<string, string>;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} required defaultValue="">
        <option value="" disabled>
          Choose…
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
export function OpenCaseForm({
  accountId,
  categories,
  requesters,
  labels,
}: {
  accountId: string;
  categories: readonly string[];
  requesters: readonly string[];
  labels: Record<string, string>;
}) {
  const router = useRouter();
  return (
    <BillingForm
      label="Open support case"
      run={async (d) => {
        const { id } = await api('staff/cases', {
          accountId,
          category: String(d.get('category')),
          requester: String(d.get('requester')),
          summary: String(d.get('summary')),
        });
        router.push(`/staff/cases/${id}`);
      }}
    >
      <Choice label="What is it about?" name="category" options={categories} labels={labels} />
      <Choice label="Who raised it?" name="requester" options={requesters} labels={labels} />
      <Area label="Summary" name="summary" minLength={10} maxLength={1000} rows={3} />
    </BillingForm>
  );
}
export function LinkBookingForm({
  caseId,
  candidates,
}: {
  caseId: string;
  candidates: { id: string; startsAt: string; status: string }[];
}) {
  const router = useRouter();
  return (
    <BillingForm
      label="Link booking to case"
      run={async (d) => {
        await api(`staff/cases/${caseId}/link`, {
          bookingId: String(d.get('bookingId') || d.get('reference')).trim(),
          reason: String(d.get('reason')),
        });
        router.refresh();
      }}
    >
      {candidates.length > 0 && (
        <label className="field">
          <span>Booking (date and status only until linked)</span>
          <select name="bookingId" defaultValue="">
            <option value="">Use a booking reference instead</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {date(c.startsAt)} · {c.status.replaceAll('_', ' ').toLowerCase()} ·{' '}
                {c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Booking reference (from the client or DJ)</span>
        <input name="reference" autoComplete="off" spellCheck={false} />
      </label>
      <Area
        label="Why this booking is needed"
        name="reason"
        minLength={10}
        maxLength={1000}
        rows={2}
      />
    </BillingForm>
  );
}
export function NoteForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  return (
    <BillingForm
      label="Add note"
      run={async (d) => {
        await api(`staff/cases/${caseId}/notes`, { body: String(d.get('body')) });
        router.refresh();
      }}
    >
      <Area label="Case note" name="body" minLength={10} maxLength={2000} rows={3} />
    </BillingForm>
  );
}
export function ExtendForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  return (
    <details>
      <summary>Extend record access by 72 hours</summary>
      <BillingForm
        label="Extend access"
        run={async (d) => {
          await api(`staff/cases/${caseId}/extend`, { reason: String(d.get('reason')) });
          router.refresh();
        }}
      >
        <Area label="Reason for more time" name="reason" minLength={10} maxLength={1000} rows={2} />
      </BillingForm>
    </details>
  );
}
export function CloseCaseForm({
  caseId,
  outcomes,
  labels,
}: {
  caseId: string;
  outcomes: readonly string[];
  labels: Record<string, string>;
}) {
  const router = useRouter();
  return (
    <BillingForm
      label="Close case"
      run={async (d) => {
        await api(`staff/cases/${caseId}/close`, {
          outcome: String(d.get('outcome')),
          note: String(d.get('note')),
        });
        router.refresh();
      }}
    >
      <Choice label="Outcome" name="outcome" options={outcomes} labels={labels} />
      <Area label="Closing note" name="note" minLength={10} maxLength={1000} rows={2} />
    </BillingForm>
  );
}
// Fetches one evidence image after a written justification; the bytes stay in this page only.
export function EvidenceViewer({ caseId, claimId }: { caseId: string; claimId: string }) {
  const [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img className="evidence" src={url} alt="Client payment evidence (private)" />
    );
  return (
    <details>
      <summary>View evidence image</summary>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const res = await fetch(`/api/staff/cases/${caseId}/receipt`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                claimId,
                justification: String(new FormData(e.currentTarget).get('justification')),
              }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? 'Evidence unavailable');
            setUrl(URL.createObjectURL(await res.blob()));
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Area
          label="Why you need to see this image (recorded)"
          name="justification"
          minLength={10}
          maxLength={1000}
          rows={2}
        />
        <Notice error={error} />
        <Submit busy={busy}>Show evidence</Submit>
      </form>
    </details>
  );
}
