# Lockd implementation status

## Takeover audit — 10 November 2026 (Claude Code, verified against source and runs)

Development moved from the OpenAI Codex session to Claude Code. Nothing below is taken from the prior summary without checking it.

**Repository state found.** `main` at `b6a7bff` matched `origin/main`. Uncommitted: e2e assertions that wait for rendered headings before screenshots, regenerated screenshots, and a dev-generated `next-env.d.ts` path. The assertions and screenshots were verified and committed separately (`0aad36e`); `next-env.d.ts` was restored. A local PostgreSQL from the previous session was still running on 55432 and was restarted through `npm run db:local`.

**CI.** The prior report did not confirm CI for the last push. Verified with `gh run list`: all three pushes passed, including `b6a7bff` (run 42837501277, 3m11s, migrations + typecheck + lint + 57 DB tests + 2 browser journeys + build + audit).

**Local re-run before any change.** `npm run typecheck` and `npm run lint` passed; `npm test` **57/57 passed**; `npm run test:e2e` **2/2 passed** (1.1 min) after installing Playwright Chromium for this Windows user (the first run failed only because the browser binary was absent).

**Prior claims checked against code.**

| Claimed | Verdict | Evidence |
|---|---|---|
| DJ registration, verification, onboarding | VERIFIED | `db/001,005`, `src/lib/auth.ts`, e2e journey. Verification/reset emails were never delivered — local file only. |
| Public booking pages, 48h holds, +24h grace once | VERIFIED | `create_hold`, `submit_proof`, table CHECKs on `bookings`; grace boundary tests. |
| Agreements, private evidence uploads | VERIFIED | Immutable triggers, sanitize/re-encode, RLS; tests. |
| Explicit DJ verification before confirmation | VERIFIED | `verify_payment` requires attestation + bank reference; evidence alone never confirms. |
| PostgreSQL, RLS, collision prevention, immutable records | VERIFIED, one gap | GiST exclusion + per-DJ locks + race tests. Gap: 001's per-schema `ALTER DEFAULT PRIVILEGES … REVOKE` is a PostgreSQL no-op, so every function created after 001 was PUBLIC-executable. Not exploitable while only the runtime had schema USAGE; fixed in `010` before adding a second role. |
| Profile/package editing | VERIFIED | `update_profile`, revision + snapshots. |
| Cancellation, reschedule, refunds | VERIFIED | `db/006`; two-party amendment and refund attestation tests. |
| Manual subscription invoices, Pro, 7-day grace | VERIFIED | `db/007,008`; exact price CHECK, grace in `pro_access`. |
| Founding DJ max 50 | VERIFIED | Seat PK 1–50, advisory lock, concurrent final-seat test. |
| Billing staff MFA and audit | VERIFIED | `db/007,009`, RFC 6238 vectors, replay/rate tests. |

**Gaps found that block real operation (prioritised).**

1. **No email delivery at all** — the outbox only accumulated rows. Hold confirmation, DJ booking request and agreement-signed messages were not even queued; verify/reset rows held only token hashes so a dispatcher could not have built links. → Fixed this milestone.
2. **Clients who lose the private link have no recovery.** → Fixed this milestone.
3. **No Super Admin operations**: only a billing-scoped staff role exists; no listing moderation (onboarding publishes immediately), no support/case access, no view of failed notifications, staff provisioning only via a local script. → Next milestone.
4. No public reviews workflow (handover sequence item 7; correctly deferred).
5. Launch dependencies outside code: legal/privacy sign-off, real Lockd bank details, email provider account and domain, production hosting.

## Current milestone — Super Admin operations (scopes, listing moderation, delivery ops, audit)

**Implemented and tested locally.** Builds on the existing billing staff identity and TOTP step-up (ADR 012).

