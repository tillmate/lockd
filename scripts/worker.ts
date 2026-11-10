import { createServer } from 'node:http';
import pg from 'pg';
import { dispatch, enqueueReminders, expireHolds } from '../src/lib/notify/dispatcher.js';
import { deliveryConfig } from '../src/lib/notify/transport.js';
import { keyConfigured } from '../src/lib/mfa.js';
import { appOrigin, notifierDatabaseUrl } from '../src/lib/env.js';
try {
  process.loadEnvFile('.env.local');
} catch {
  /* CI/environment */
}
const origin = appOrigin();
if (!origin) throw new Error('APP_ORIGIN is required for links in notifications');
const notifierUrl = notifierDatabaseUrl();
if (!notifierUrl) throw new Error('NOTIFIER_DATABASE_URL is required for the worker');
const config = deliveryConfig();
// Without the web app's key every queued link email would be undeliverable; fail fast instead.
if (config.transport && !keyConfigured('NOTIFICATION_KEY'))
  throw new Error('NOTIFICATION_KEY must be set to the web app value when EMAIL_PROVIDER is set');
// The worker role can expire holds and claim, render and finish queued messages; nothing else.
const pool = new pg.Pool({
  connectionString: notifierUrl,
  max: 3,
  statement_timeout: 15000,
  options: '-c timezone=UTC',
});
const state = {
  startedAt: new Date().toISOString(),
  transport: config.transport?.name ?? 'disabled',
  lastExpiry: null as string | null,
  lastReminders: null as string | null,
  lastDispatch: null as string | null,
  listening: false,
  errors: {} as Record<string, string | null>,
};
// pg-pool re-emits errors from idle clients; without a listener the process would exit.
pool.on('error', (e) => {
  state.errors.pool = `${new Date().toISOString()} ${e.message}`;
  console.error('Database connection error:', e.message);
});
console.log(
  `Lockd worker started. Email transport: ${state.transport}${config.allowedDomains ? ` (allowed domains: ${config.allowedDomains.join(', ')})` : ''}.`,
);
if (!config.transport) console.warn('EMAIL_PROVIDER is not set; notifications stay queued.');

async function job(name: 'expiry' | 'reminders' | 'dispatch', run: () => Promise<void>) {
  try {
    await run();
    state.errors[name] = null;
    const now = new Date().toISOString();
    if (name === 'expiry') state.lastExpiry = now;
    else if (name === 'reminders') state.lastReminders = now;
    else state.lastDispatch = now;
  } catch (e) {
    state.errors[name] = `${new Date().toISOString()} ${(e as Error).message}`;
    console.error(`${name} failed:`, (e as Error).message);
  }
}
const expiryTick = () =>
  job('expiry', async () => {
    const n = await expireHolds(pool);
    if (n) console.log(`Released ${n} expired holds.`);
  });
const reminderTick = () =>
  job('reminders', async () => {
    const n = await enqueueReminders(pool);
    if (n) console.log(`Queued ${n} reminders.`);
  });
let stopping = false,
  current: Promise<void> | null = null,
  again = false;
function dispatchTick() {
  if (!config.transport || stopping) return current;
  if (current) {
    again = true;
    return current;
  }
  current = job('dispatch', async () => {
    do {
      again = false;
      const s = await dispatch(pool, config, origin!, 10, () => stopping);
      if (s.sent || s.retry || s.failed || s.skipped)
        console.log(
          `Notifications: ${s.sent} sent, ${s.retry} retrying, ${s.failed} failed, ${s.skipped} skipped.`,
        );
      if (s.sent + s.retry + s.failed + s.skipped >= 10) again = true;
    } while (again && !stopping);
  }).finally(() => {
    current = null;
  });
  return current;
}
let listener: pg.Client | null = null;
async function listen() {
  if (!config.transport || stopping) return;
  const client = new pg.Client({ connectionString: notifierUrl });
  listener = client;
  client.on('notification', () => void dispatchTick());
  client.on('error', () => {
    state.listening = false;
    listener = null;
    if (!stopping) setTimeout(() => void listen(), 5000);
  });
  try {
    await client.connect();
    await client.query('LISTEN lockd_outbox');
    state.listening = true;
  } catch (e) {
    state.listening = false;
    console.error('Outbox listener failed; polling continues:', (e as Error).message);
    if (!stopping) setTimeout(() => void listen(), 5000);
  }
}
// Healthy when each job has succeeded recently (allowing a start-up window) and, with delivery
// enabled, the outbox listener is connected.
function healthy() {
  const now = Date.now(),
    started = Date.parse(state.startedAt);
  const fresh = (at: string | null, seconds: number) =>
    at ? now - Date.parse(at) < seconds * 1000 : now - started < seconds * 1000;
  return (
    fresh(state.lastExpiry, 120) &&
    fresh(state.lastReminders, 720) &&
    (!config.transport || (fresh(state.lastDispatch, 120) && state.listening))
  );
}
const port = Number(process.env.WORKER_HEALTH_PORT ?? 3101);
const health = createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
    return;
  }
  const ok = healthy();
  res
    .writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ ok, ...state }));
}).listen(port, '127.0.0.1');
const timers = [
  setInterval(() => void expiryTick(), 30_000),
  setInterval(() => void reminderTick(), 300_000),
  setInterval(() => void dispatchTick(), 15_000),
];
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    health.close();
    // Let the message in flight finish; unstarted claims are handed back without an attempt.
    const drained = Promise.race([current, new Promise((r) => setTimeout(r, 20_000))]);
    void drained
      .then(() => Promise.allSettled([listener?.end(), pool.end()]))
      .then(() => process.exit(0));
  });
void (async () => {
  await expiryTick();
  await reminderTick();
  await listen();
  await dispatchTick();
})();
