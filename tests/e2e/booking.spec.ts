import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { provisionLocalBilling } from '../../scripts/local-billing';
import { totp } from '../../src/lib/mfa';

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
  const stageName = `TEST DJ ${label.toUpperCase()} ${suffix}`;
  await page.getByLabel('Stage name', { exact: true }).fill(stageName);
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
  return { email, slug, stageName };
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
  await expect(cp.getByRole('heading', { name: a.stageName, exact: true })).toBeVisible();
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    await cp.setViewportSize({ width, height: 1000 });
    expect(await cp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    );
  }
  await mkdir('docs/evidence', { recursive: true });
  await cp.screenshot({
    path: 'docs/evidence/public-dj-desktop.png',
    fullPage: true,
    caret: 'initial',
  });
  await cp.setViewportSize({ width: 390, height: 844 });
  await cp.screenshot({
    path: 'docs/evidence/public-dj-mobile.png',
    fullPage: true,
    caret: 'initial',
  });
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
  await cp.screenshot({
    path: 'docs/evidence/confirmed-mobile.png',
    fullPage: true,
    caret: 'initial',
  });
  await page.screenshot({
    path: 'docs/evidence/dj-verified-desktop.png',
    fullPage: true,
    caret: 'initial',
  });
  const confirmed = await (await cp.request.get(`/api/bookings/${id}`)).json();
  expect(confirmed.status).toBe('CONFIRMED_LOCKD');
  expect(confirmed.verified_minor).toBe(2750000);
  expect(
    confirmed.events.filter((e: { kind: string }) => e.kind === 'CONFIRMED_LOCKD'),
  ).toHaveLength(1);
  // Edit the live profile/package, while proving the already signed booking stays unchanged.
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Edit profile & package' }).click();
  await expect(page.getByLabel('Booking page address')).toHaveValue(a.slug);
  await page.getByLabel('Stage name', { exact: true }).fill('TEST DJ ALPHA UPDATED');
  await page.getByLabel('Total price (JMD)').fill('60000');
  await page
    .getByLabel('Your booking agreement')
    .fill('REPLACEMENT TEST TERMS. Apply only to new synthetic bookings.');
  await page.getByRole('button', { name: 'Save profile and package' }).click();
  await expect(page).toHaveURL(/dashboard$/);
  await expect(page.getByRole('heading', { name: 'TEST DJ ALPHA UPDATED' })).toBeVisible();
  await cp.reload();
  expect((await (await cp.request.get(`/api/bookings/${id}`)).json()).agreement.content_hash).toBe(
    confirmed.agreement.content_hash,
  );
  await cp.getByText('Propose a complimentary date change', { exact: true }).click();
  const moved = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  await cp.getByLabel('Proposed start (Jamaica time)').fill(`${moved}T20:00`);
  await cp
    .getByLabel('Reason for date change')
    .fill('Synthetic date change for browser acceptance testing.');
  await cp.getByRole('button', { name: 'Propose date change', exact: true }).click();
  await expect(cp.getByText('Agreement amendment · v2', { exact: true })).toBeVisible();
  await cp.getByLabel('Full name for amended agreement').fill('Synthetic Client');
  await cp.getByLabel('I read and accept this exact amended agreement').check();
  await cp.getByRole('button', { name: 'Accept amended agreement', exact: true }).click();
  await expect(cp.getByText('Client accepted as Synthetic Client', { exact: false })).toBeVisible();
  expect((await (await cp.request.get(`/api/bookings/${id}`)).json()).starts_at).toBe(
    confirmed.starts_at,
  );
  await page.goto(`/dashboard/bookings/${id}`);
  await page.getByLabel('Full name for amended agreement').fill('Synthetic DJ');
  await page.getByLabel('I read and accept this exact amended agreement').check();
  await page.getByRole('button', { name: 'Accept amended agreement', exact: true }).click();
  await expect(page.getByText('The complimentary date change has been used.')).toBeVisible();
  await cp.reload();
  const amended = await (await cp.request.get(`/api/bookings/${id}`)).json();
  expect(amended.agreement_version).toBe(2);
  expect(amended.agreements[0].content_hash).toBe(confirmed.agreement.content_hash);
  expect(amended.price_minor).toBe(5500000);
  expect(amended.starts_at).not.toBe(confirmed.starts_at);
  await expect(cp.getByText('The complimentary date change has been used.')).toBeVisible();
  await cp.screenshot({
    path: 'docs/evidence/amended-mobile.png',
    fullPage: true,
    caret: 'initial',
  });
  await cp.getByText('Request cancellation', { exact: true }).click();
  await cp
    .getByLabel('Reason for cancellation request')
    .fill('Synthetic client request. No real event or funds.');
  await cp.getByRole('button', { name: 'Send cancellation request' }).click();
  await expect(cp.getByText('Client cancellation requested', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('Review client cancellation request', { exact: true }).click();
  await expect(page.getByLabel('Refund owed (JMD)')).toHaveValue('13750.00');
  await page.getByLabel('Cancellation decision reason').fill('Synthetic approved cancellation.');
  await page
    .getByLabel('Signed agreement / legal basis for this decision')
    .fill('Synthetic QA default only. No real contractual determination.');
  await page
    .getByLabel('I reviewed the signed agreement and applicable refund obligations.')
    .check();
  await page.getByRole('button', { name: 'Record cancellation decision' }).click();
  await expect(page.getByRole('heading', { name: 'Booking cancelled.' })).toBeVisible();
  await expect(page.getByText('Refund outstanding. No transfer has been recorded.')).toBeVisible();
  await page.getByLabel('Refund transfer reference').fill(`TEST-REFUND-${randomUUID()}`);
  await page.getByLabel('I have already returned the full recorded refund').check();
  await page.getByRole('button', { name: 'Record direct refund attestation' }).click();
  await expect(page.getByText('Awaiting client acknowledgement of receipt.')).toBeVisible();
  await cp.reload();
  await cp
    .getByLabel('I checked my own account and actually received the full recorded refund.')
    .check();
  await cp.getByRole('button', { name: 'Acknowledge refund received' }).click();
  await expect(
    cp.getByText('Client acknowledged actual receipt on', { exact: false }),
  ).toBeVisible();
  await cp.screenshot({
    path: 'docs/evidence/cancelled-refund-mobile.png',
    fullPage: true,
    caret: 'initial',
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Booking cancelled.' })).toBeVisible();
  await expect(
    page.getByText('Client acknowledged actual receipt on', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: 'docs/evidence/cancelled-refund-desktop.png',
    fullPage: true,
    caret: 'initial',
  });
  const cancelled = await (await cp.request.get(`/api/bookings/${id}`)).json();
  expect(cancelled.status).toBe('CANCELLED');
  expect(cancelled.verified_minor).toBe(2750000);
  expect(cancelled.decisions[0].refund_minor).toBe(1375000);
  expect(cancelled.decisions[0].acknowledged_at).toBeTruthy();
  expect((await bpage.request.get(`/api/bookings/${id}`)).status()).toBe(404);
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

test('manual subscription invoice requires scoped staff MFA and actual reconciliation before paid access', async ({
  browser,
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') browserErrors.push(m.text());
  });
  const dj = await setupDJ(page, 'subscriber');
  const staffContext = await browser.newContext(),
    sp = await staffContext.newPage();
  sp.on('pageerror', (e) => browserErrors.push(e.message));
  sp.on('console', (m) => {
    if (m.type() === 'error') browserErrors.push(m.text());
  });
  const staff = await setupDJ(sp, 'billing-reviewer');
  const enrollment = await provisionLocalBilling(staff.email);
  await sp.goto('/staff/billing');
  await expect(sp.getByRole('heading', { name: 'Verify it’s you.' })).toBeVisible();
  await sp.getByLabel('Authenticator code').fill(totp(enrollment.secret));
  await sp.getByRole('button', { name: 'Unlock billing review' }).click();
  await expect(sp.getByRole('heading', { name: 'Reconcile with confidence.' })).toBeVisible();
  const accountCard = sp
    .getByRole('article')
    .filter({ has: sp.getByRole('heading', { name: dj.stageName, exact: true }) });
  await accountCard.getByText('Review founding eligibility', { exact: true }).click();
  await accountCard
    .getByLabel('Eligibility review reason')
    .fill('Synthetic independent Jamaican DJ review. Browser QA only.');
  await accountCard.getByLabel('I independently reviewed this Jamaican DJ’s eligibility.').check();
  await accountCard.getByRole('button', { name: 'Approve founding eligibility' }).click();
  await expect(accountCard.getByText('Kingston · Eligibility approved')).toBeVisible();
  await page.goto('/dashboard/billing');
  await page.getByRole('radio', { name: /Founding DJ/ }).check();
  await page.getByLabel('Business billing name').fill('Synthetic subscription business');
  await page.getByLabel('Billing email').fill(dj.email);
  await page.screenshot({
    path: 'docs/evidence/subscription-plan-desktop.png',
    fullPage: true,
    caret: 'initial',
  });
  await page.getByRole('button', { name: 'Create manual JMD invoice' }).click();
  await expect(page.getByRole('heading', { name: 'Review your subscription.' })).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const invoice = await (await page.request.get(`/api/invoices/${id}`)).json();
  expect(invoice.amount_minor).toBe(2500000);
  expect(invoice.state).toBe('open');
  expect(invoice.instructions).toContain('TEST ONLY');
  const guest = await browser.newContext();
  const outsider = await guest.newPage();
  expect((await outsider.request.get(`/api/invoices/${id}`)).status()).toBe(404);
  const image = await sharp({
    create: { width: 160, height: 100, channels: 3, background: '#e4deb0' },
  })
    .png()
    .toBuffer();
  await page.getByLabel('Subscription payment reference').fill('TEST-SOFTWARE-PAYMENT');
  await page.getByLabel('Subscription amount sent (JMD)').fill('25000');
  await page.getByLabel('Subscription receipt image').setInputFiles({
    name: 'synthetic-software-receipt.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await page.getByRole('button', { name: 'Submit subscription evidence' }).click();
  await expect(page.getByText('Claimed J$25,000.00 · Awaiting staff review')).toBeVisible();
  const before = await (await page.request.get(`/api/invoices/${id}`)).json();
  expect(before.verified_minor).toBe(0);
  expect(
    (await outsider.request.get(`/api/invoice-receipts/${before.claims[0].id}`)).status(),
  ).toBe(404);
  await page.goto('/dashboard/billing');
  await expect(page.getByText('Free access', { exact: true })).toBeVisible();
  await sp.goto(`/staff/billing/invoices/${id}`);
  await sp.getByLabel('Actual subscription funds received (JMD)').fill('25000');
  await sp
    .getByLabel('Business-bank transaction reference')
    .fill(`TEST-SOFTWARE-BANK-${randomUUID()}`);
  await expect
    .poll(() => Date.now())
    .toBeGreaterThan(new Date(invoice.created_at).getTime() + 1000);
  await sp
    .getByLabel('Bank received at (Jamaica time)')
    .fill(new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 19));
  await sp.getByLabel('I checked Lockd’s business-bank record').check();
  await sp
    .getByLabel('Subscription reconciliation reason')
    .fill('Synthetic bank reconciliation. No real funds moved.');
  await sp.getByRole('button', { name: 'Record subscription reconciliation' }).click();
  await expect(sp.getByRole('heading', { name: 'Invoice reconciled.' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Pro access active', { exact: true })).toBeVisible();
  await expect(page.getByText(/Founding allocation #/)).toBeVisible();
  await page.goto(`/dashboard/billing/${id}`);
  await expect(page.getByRole('heading', { name: 'Invoice reconciled.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'docs/evidence/subscription-paid-mobile.png',
    fullPage: true,
    caret: 'initial',
  });
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await sp.goto('/staff/billing');
  await expect(sp.getByRole('heading', { name: 'Reconcile with confidence.' })).toBeVisible();
  await sp.screenshot({
    path: 'docs/evidence/billing-review-desktop.png',
    fullPage: true,
    caret: 'initial',
  });
  await guest.close();
  await staffContext.close();
  expect(browserErrors).toEqual([]);
});
