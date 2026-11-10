import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const password = 'Synthetic-test-password-42!';
async function setupDJ(page: Page, label: string) {
  const suffix = randomUUID().slice(0, 8),
    email = `${label}-${suffix}@example.test`,
    slug = `${label}-${suffix}`;
  await page.goto('/register');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Create password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('status')).toContainText('Account request received');
  await page.goto('/dev/mailbox');
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: email, exact: true }) })
    .getByRole('link', { name: 'Open verify link' })
    .click();
  await page.getByRole('button', { name: 'Verify my email' }).click();
  await expect(page.getByRole('status')).toContainText('Email verified');
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: false }).click();
  await expect(page).toHaveURL(/onboarding/);
  await page.getByLabel('Stage name', { exact: true }).fill(`TEST DJ ${label.toUpperCase()}`);
  await page.getByLabel('Booking page address').fill(slug);
  await page
    .getByLabel('About your sound')
    .fill('Synthetic DJ for local acceptance testing. Not a real marketplace listing.');
  await page.getByLabel('Package name').fill('Celebration · four hour set');
  await page
    .getByLabel('What’s included')
    .fill('Synthetic package: four hours of music for the test event.');
  await page.getByLabel('Total price (JMD)').fill('55000');
  await page.getByLabel('Required deposit (JMD)').fill('27500');
  await page
    .getByLabel('Your direct deposit instructions')
    .fill(
      'TEST ONLY — no bank details. Do not transfer funds. This booking uses synthetic evidence.',
    );
  await page
    .getByLabel('Your booking agreement')
    .fill(
      'TEST AGREEMENT — local QA only, not published legal terms. No real event or payment. DJ confirmation requires explicit actual-funds attestation in this synthetic test.',
    );
  await page.getByRole('button', { name: 'Publish my local booking page' }).click();
  await expect(page).toHaveURL(/dashboard$/);
  return { email, slug };
}
test('complete browser journey with two isolated DJs and an account-free client', async ({
  browser,
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const a = await setupDJ(page, 'alpha');
  const other = await browser.newContext();
  const bpage = await other.newPage();
  await setupDJ(bpage, 'bravo');
  const client = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const cp = await client.newPage();
  cp.on('pageerror', (e) => errors.push(e.message));
  await cp.goto(`/dj/${a.slug}`);
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    await cp.setViewportSize({ width, height: 1000 });
    expect(await cp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  }
  await mkdir('docs/evidence', { recursive: true });
  await cp.screenshot({ path: 'docs/evidence/public-dj-desktop.png', fullPage: true });
  await cp.setViewportSize({ width: 390, height: 844 });
  await cp.screenshot({ path: 'docs/evidence/public-dj-mobile.png', fullPage: true });
  const date = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  await cp.getByLabel('Event start (Jamaica time)').fill(`${date}T20:00`);
  await cp.getByLabel('Your full name').fill('Synthetic Client');
  await cp.getByLabel('Your email').fill('synthetic-client@example.test');
  await cp.getByLabel('Event venue / address').fill('TEST venue, Kingston');
  await cp.getByRole('button', { name: 'Hold my date' }).click();
  await expect(cp.getByRole('heading', { name: 'Your event is taking shape.' })).toBeVisible();
  await expect(cp.getByRole('button', { name: 'Copy private booking link' })).toBeVisible();
  const id = cp.url().split('/booking/')[1].split('#')[0];
  await cp.getByLabel('Full name as your signature').fill('Synthetic Client');
  await cp.getByLabel('I have read and accept this exact agreement').check();
  await cp.getByRole('button', { name: 'Sign agreement' }).click();
  await expect(cp.getByText('Signed by Synthetic Client')).toBeVisible();
  const receipt = await sharp({
    create: { width: 600, height: 300, channels: 3, background: '#ede3c7' },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="600" height="300"><text x="30" y="80" font-size="24">SYNTHETIC TEST RECEIPT</text><text x="30" y="135" font-size="20">NO REAL FUNDS TRANSFERRED</text></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  await cp.getByLabel('Payment reference', { exact: true }).fill('TEST-BROWSER-REFERENCE');
  await cp.getByLabel('Amount you sent (JMD)').fill('27500');
  await cp
    .getByLabel('Receipt image')
    .setInputFiles({ name: 'synthetic-receipt.png', mimeType: 'image/png', buffer: receipt });
  await cp.getByRole('button', { name: 'Submit evidence for DJ review' }).click();
  await expect(cp.getByText('DJ verification pending', { exact: true })).toBeVisible();
  await expect(cp.getByRole('heading', { name: 'Your booking is confirmed.' })).toHaveCount(0);
  const privateResponse = await bpage.request.get(`/api/bookings/${id}`);
  expect(privateResponse.status()).toBe(404);
  const guestData = await (await cp.request.get(`/api/bookings/${id}`)).json();
  expect((await bpage.request.get(`/api/receipts/${guestData.claims[0].id}`)).status()).toBe(404);
  const csrf = await cp.request.post(`/api/bookings/${id}/sign`, {
    headers: { Origin: 'https://untrusted.example' },
    data: {},
  });
  expect(csrf.status()).toBe(400);
  await page.goto(`/dashboard/bookings/${id}`);
  await expect(page.getByRole('heading', { name: 'Check your payment account.' })).toBeVisible();
  await page.getByLabel('Actual amount received (JMD)').fill('27500');
  await page.getByLabel('Reference in your payment account').fill(`SYNTHETIC-BANK-${randomUUID()}`);
  await page.getByLabel('I checked my own payment account').check();
  await page
    .getByLabel('Reconciliation notes / reason')
    .fill('Synthetic test attestation only. No money moved.');
  await page.getByRole('button', { name: 'Record verification decision' }).click();
  await expect(page.getByRole('heading', { name: 'Your booking is confirmed.' })).toBeVisible();
  await cp.reload();
  await expect(cp.getByRole('heading', { name: 'Your booking is confirmed.' })).toBeVisible();
  await cp.screenshot({ path: 'docs/evidence/confirmed-mobile.png', fullPage: true });
  await page.screenshot({ path: 'docs/evidence/dj-verified-desktop.png', fullPage: true });
  const confirmed = await (await cp.request.get(`/api/bookings/${id}`)).json();
  expect(confirmed.status).toBe('CONFIRMED_LOCKD');
  expect(confirmed.verified_minor).toBe(2750000);
  expect(
    confirmed.events.filter((e: { kind: string }) => e.kind === 'CONFIRMED_LOCKD'),
  ).toHaveLength(1);
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    await cp.setViewportSize({ width, height: 1000 });
    expect(await cp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  }
  await cp.goto('/login');
  await cp.keyboard.press('Tab');
  await expect(cp.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  expect(errors).toEqual([]);
  await other.close();
  await client.close();
});
