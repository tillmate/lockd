// Deployment settings in one place. Local development uses the explicit URLs written by
// db:local; Render injects its public URL and the database connection parts instead.
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
