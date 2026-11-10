import { directory, scopes } from '@/lib/ops';
import { date } from '@/lib/format';
import { ScopeChange } from '@/components/ops';
import { staffPage, StaffNav } from '../access';
export default async function Page() {
  const page = await staffPage('admin');
  if ('gate' in page) return page.gate;
  const { staff, audit } = await directory(page.ctx);
  return (
    <div className="shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SUPER ADMIN · MFA VERIFIED</p>
          <h1>Access and accountability.</h1>
          <p>
            Grant operational scopes to enrolled staff. You cannot change your own scopes; every
            change and staff action is recorded below.
          </p>
        </div>
      </div>
      <StaffNav />
      <section className="section form">
        <h2>Staff</h2>
        {staff.map((m) => (
          <article className="card" key={m.user_id} aria-label={m.email}>
            <h3>{m.email}</h3>
            <p>
              {m.enabled ? 'Enabled' : 'Disabled'} · billing
              {m.scopes.length ? `, ${m.scopes.join(', ')}` : ''} · enrolled {date(m.created_at)}
            </p>
            <div className="grid-2">
              {scopes.map((s) => (
                <ScopeChange key={s} userId={m.user_id} scope={s} grant={!m.scopes.includes(s)} />
              ))}
            </div>
          </article>
        ))}
      </section>
      <section className="section">
        <h2>Staff audit trail</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Staff</th>
                <th>Scope</th>
                <th>Action</th>
                <th>DJ</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e, i) => (
                <tr key={i}>
                  <td>{date(e.at)}</td>
                  <td>{e.actor}</td>
                  <td>{e.scope}</td>
                  <td>{e.kind.replaceAll('_', ' ').toLowerCase()}</td>
                  <td>{e.stage_name ?? '—'}</td>
                  <td>
                    {e.reason_code ? `${e.reason_code}: ` : ''}
                    {e.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