| Capability | Status | Implementation |
|---|---|---|
| Scoped staff authority (`listings`, `support`, `notifications`, `admin`) with fresh MFA | EXISTS | `db/011_operations.sql` `staff_can`; enforced in every function, rechecked after lock waits |
| Super Admin grants/revokes scopes for other staff, never self | EXISTS | `set_staff_scope`, `/staff/admin` |
| Listing review: pending → approved/restricted with fixed reason codes and notes | EXISTS | `review_listing`, immutable `listing_reviews`, `/staff/listings` |
| Directory requires approval; restriction hides page and blocks new holds; existing bookings continue | EXISTS | `public_profiles`, patched `create_hold` predicate |
| DJ sees review status/reason; DJ emails on approve/restrict/reinstate | EXISTS | Dashboard notice, `LISTING_*` templates |
| Delivery operations: masked metadata, counts, requeue failed non-link messages once | EXISTS | `staff_notifications`, `requeue_notification`, `/staff/notifications` |
| Unified immutable staff audit trail (operations + billing) | EXISTS | `staff_events`, `staff_audit`, `/staff/admin` |
| Local scope provisioning | EXISTS (local only) | `npm run staff:local` |
| Case-scoped support access to a booking, privacy requests, incident log, feature flags, staff disable/recovery UI, production enrollment | MISSING | Next operations slices |

**Verification.** `npm test` **72/72** (4 new: moderation lifecycle and directory/hold effects with emails and immutable history; scope, MFA-expiry, self-review, reason-code and table-access denials; masked notification metadata, link-requeue refusal, single requeue with audit and own-account denial; Super Admin grant/revoke/self-denial and unified audit). New browser journey: a new DJ is unlisted but sees "Listing under review"; staff unlock with an authenticator, approve (DJ appears in directory), restrict with a reason (public page gone, DJ dashboard shows the reason, restriction email delivered), notifications page shows no full addresses; no console errors; no horizontal overflow at 320–1440px. Evidence: `docs/evidence/staff-listings-desktop.png`, `staff-notifications-mobile.png`. Also fixed `<Link className="secondary">` rendering without padding across the app.

## Previous milestone — transactional email delivery and notifications

**GitHub CI passed** on `5a82fb7`: https://github.com/tillmate/lockd/actions/runs/42855619198 (fresh Linux/PostgreSQL, worker-driven browser journeys).

**Implemented and tested locally. No real email provider is configured and no real email has been sent.** Delivery to a real inbox needs a Resend account, API key and verified sending domain (owner action).

| Capability | Status | Implementation |
|---|---|---|
| Delivery queue with leases, retries, backoff, terminal failure | EXISTS | `db/010_notifications.sql` (`notifier_claim/finish`), `src/lib/notify/dispatcher.ts` |
| Separate least-privilege worker role | EXISTS | `lockd_notifier`: four functions only; cannot read bookings or call booking functions; runtime cannot read the queue |
| Duplicate protection | EXISTS | Dedupe keys, `SKIP LOCKED` leases, lease-holder-only finish, outbox id as provider idempotency key; competing-worker test |
| Delivery audit history | EXISTS | Immutable `notification_attempts` (provider, message id, outcome, error) |
| Encrypted link tokens in queued email | EXISTS | `NOTIFICATION_KEY` AES-256-GCM, attached in the same transaction, erased after final outcome |
| Local testing without sending | EXISTS | `EMAIL_PROVIDER=local` → Test mailbox (loopback local mode only); Playwright starts the worker |
| Real provider | EXISTS / NOT CONFIGURED | Resend HTTPS adapter (`src/lib/notify/transport.ts`); `EMAIL_ALLOWED_DOMAINS` staging guard |
| DJ verification and password recovery | EXISTS | Links delivered; expired-before-delivery links fail instead of sending |
| Client hold confirmation + DJ booking request | EXISTS (new) | `booking_events` trigger |
| Agreement signed (both parties) and signing reminder | EXISTS (new) | Trigger + `enqueue_due_reminders` |
| Deposit evidence to DJ; DJ verification reminder | EXISTS | Existing outbox row + new reminder |
| Verified, confirmed, partial (discrepancy), rejected, late-payment | EXISTS | Amounts as of the decision |
| Hold expiry, deposit-deadline reminder | EXISTS | |
| Date change proposed/accepted/applied/declined/withdrawn; cancellation requested/approved/declined; refund attested/acknowledged; refund-due reminder | EXISTS | Both parties, role-specific wording |
| Subscription invoice, receipt received, failed (rejected) and partial payment, activation, founding approval, needs-resolution, void | EXISTS | Billing events now name the exact event |
| Renewal due (7 days), grace started, lapsed to Free | EXISTS (new) | Reminders, suppressed if renewed |
| Client private-link recovery | EXISTS (new) | `guest_links` + `request_guest_link`; original link keeps working; no match disclosure |
| Bounce/complaint webhooks, suppression list, SMS/WhatsApp, preferences, staff requeue UI | MISSING | Requeue/inspection lands with Super Admin |

