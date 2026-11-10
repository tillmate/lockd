'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { moneyToMinor, parishNames } from '@/lib/validation';
import { money } from '@/lib/format';
import type { Profile, Settings } from '@/lib/service';
export async function api(path: string, data: unknown) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: data instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: data instanceof FormData ? data : JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Request failed');
  return body;
}
export function Field({
  label,
  name,
  type = 'text',
  required = true,
  ...props
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} required={required} {...props} />
    </label>
  );
}
export function Area({
  label,
  name,
  ...props
}: { label: string; name: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea name={name} required rows={4} {...props} />
    </label>
  );
}
export function Notice({ error, message }: { error?: string; message?: string }) {
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </>
  );
}
export function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button className="button" disabled={busy} type="submit">
      {busy ? 'Saving…' : children}
    </button>
  );
}
const val = (d: FormData, key: string) => String(d.get(key) ?? '');
export const jamaicaISO = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s))
    throw new Error('Choose a valid date and time');
  return `${s.length === 16 ? `${s}:00` : s}-05:00`;
};
export function AuthForm({ mode }: { mode: 'register' | 'login' }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const router = useRouter();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const d = new FormData(e.currentTarget);
    try {
      await api(`auth/${mode}`, { email: val(d, 'email'), password: val(d, 'password') });
      if (mode === 'login') {
        router.push('/dashboard');
        router.refresh();
      } else
        setMessage(
          'Account request received. Open your verification email to continue. In local development, use the test mailbox.',
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card form" onSubmit={submit}>
      <h2>{mode === 'register' ? 'Your next chapter.' : 'Sign in'}</h2>
      <p>
        {mode === 'register'
          ? 'Start with Free. No card required.'
          : 'Manage your dates, agreements and direct deposits.'}
      </p>
      <Field label="Email address" name="email" type="email" autoComplete="email" maxLength={254} />
      <Field
        label={mode === 'register' ? 'Create password' : 'Password'}
        name="password"
        type="password"
        minLength={12}
        maxLength={128}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
      />
      <p className="fine">Use at least 12 characters.</p>
      <Notice error={error} message={message} />
      <Submit busy={busy}>{mode === 'register' ? 'Create my account →' : 'Sign in →'}</Submit>
      <p>
        {mode === 'register' ? (
          <>
            Already have an account? <Link href="/login">Sign in</Link>
          </>
        ) : (
          <>
            New to Lockd? <Link href="/register">Create an account</Link> ·{' '}
            <Link href="/forgot">Forgot password?</Link>
          </>
        )}
      </p>
    </form>
  );
}
export function TokenForm({ mode }: { mode: 'verify' | 'reset' }) {
  const token = useRef('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (location.hash) token.current = location.hash.slice(1);
    history.replaceState(null, '', location.pathname);
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = new FormData(e.currentTarget);
      await api(`auth/${mode}`, { token: token.current, password: val(d, 'password') });
      setMessage(
        mode === 'verify'
          ? 'Email verified. You can now sign in.'
          : 'Password changed. Sign in with your new password.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card form" onSubmit={submit}>
      <p>
        {mode === 'verify'
          ? 'Confirm this email belongs to you before publishing your DJ page.'
          : 'Choose a strong password. Existing sign-in sessions will end.'}
      </p>
      {mode === 'reset' && (
        <Field
          label="New password"
          name="password"
          type="password"
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
        />
      )}
      <Notice error={error} message={message} />
      {!message ? (
        <Submit busy={busy}>{mode === 'verify' ? 'Verify my email' : 'Change password'}</Submit>
      ) : (
        <Link className="button" href="/login">
          Continue to sign in →
        </Link>
      )}
    </form>
  );
}
export function ForgotForm() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api('auth/forgot', { email: val(new FormData(e.currentTarget), 'email') });
          setMessage(
            'If this account exists, a reset link has been prepared. Check your email or local test mailbox.',
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Email address" name="email" type="email" />
      <Notice error={error} message={message} />
      <Submit busy={busy}>Send reset link</Submit>
    </form>
  );
}
export function OnboardForm({ initial }: { initial?: Settings }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const router = useRouter();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = new FormData(e.currentTarget);
      await api(initial ? 'settings' : 'onboard', {
        ...Object.fromEntries(d),
        ...(initial
          ? {
              packageId: initial.packageId,
              revision: initial.revision,
              published: d.get('published') === 'on',
            }
          : {}),
        priceMinor: moneyToMinor(val(d, 'price')),
        depositMinor: moneyToMinor(val(d, 'deposit')),
        durationMinutes: Number(d.get('durationMinutes')),
        bufferBefore: Number(d.get('bufferBefore')),
        bufferAfter: Number(d.get('bufferAfter')),
      });
      router.push('/dashboard');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="setup-form" onSubmit={submit}>
      <section className="card form">
        <p className="eyebrow">01 / YOUR PUBLIC PROFILE</p>
        <h2>Meet your clients.</h2>
        <Field
          label="Stage name"
          name="stageName"
          maxLength={100}
          defaultValue={initial?.stageName}
        />
        <Field
          label="Booking page address"
          name="slug"
          pattern="[a-z0-9](?:[a-z0-9]|-){2,49}"
          placeholder="your-dj-name"
          defaultValue={initial?.slug}
          readOnly={!!initial}
        />
        <p className="fine">Lowercase letters, numbers and hyphens. /dj/your-dj-name</p>
        <label className="field">
          <span>Parish</span>
          <select name="parish" defaultValue={initial?.parish}>
            {parishNames.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <Area
          label="About your sound"
          name="bio"
          minLength={10}
          maxLength={1500}
          defaultValue={initial?.bio}
        />
        {initial && (
          <label className="check">
            <input type="checkbox" name="published" defaultChecked={initial.published} />
            <span>
              Public page accepts new bookings. Turning this off preserves existing bookings.
            </span>
          </label>
        )}
      </section>
      <section className="card form">
        <p className="eyebrow">02 / YOUR FIRST PACKAGE</p>
        <h2>Set the stage.</h2>
        <Field
          label="Package name"
          name="packageName"
          maxLength={120}
          defaultValue={initial?.packageName}
        />
        <Area
          label="What’s included"
          name="description"
          minLength={10}
          maxLength={500}
          defaultValue={initial?.description}
        />
        <div className="two">
          <Field
            label="Total price (JMD)"
            name="price"
            inputMode="decimal"
            placeholder="55000.00"
            defaultValue={initial ? (initial.priceMinor / 100).toFixed(2) : undefined}
          />
          <Field
            label="Required deposit (JMD)"
            name="deposit"
            inputMode="decimal"
            placeholder="27500.00"
            defaultValue={initial ? (initial.depositMinor / 100).toFixed(2) : undefined}
          />
        </div>
        <Field
          label="Performance duration (minutes)"
          name="durationMinutes"
          type="number"
          min={30}
          max={1440}
          defaultValue={initial?.durationMinutes ?? 240}
        />
        <div className="two">
          <Field
            label="Setup / travel before (minutes)"
            name="bufferBefore"
            type="number"
            min={0}
            max={720}
            defaultValue={initial?.bufferBefore ?? 60}
          />
          <Field
            label="Pack-down / travel after (minutes)"
            name="bufferAfter"
            type="number"
            min={0}
            max={720}
            defaultValue={initial?.bufferAfter ?? 60}
          />
        </div>
      </section>
      <section className="card form">
        <p className="eyebrow">03 / DIRECT PAYMENT & AGREEMENT</p>
        <h2>Keep everyone clear.</h2>
        <Area
          label="Your direct deposit instructions"
          name="depositInstructions"
          defaultValue={initial?.depositInstructions}
          minLength={10}
          maxLength={2000}
          placeholder="Payment rail, recipient name and payment instructions. Use synthetic instructions while testing."
        />
        <p className="fine">
          Only clients with a private booking link see these instructions in their agreement. Funds
          go directly to you.
        </p>
        <Area
          label="Your booking agreement"
          name="agreement"
          defaultValue={initial?.agreement}
          minLength={20}
          maxLength={12000}
          rows={10}
          placeholder="Enter the agreement clients must accept. Use test terms locally; legal approval is required before public release."
        />
        <p className="fine">
          The exact agreement, package, event and payment details are saved with each booking.
        </p>
      </section>
      <div className="form">
        <Notice error={error} />
        <Submit busy={busy}>
          {initial ? 'Save profile and package' : 'Publish my local booking page ↗'}
        </Submit>
      </div>
    </form>
  );
}
export function HoldForm({ dj }: { dj: Profile }) {
  const router = useRouter();
  const [selected, setSelected] = useState(dj.packages[0]?.id ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [attempt] = useState(() => ({
    requestId: crypto.randomUUID(),
    accessToken: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
  }));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = new FormData(e.currentTarget);
      const { id } = await api('holds', {
        creatorId: dj.id,
        packageId: selected,
        ...attempt,
        startsAt: jamaicaISO(val(d, 'startsAt')),
        clientName: val(d, 'clientName'),
        clientEmail: val(d, 'clientEmail'),
        venue: val(d, 'venue'),
      });
      router.push(`/booking/${id}#${attempt.accessToken}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="section" onSubmit={submit}>
      <p className="eyebrow">01 / CHOOSE YOUR PERFORMANCE</p>
      <h2>A package for your occasion.</h2>
      <fieldset className="package-grid">
        <legend className="sr-only">Performance package</legend>
        {dj.packages.map((p) => (
          <label className={`card package ${selected === p.id ? 'selected' : ''}`} key={p.id}>
            <div className="section-heading">
              <h3>{p.name}</h3>
              <input
                type="radio"
                name="packageId"
                value={p.id}
                checked={selected === p.id}
                onChange={() => setSelected(p.id)}
              />
            </div>
            <p>{p.description}</p>
            <strong className="price">{money(p.priceMinor)}</strong>
            <p>
              {p.durationMinutes / 60} hours · {money(p.depositMinor)} deposit
            </p>
          </label>
        ))}
      </fieldset>
      <div className="split section">
        <div>
          <p className="eyebrow">02 / YOUR EVENT</p>
          <h2>
            Make room for
            <br />a great night.
          </h2>
          <p>
            Your provisional hold lasts 48 hours. Submit evidence before it expires to receive one
            24-hour DJ verification grace period.
          </p>
          <div className="note">
            <strong>A hold is not a confirmation.</strong>
            <p>Your DJ must confirm that the required deposit reached their account.</p>
          </div>
        </div>
        <div className="card form">
          <Field label="Event start (Jamaica time)" name="startsAt" type="datetime-local" />
          <p className="fine">
            Choose a date more than 72 hours away so the full hold and verification window fits
            before your event. Overnight performances are supported.
          </p>
          <Field label="Your full name" name="clientName" maxLength={120} autoComplete="name" />
          <Field
            label="Your email"
            name="clientEmail"
            type="email"
            maxLength={254}
            autoComplete="email"
          />
          <Field label="Event venue / address" name="venue" maxLength={400} />
          <Notice error={error} />
          <Submit busy={busy}>Hold my date & review agreement →</Submit>
          <p className="fine">
            No money is charged. Availability is checked when you create the hold.
          </p>
        </div>
      </div>
    </form>
  );
}
export function Logout() {
  const router = useRouter();
  return (
    <button
      className="secondary"
      onClick={async () => {
        await api('auth/logout', {});
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
export function BlockForm() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const router = useRouter();
  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const d = new FormData(e.currentTarget);
          await api('blocks', {
            startsAt: jamaicaISO(val(d, 'startsAt')),
            endsAt: jamaicaISO(val(d, 'endsAt')),
            reason: val(d, 'reason'),
          });
          router.refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Block starts (Jamaica time)" name="startsAt" type="datetime-local" />
      <Field label="Block ends (Jamaica time)" name="endsAt" type="datetime-local" />
      <Field label="Reason" name="reason" maxLength={300} />
      <Notice error={error} />
      <Submit busy={busy}>Block this time</Submit>
    </form>
  );
}
export function RemoveBlock({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  return (
    <>
      <button
        className="secondary"
        onClick={async () => {
          try {
            await api('blocks/remove', { id });
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Remove block
      </button>
      <Notice error={error} />
    </>
  );
}
