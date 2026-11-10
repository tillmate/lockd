# Lockd implementation status

## Current milestone — first booking slice

**Implemented locally with real PostgreSQL persistence. Not production-ready or deployed.** The browser workflow is connected end to end; no payment gateway or external money movement exists. All demonstrations use visibly labeled synthetic accounts, terms, receipts and attestations.

| Capability | Current status | Owning implementation / limitation |
|---|---|---|
| DJ registration, contact verification, sign-in, reset, logout | EXISTS locally | `src/lib/auth.ts`, `src/app/api/[...path]/route.ts`; scrypt and hashed opaque tokens. Local mailbox only. |
| DJ onboarding / public profile / package | EXISTS | `src/components/forms.tsx`, `src/app/dj/[slug]/page.tsx`, SQL `onboard/public_profiles`; one package configured at onboarding. Profile/package editing is next. |
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
| Subscriptions / manual invoices / founding seats | MISSING | All accounts currently Free; no self-service Pro bypass, invoice collection or bank data invented. |
| Cancellations / refunds / reschedules | MISSING | Documented next vertical slice. No UI claims these operations are available. |
| Staff RBAC/MFA / moderation / privacy operations | MISSING | Launch blocker; no public staff route or fabricated admin controls. |
| External messaging / real bank / legal/privacy approvals | BLOCKED | Requires authorized configuration and owner/legal decisions. |
| Production application deployment | NOT PERFORMED | Explicitly outside authorization. Public Git repository is source sharing only. |

## Files and migrations

- `db/001_core.sql`: tables, RLS, identity, public projections, serialized booking state machine, exclusion constraints and immutable history.
- `db/002_expiry_clock.sql`: expiry and evidence acceptance use wall-clock time after locks.
- `db/003_agreement_snapshot.sql`: separate immutable payment-instruction snapshot, readable JMD agreement values, UTC agreement times, canonical reference uniqueness.
- `db/004_creation_clock.sql`: holds start when allocated after locks; audit and verification timestamps use actual clock.
- `db/005_token_purposes.sql`: single-purpose auth tokens and safe re-request of verification.
- `src/lib/{db,auth,service,validation,http,format}.ts`: persistence, identity, image validation, server validation, request protection and presentation.
- `src/app/` and `src/components/`: public discovery/profile, onboarding, auth/recovery, private client booking, DJ review and availability blocks.
- `scripts/`: local PostgreSQL launcher, local-only atomic migrations, expiry worker.
- `tests/`: PostgreSQL integration suite and end-to-end browser test.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`: runbook, decisions, trust boundaries and launch gates.

## Verification evidence

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

The exact next product slice is **DJ profile/package editing and cancellation/reschedule requests with immutable amendment history**, followed by manual subscription invoice reconciliation and founding allocation. Keep the existing signed original slot active until both parties accept an amendment. Do not add real collection details until the Lockd business account is verified and authorized.

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