**Verification.** `npm test`: **68/68** (57 existing + 11 new: exactly-once delivery, verify-link round trip, expired/missing link failure, retry/backoff/permanent/terminal, stale lease, competing workers, role isolation in both directions, reminder idempotency and stale suppression, discrepancy/confirmation/cancellation wording and amounts, billing/renewal/grace/lapse, link recovery isolation, allowlist, HTML/subject escaping, Resend status mapping and idempotency header). Browser journey extended: the hold email reaches the client mailbox with the exact private link, the DJ receives the request, and a fresh browser recovers access through the emailed link. Typecheck and lint pass.

## Previous milestone — manual software invoices, founding allocation and billing staff MFA

**Implemented locally with real PostgreSQL persistence. Not production-ready or deployed.** The browser workflow is connected end to end; no payment gateway or external money movement exists. All demonstrations use visibly labeled synthetic accounts, terms, receipts and attestations.

| Capability | Current status | Owning implementation / limitation |
|---|---|---|
| DJ registration, contact verification, sign-in, reset, logout | EXISTS locally | `src/lib/auth.ts`, `src/app/api/[...path]/route.ts`; scrypt and hashed opaque tokens. Local mailbox only. |
| DJ onboarding / public profile / package | EXISTS | One editable package; owner settings with stale revision protection and immutable prior snapshots. Stable slug, public toggle; existing agreements/prices/buffers preserved. |
| Shared DJ link and client without account | EXISTS | Public route plus private fragment link exchanged for HttpOnly guest cookie. Save the private link; no email delivery/recovery service yet. |
| Hold / buffers / blocked intervals / Free cap | EXISTS | `db/001_core.sql` plus clock refinements; per-DJ locks and GiST exclusion constraints. Three active Free bookings, UTC instants, Jamaica rendering. |
| Signed immutable agreement | EXISTS | Exact snapshot, SHA-256 hash, version and typed signature with explicit acceptance. No legal-validity claim. |
| Private deposit evidence | EXISTS | `src/lib/service.ts`; PNG/JPEG validation, 5 MB/20 MP limits, PNG re-encoding, RLS-protected PostgreSQL bytes. |
| DJ actual payment verification / confirmed booking | EXISTS | `verify_payment`; explicit attestation, unique bank references, immutable decisions and audit; proof alone never confirms. |
| Partial, rejected, repeated and late proof | EXISTS | Cumulative actual verified amounts; one decision per claim; duplicate rejection; late funds preserved without reacquiring released slot. |
| Expiry and client confirmation | EXISTS / PARTIAL | Transactional expiry on access/allocation + `scripts/worker.ts`; private page updates every 30s. Notification outbox persists events; external delivery is missing. |
| Completed event | EXISTS | Owning DJ may complete ended confirmed events, idempotently; review invitation workflow is missing. |
| Multi-tenant authorization and private files | EXISTS | RLS, restricted runtime role, server-only functions, guest capability reads, private attachment downloads. |
| Local/CI test tooling | EXISTS | `scripts/local-db.ts`, migration ledger, `tests/booking.test.ts`, Playwright browser test and GitHub Actions. Fresh Linux/PostgreSQL CI passed. |
| Subscriptions / manual invoices / founding seats | EXISTS locally | Exact monthly/annual/founding invoices, private evidence, actual-receipt reconciliation, renewal grace, backend paid-access cap, transactional first-50 allocation. Collection disabled by default; synthetic adapter only. Live bank/tax particulars and exception resolution remain blocked. |
| Cancellations / refunds / reschedules | EXISTS locally / bounded scope | `db/006_booking_changes.sql`, `booking-changes.tsx`: client request/DJ decision, refund obligation/transfer attestation/client receipt, two-party immutable date amendments. Upcoming active bookings only; expired-fund resolution, disputes and installments remain missing. |
| Staff RBAC/MFA / moderation / privacy operations | PARTIAL | Billing-only role with encrypted TOTP, replay/rate protection, 10-minute step-up, independent reconciliation and immutable audit. No event-document access. Wider admin/moderation/privacy and production provisioning/recovery remain missing. |
| External messaging / real bank / legal/privacy approvals | BLOCKED | Requires authorized configuration and owner/legal decisions. |
| Production application deployment | NOT PERFORMED | Explicitly outside authorization. Public Git repository is source sharing only. |

