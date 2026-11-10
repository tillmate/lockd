# Lockd

[![Lockd checks](https://github.com/tillmate/lockd/actions/workflows/ci.yml/badge.svg)](https://github.com/tillmate/lockd/actions/workflows/ci.yml)

Jamaican DJ-first booking software. **Local development implementation; not a production service.** Event deposits go directly to the DJ. This app does not collect, hold, capture or refund money.

The first working slice is: verified DJ account → profile/package/payment instructions → public booking page → 48-hour hold → immutable signed agreement → private receipt evidence → DJ actual-receipt attestation → confirmed booking.

## Run locally

Requires Node.js 24 and npm. PostgreSQL native binaries are installed with the development dependency; Docker is optional, not required. The local database binds only to `127.0.0.1:55432` and persists under ignored `.local/postgres`.

```sh
npm ci
npm run db:local
```

Keep that terminal running. It creates a local database, applies migrations, generates random database passwords, and writes ignored `.env.local`. In a second terminal:

```sh
npm run dev
```

Open [local Lockd](http://127.0.0.1:3100). Run `npm run worker` in a third terminal: it delivers queued email to the local **Test mailbox** (nothing is sent externally), queues reminders and expires holds every 30 seconds. Expiry also runs transactionally on booking reads and allocation; a stopped worker cannot cause a double booking, and queued email waits until it restarts.

1. Create a synthetic DJ account with an `example.test` email and a password of at least 12 characters.
2. Open **Test mailbox**, follow the verification link, verify and sign in.
3. Complete onboarding with test payment instructions and a clearly marked test agreement. Do not enter real bank or client information.
4. Open the DJ booking page in another browser or private window. Choose an event more than 72 hours away, create a hold, and save the private access link.
5. Sign the agreement and upload a synthetic PNG/JPEG receipt. The booking remains pending.
6. In the DJ workspace, open the booking, inspect the receipt, and record a synthetic actual-receipt attestation. Only this explicit authorized action can confirm the booking.
7. Edit **Profile & package** from the dashboard. Existing signed prices and agreements remain unchanged; updated details apply to new bookings.
8. On a confirmed booking at least 14 days away, propose a complimentary date change. Accept the exact amendment in both client and DJ views. The original date stays reserved until both accept and the proposed date is still available.
9. Request cancellation from the client view and review it as the DJ, including the refund basis. Approval releases the date. With synthetic data only, record a refund attestation as DJ and separately acknowledge receipt as client. These actions record statements; they never transfer funds.

### Local software billing demonstration

Collection defaults disabled. To exercise billing locally, register and verify a separate synthetic reviewer, then run:

```sh
npm run billing:local -- reviewer@example.test
```

This command only accepts a loopback database in explicit local mode and a synthetic `example.test` identity. It enables clearly labeled test collection instructions with **no bank account details**, grants only billing-review authority, and writes a private authenticator enrollment URI/key under ignored `.local/`. Enroll it in an authenticator, sign in as that reviewer, and visit `/staff/billing`. Enter the current code to unlock review for ten minutes. Keep enrollment files and the generated `STAFF_MFA_KEY` private. The script never outputs the secret to logs.

As a different DJ, choose **Subscription** from the dashboard and request a monthly/annual invoice, or obtain staff founding eligibility approval before selecting Founding. Upload synthetic evidence. Paid access remains inactive until the independent reviewer verifies the actual bank receipt in the synthetic test. The review records a statement and never calls a bank. Founder allocation occurs only after full verification; receipt timing controls the seven-day renewal rule. See ADR 009/010 for exact behavior and exception limits. Production staff/bank configuration requires a separately approved release; do not repurpose this test setup for live collection.

All mailbox messages stay on disk. No financial provider is connected, and no real email provider is configured. Test links are fragment-based and removed from browser history when exchanged for an HttpOnly cookie. Do not share them publicly.

### Email delivery

The worker delivers every booking, agreement, payment-verification, change/cancellation/refund and subscription message plus reminders (see ADR 011). Locally `EMAIL_PROVIDER=local` renders them into the Test mailbox. For a staging trial of real delivery, set on the worker host: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (a verified sending domain), an `https` `APP_ORIGIN`, `NOTIFIER_DATABASE_URL`, `NOTIFICATION_KEY` (same value as the web app) and `EMAIL_ALLOWED_DOMAINS` to restrict recipients. `GET http://127.0.0.1:3101/health` reports worker status. A client who loses their private link can request a fresh one on the booking page.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm audit
```

Integration tests create and drop a uniquely named **local test database**, apply the same migrations, and use separate PostgreSQL connections to test races. They never reset the development database. Browser tests add clearly labeled synthetic accounts/bookings to the local development database and save screenshots under `docs/evidence/`. Use only a local test environment. Tests and migration scripts reject remote database hosts.

## Architecture

- Next.js App Router, React, strict TypeScript, shared Zod validation.
- PostgreSQL 18 with RLS and a restricted `lockd_runtime` role. The HTTP process uses this role, not the migration owner.
- Narrow SQL functions perform state changes and fixed-search-path privilege elevation. Runtime has no direct table-write grants.
- Per-DJ row locks serialize hold creation, evidence, verification, blocked intervals and completion. A GiST exclusion constraint prevents all occupied-range overlaps, including setup/travel buffers and different packages.
- Scrypt password hashes; 256-bit session and client-access tokens stored as SHA-256 hashes. Verified DJ email required before onboarding. Password resets invalidate sessions.
- Private image evidence in PostgreSQL `bytea`, under the same RLS as its booking. Size/signature/decoder checks, pixel limits and PNG re-encoding remove image metadata. Downloads require the owning DJ session or matching guest token and use no-store responses.
- Agreements, signatures, claims, verification decisions and booking events are append-only. Signed content includes the exact service, price, time, venue and direct-payment instructions.
- Durable transactional outbox delivered by a separate least-privilege worker role with leases, retries/backoff, provider idempotency and an immutable attempt log. Local mailbox and Resend transports; link tokens encrypted while queued. The client also sees confirmation on the private page (30-second polling, or reload).
- Integer JMD minor units and UTC timestamps; UI input/output uses `America/Jamaica` (UTC−05:00).

Read [implementation status](IMPLEMENTATION_STATUS.md), [architecture decisions](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), and the supplied [handover](LOCKD_CODEX_HANDOVER.md).

## Scope and launch gates

This slice supports one editable service per DJ, availability blocks, Free/paid access enforcement, partial/rejected evidence, late-payment exceptions, completion, upcoming-booking cancellation, direct-refund records and one eligible date amendment with both signatures. Software billing supports manual JMD invoices, private evidence, scoped staff MFA/reconciliation, first-50 founding allocation and seven-day grace. Wider admin/moderation/privacy operations, reviewed legal terms, live business-bank configuration, tax invoice export, retention, external messaging and production hosting remain separate milestones. No invented live bank instructions, reviews or ratings are shipped. See architecture decisions for exact eligibility, refund defaults, conservative deadlines and unresolved billing/dispute cases.

The Figma source was inspected through MCP. The application adapts the approved ivory/gold visual language and real booking steps to responsive HTML; it is not a pixel-for-pixel reconstruction of all design frames. Static logo is sourced from Figma; Inter is bundled locally via Fontsource. The initial audit found no existing application and the owner confirmed a new repository was needed.

**Do not deploy or run against live data without an explicitly reviewed release.** Public repository availability is source sharing, not an application deployment.
