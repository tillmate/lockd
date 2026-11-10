import { createServer } from 'node:http';
import pg from 'pg';
import { expire } from '../src/lib/service.js';
import { dispatch, enqueueReminders } from '../src/lib/notify/dispatcher.js';
import { deliveryConfig } from '../src/lib/notify/transport.js';
try {
  process.loadEnvFile('.env.local');
} catch {
  /* CI/environment */
}
const origin = process.env.APP_ORIGIN;
if (!origin) throw new Error('APP_ORIGIN is required for links in notifications');
const config = deliveryConfig();
const notifierUrl = process.env.NOTIFIER_DATABASE_URL;
// The notifier role can only claim, render and finish queued messages; it has no booking writes.
const notifier = notifierUrl
  ? new pg.Pool({ connectionString: notifierUrl, max: 3, statement_timeout: 15000 })
  : null;
const state = {
  startedAt: new Date().toISOString(),
  lastExpiry: null as string | null,
  lastDispatch: null as string | null,
  lastError: null as string | null,
  transport: config.transport?.name ?? 'disabled',
};
console.log(
  `Lockd worker started. Email transport: ${state.transport}${config.allowedDomains ? ` (allowed domains: ${config.allowedDomains.join(', ')})` : ''}.`,
);
if (!notifier) console.warn('NOTIFIER_DATABASE_URL is not set; notifications stay queued.');
else if (!config.transport) console.warn('EMAIL_PROVIDER is not set; notifications stay queued.');

async function expiryTick() {
  try {
    const n = await expire();
    state.lastExpiry = new Date().toISOString();
    if (n) console.log(`Released ${n} expired holds.`);
  } catch (e) {
    state.lastError = `Expiry: ${(e as Error).message}`;
    console.error('Expiry failed:', (e as Error).message);
  }
}
let running = false,
  again = false;
async function dispatchTick() {
  if (!notifier || !config.transport) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const s = await dispatch(notifier, config, origin!);
      state.lastDispatch = new Date().toISOString();
      if (s.sent || s.retry || s.failed || s.skipped)
        console.log(
          `Notifications: ${s.sent} sent, ${s.retry} retrying, ${s.failed} failed, ${s.skipped} skipped.`,
        );
      if (s.sent + s.retry + s.failed + s.skipped >= 20) again = true;
    } while (again);
  } catch (e) {
    state.lastError = `Dispatch: ${(e as Error).message}`;
    console.error('Dispatch failed:', (e as Error).message);
  } finally {
    running = false;
  }
}
async function reminderTick() {
  if (!notifier) return;
  try {
    const n = await enqueueReminders(notifier);
    if (n) console.log(`Queued ${n} reminders.`);
  } catch (e) {
    state.lastError = `Reminders: ${(e as Error).message}`;
    console.error('Reminders failed:', (e as Error).message);
  }
}
let listener: pg.Client | null = null;
async function listen() {
  if (!notifierUrl || !config.transport) return;
  try {
    listener = new pg.Client({ connectionString: notifierUrl });
    listener.on('notification', () => void dispatchTick());
    listener.on('error', () => {
      listener = null;
      setTimeout(() => void listen(), 5000);
    });
    await listener.connect();
    await listener.query('LISTEN lockd_outbox');
  } catch (e) {
    console.error('Outbox listener failed; polling continues:', (e as Error).message);
    setTimeout(() => void listen(), 5000);
  }
}
await expiryTick();
await reminderTick();
await dispatchTick();
await listen();
const timers = [
  setInterval(() => void expiryTick(), 30_000),
  setInterval(() => void reminderTick(), 300_000),
  setInterval(() => void dispatchTick(), 15_000),
];
const port = Number(process.env.WORKER_HEALTH_PORT ?? 3101);
const health = createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url === '/health' ? { ok: true, ...state } : { error: 'Not found' }));
}).listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    timers.forEach(clearInterval);
    health.close();
    void Promise.allSettled([listener?.end(), notifier?.end()]).then(() => process.exit(0));
  });
