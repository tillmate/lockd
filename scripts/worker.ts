import { expire } from '../src/lib/service.js';
try {
  process.loadEnvFile('.env.local');
} catch {
  /* CI/environment */
}
console.log('Expiry worker started. No external notification transport configured.');
async function tick() {
  try {
    const n = await expire();
    if (n) console.log(`Released ${n} expired holds.`);
  } catch (e) {
    console.error('Expiry failed:', (e as Error).message);
  }
}
await tick();
setInterval(() => {
  void tick();
}, 30_000);
