import { createHmac } from 'node:crypto';
// Deployment settings in one place. Local development uses the explicit URLs written by
// db:local; the hosted staging demo derives everything else from the database owner URL.

// Published logins for the synthetic staging demo, shown on the staging sign-in and /demo pages.
export const DEMO_DJ_EMAIL = 'demo.dj@example.com';
export const PUBLIC_DEMO_DJ_PASSWORD = 'lockd-demo-dj-2026';
export const DEMO_STAFF_EMAIL = 'demo.staff@example.com';
export const PUBLIC_DEMO_STAFF_PASSWORD = 'lockd-demo-admin-2026';
// The demo Super Admin's authenticator secret is published as well: on staging the unlock screen
// shows its current code, which the server still verifies like any other.
export const PUBLIC_DEMO_STAFF_TOTP = 'LOCKDDEMOSUPERADMINSTAGINGKEYABC';
// A minimal staging setup only provides the database owner URL. Every other secret is derived
// from the owner's password (itself a secret), so nothing else has to be typed into the host.
// Explicitly configured values always win.
function applyStagingDefaults() {
  const owner = process.env.MIGRATION_DATABASE_URL;
  if (process.env.LOCKD_ENV !== 'staging' || !owner) return;
  const u = new URL(owner);
  const root = decodeURIComponent(u.password);
  if (!root) return;
  const derive = (label: string) =>
    createHmac('sha256', root).update(`lockd-staging:${label}`).digest('hex');
  const defaults: Record<string, string> = {
    DB_HOST: u.hostname,
    DB_PORT: u.port || '5432',
    DB_NAME: decodeURIComponent(u.pathname.slice(1)) || 'lockd',
    RUNTIME_DB_PASSWORD: derive('runtime-role'),
    NOTIFIER_DB_PASSWORD: derive('notifier-role'),
    STAFF_MFA_KEY: derive('staff-mfa-key'),
    NOTIFICATION_KEY: derive('notification-key'),
    DEMO_STAFF_PASSWORD: PUBLIC_DEMO_STAFF_PASSWORD,
    DEMO_DJ_PASSWORD: PUBLIC_DEMO_DJ_PASSWORD,
  };
  for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
}
applyStagingDefaults();
export const appOrigin = () => process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || '';
export const stagingMode = () => process.env.LOCKD_ENV === 'staging';
export const emailEnabled = () =>
  !!process.env.EMAIL_PROVIDER && process.env.EMAIL_PROVIDER.toLowerCase() !== 'disabled';
// Builds a role-specific URL from DB_HOST/DB_PORT/DB_NAME and a generated password; the URL
// setters percent-encode the password, so generated secrets need no escaping.
function compose(user: string, password: string | undefined) {
  if (!process.env.DB_HOST || !password) return undefined;
  const url = new URL('postgresql://placeholder');
  url.hostname = process.env.DB_HOST;
  url.port = process.env.DB_PORT || '5432';
  url.pathname = `/${process.env.DB_NAME || 'lockd'}`;
  url.username = user;
  url.password = password;
  return url.toString();
}
export const runtimeDatabaseUrl = () =>
  process.env.DATABASE_URL || compose('lockd_runtime', process.env.RUNTIME_DB_PASSWORD);
export const notifierDatabaseUrl = () =>
  process.env.NOTIFIER_DATABASE_URL || compose('lockd_notifier', process.env.NOTIFIER_DB_PASSWORD);
// Connection options for every database client. Managed Postgres that requires TLS with its own
// CA (DigitalOcean binds it as CA_CERT) sets DB_CA_CERT to that PEM: the server certificate must
// chain to it, and like libpq's verify-ca the host name is not compared. Without DB_CA_CERT the
// connection string is used as is.
export function pgConfig(connectionString: string) {
  const ca = process.env.DB_CA_CERT?.trim();
  if (!ca) return { connectionString };
  const url = new URL(connectionString);
  // An sslmode in the URL would replace the explicit TLS options below.
  url.searchParams.delete('sslmode');
  return {
    connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined },
  };
}