## Files and migrations

- `db/001_core.sql`: tables, RLS, identity, public projections, serialized booking state machine, exclusion constraints and immutable history.
- `db/002_expiry_clock.sql`: expiry and evidence acceptance use wall-clock time after locks.
- `db/003_agreement_snapshot.sql`: separate immutable payment-instruction snapshot, readable JMD agreement values, UTC agreement times, canonical reference uniqueness.
- `db/004_creation_clock.sql`: holds start when allocated after locks; audit and verification timestamps use actual clock.
- `db/005_token_purposes.sql`: single-purpose auth tokens and safe re-request of verification.
- `db/006_booking_changes.sql`: profile revision/audit, agreement versioning, two-party amendments, cancellation/refund records, RLS and narrow authenticated functions; preserves existing data.
- `db/007_subscriptions.sql`: separate billing ledgers, staff scopes, invoice snapshots, actual-receipt reconciliation, paid access and founding allocation; extends the existing hold cap without replacing booking behavior.
- `db/008_bank_timestamp_precision.sql`: compares manually entered bank timestamps at their second precision.
- `db/009_staff_audit.sql`: MFA-success audit and freshness recheck after eligibility-review lock waits.
- `src/lib/billing.ts`, `src/lib/mfa.ts`, `src/components/billing.tsx`, `/dashboard/billing`, `/staff/billing`: full manual subscription journey and constrained review UI.
- `scripts/local-billing.ts`: loopback/synthetic-only test collection and staff enrollment; no real bank or role deployment.
- `src/lib/{db,auth,service,validation,http,format}.ts`: persistence, identity, image validation, server validation, request protection and presentation.
- `src/app/` and `src/components/`: public discovery/profile, onboarding, auth/recovery, private client booking, DJ review and availability blocks.
- `scripts/`: local PostgreSQL launcher, local-only atomic migrations, expiry worker.
- `tests/`: PostgreSQL integration suite and end-to-end browser test.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`: runbook, decisions, trust boundaries and launch gates.

## Current verification evidence

- **57 real PostgreSQL tests passed**. Added RFC TOTP vectors, replay/rate/MFA expiry and lock-wait checks, disabled collection, exact prices, immutable invoice/receipt history, tenant isolation, self-review denial, proof/partial/rejected payment separation, actual paid access, seven-day downgrade without record loss, timely versus late founder renewal and competing final-place allocations.
- **Both browser journeys passed (46.6s total)**: original booking/edit/amendment/cancellation/refund flow and a separate software subscription flow with independent founder approval, staff authenticator, invoice evidence, no Pro from proof, actual receipt attestation and allocated founding access. All six target viewport widths pass; the billing journey asserts no browser errors.
- `npm run typecheck`, `npm run lint` and optimized `npm run build` passed with **19 routes**. `npm audit --audit-level=moderate`: **0 vulnerabilities**. GitHub CI will independently check this published revision on fresh Linux/PostgreSQL.
- Figma MCP inspected BILL01 `81:108`, BILL02 `81:144` and BILL04 `81:208`: plan-specific invoices, manual collection, actual reconciliation and renewal grace. Existing responsive components and static brand assets are reused.
- New synthetic evidence: `subscription-plan-desktop.png`, `subscription-paid-mobile.png`, `billing-review-desktop.png` in `docs/evidence/`. No authenticator secret, private access link or live bank details are included.

## Booking-change milestone verification

- Local database suite: **42 integration tests** covering the original slice plus settings isolation/stale writes, original snapshot preservation, two-party hash acceptance, simultaneous signatures, target-date collision rollback, amendment eligibility/expiry, cancellation outcomes, refund attestations and new-table RLS/immutability.
- Full browser journey extended through profile editing, amendment proposal/client signature/DJ signature, cancellation request/approval, DJ refund attestation and client acknowledgement. Original agreement hash, original booked price and historical verified deposit remain unchanged. Final local run: **1 passed, 20.1s**, with refreshed screenshots and all six viewport checks.
- Typecheck and lint passed. Optimized build passed with **15 routes**, and dependency audit reports **0 vulnerabilities**. **GitHub CI passed** on implementation commit `50d565b`: https://github.com/tillmate/lockd/actions/runs/42750942096, including all 42 database tests and the extended browser journey on fresh Linux/PostgreSQL.
- Figma MCP inspected BEX09 `80:322` and BEX10 `85:2`: exact amendment acceptance, preserved prior agreement, original reservation until approval and DJ-managed cancellation/refund status. Responsive application uses persisted data rather than illustrative Figma values.
- New synthetic evidence: `docs/evidence/amended-mobile.png`, `cancelled-refund-mobile.png`, `cancelled-refund-desktop.png`. No private bearer links are shown.

## Previous milestone verification

- Public repository: https://github.com/tillmate/lockd (verified public, unauthenticated HTTP 200). Implementation commit `67afd7dfd52dd2516be88522af2d39f1b2f25015`.
- **GitHub CI passed**: https://github.com/tillmate/lockd/actions/runs/42746431820 — fresh Ubuntu runner, PostgreSQL 18 service, clean dependency installation, migrations, typecheck, lint, 29 integration tests, Playwright browser journey, optimized build and vulnerability audit. Job duration: 1m24s. This report's final update changes documentation only.

- `npm test`: **29 PostgreSQL integration tests passed**. Includes independent-connection conflict/cap races, cross-service buffers/overnight bookings, exact expiry, delayed-lock expiry, one grace only, raw database exclusion, tenant isolation, private receipts, immutable data, partial/rejected/late payment, duplicate/replay handling, auth expiry/reset and signed snapshots.
- `npm run typecheck`: passed.
- `npm run lint`: passed without warnings after replacing full-page navigation with the router.
- `npm run build`: passed (all 14 application routes compile).
- `git diff --cached --check`: passed for application source. Original handover Markdown intentionally retains its supplied two-space line breaks. Both supplied root documents were verified byte-for-byte unchanged.
- `npm audit --audit-level=moderate`: **0 vulnerabilities**. Upgraded Sharp to 0.35.5; pinned patched minimatch override for the lint-tool dependency. Lockfile committed.
- `npm run test:e2e`: **1 complete end-to-end browser test passed (24.5 seconds)** after final narrow-layout refinement. The test includes all six required viewport widths.
- Browser journey uses two separately registered, verified, onboarded test DJs and an account-free client. It asserts cross-DJ booking/receipt denial, cross-origin mutation rejection, pending status after upload, explicit DJ verification, persistent confirmed state after reload, and no browser exceptions.
- Responsive checks cover 320, 360, 390, 768, 1024 and 1440px on public and private booking pages; keyboard skip-link focus checked. This is a baseline, not a full WCAG audit.
- Synthetic screenshots: `docs/evidence/public-dj-desktop.png`, `public-dj-mobile.png`, `confirmed-mobile.png`, `dj-verified-desktop.png`. Screenshots show the real database-backed app, not Figma renders.

## Remaining dependencies and next slice

The next product slice is **audited billing-exception resolution and operational listing/support controls**, with case-scoped access and production readiness. Verified Lockd business bank details, legal/tax invoice particulars and authorized production staff provisioning are still needed before live collection. External email delivery, backup/restore, retention and stronger anonymous abuse prevention remain launch blockers. Existing bookings remain accessible after paid access lapses.

Current billing limits: one outstanding invoice, same-plan renewal requested from 15 days before the due date, no automatic collection or reminder delivery, no mid-term plan change/proration, no overpayment or invoice-refund resolution automation. Full verified payments that cannot receive a founding place/rate are preserved as `requires_resolution` without a silent substitute plan. Settlement totals are software receipts, separate from event deposits and accounting revenue recognition. Production MFA recovery and broad admin access are not implemented. See ADR 009/010 and the local billing runbook.

Current change limits: complimentary amendments keep venue/service/price fixed, expire after 48 hours, and reserve no target slot until both signatures. Interpret within 90 days relative to the original date, in either direction. Client cancellation refund defaults are suggestions pending legal validation; explicit DJ contract/legal basis is required. DJ cancellation enforces 100% return of actual verified funds. Positive refunds use a conservative seven-calendar-day deadline, within seven business days. No external funds or messages move. See ADR 007/008 for the full rationale and remaining dispute/expired-booking cases.

Before public application release: authorized email transport with retry/delivery audits; managed DB/backup and storage operations; staff MFA and listing review; stronger anonymous hold-abuse prevention; strict production CSP; signed legal/privacy/retention policy; independently reviewed deployment. See `docs/SECURITY.md` for exact boundaries.

Documented technical decisions: actual native PostgreSQL rather than an unconfigured Supabase project; local auth/mailbox adapter; atomic private evidence in PostgreSQL; minimum 72-hour online lead time; browser capability-link expiry 90 days after the event. These are recorded engineering choices, not new founder pricing/cancellation rules.

---

Audit baseline — 9 November 2026 (Jamaica)

The supplied workspace was empty (only work/ and outputs/). The owner confirmed there is **no existing repository**. No existing code, database, migrations, integrations, tests, credentials or deployed application were supplied. This new Git repository preserves the attached handover and AGENTS.md unchanged. FIRST_CODEX_PROMPT.md is contextual reference; the user's current request controls scope. No production or financial operations are authorized.

| Milestone | Baseline | Implementation plan |
|---|---|---|
| Product specification | EXISTS | Attached handover, AGENTS.md; Figma H06 verified via MCP |
| Application / database / tests | MISSING | Next.js strict TypeScript, PostgreSQL migrations, Vitest and Playwright |
| DJ identity and onboarding | MISSING | Password hashing, verified email, session authorization, profile and service configuration |
| Public DJ booking page | MISSING | Real persisted profiles/packages; no fabricated reviews or ratings |
| Availability / Free cap | MISSING | Per-DJ transactional lock, PostgreSQL exclusion constraint, buffers and blocked dates, three-active cap |
| Agreement | MISSING | Immutable version/text/hash and client signature |
| Direct deposit evidence | MISSING | Private validated image evidence, hashed capability access, one-time grace |
| DJ verification / confirmed booking | MISSING | Explicit actual-receipt attestation; immutable decision; no confirmation from proof |
| Expiry / notifications | MISSING | Database expiry on access/allocation plus worker; durable outbox; local delivery only |
| SaaS billing / founder seats | MISSING | Next milestone after booking slice; no invented bank details |
| Cancellation / rescheduling / reviews / admin | MISSING | Later milestones, preserve original agreements and verified amounts |
| External email, legal/privacy sign-off, business bank | BLOCKED | No authorized live configuration or legal approval supplied |
| Production deployment | BLOCKED | Explicitly excluded; public Git source requested separately |

## Design evidence and decisions

Figma MCP session inspected approved H06 `105:2`, onboarding `23:2`, public mobile `6:2`, desktop `37:2`; file has 20 pages as documented. Ivory `#fbf7ee`, ink `#14110a`, gold `#f5b83d`, white cards, rounded inputs and Inter-style typography. Use responsive semantic layouts with actual stored DJ data, not prototype names, prices or credentials. Handover light direction overrides older dark desktop treatment. Full visual fidelity across 165 frames is outside this slice.

No Docker daemon is running. Use a **real local PostgreSQL 18 process** via embedded-postgres (native binaries), disk persistence, independent connections and the same SQL migrations as CI. This is not an in-memory database. Supabase is not configured; use a local identity implementation with scrypt passwords and opaque hashed sessions, separate runtime/migration roles, RLS and narrow SQL functions. Document a future managed-auth integration separately rather than pretending it exists.

Private proof bytes initially live in PostgreSQL (`bytea`) behind RLS and authenticated download handlers. This keeps upload/state changes atomic and avoids orphaned public files; an object-store adapter can replace it at scale. Only sanitized PNG/JPEG receipts are accepted in this slice.

## Ordered delivery

1. Schema, constraints, RLS, identity and migration tooling.
2. Transactional booking service, client capability access, agreement and proof/verification transitions.
3. Connected responsive UI and local verification mailbox; expiry worker.
4. PostgreSQL concurrency/security integration tests and browser end-to-end demonstration.
5. Review source for secrets/private data, then publish Git source link as requested. Do not deploy the app.

No tests existed at the initial inventory. Current executed evidence is recorded above.
