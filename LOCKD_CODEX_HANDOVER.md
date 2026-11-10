# LOCKD — CODEX ENGINEERING HANDOVER

**Version:** 1.0  
**Prepared:** 9 November 2026  
**Status:** Founder-selected build specification. Figma designs are editable prototypes, not an implemented application.  
**Priority:** Move quickly toward a reliable Jamaican DJ booking launch, without shortcuts in tenant isolation, booking integrity, payments, or privacy.

## 0. Read this first

You are Codex, acting as the lead implementation engineer for **Lockd** (formerly described as a DJ-first booking product / Lock Di Date). Build a secure, functioning application—not an unconnected collection of design mockups.

**Important sequence:**

1. Inspect the *actual repository*, package manifests, migrations, environment and deployed functionality before changing anything. This handover does **not** certify the existing codebase, tooling, tables, secrets, hosting, or deployed services.
2. Read this handover and the accompanying `AGENTS.md`.
3. Connect the Figma MCP server in Codex if it is available. Inspect the actual frames and design tokens. If Figma is not accessible, explicitly flag that gap rather than inventing components or claiming pixel-perfect fidelity.
4. Create a concise implementation inventory: `EXISTS / PARTIAL / MISSING / BLOCKED` for each launch milestone, with paths to existing implementation. Reuse and preserve working code.
5. Propose a concrete, ordered implementation plan with migrations and tests. Then **implement vertical slices**, run tests and demonstrate each completed slice; do not stop at plans or fabricated success reports.
6. Preserve all existing work. Never deploy or alter a live database, transfer money, send customer messages, or publish terms without explicit authorization.

## 1. Source of truth and Figma design map

**Full Figma file:** https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk

### Frames to study first

| Purpose | Figma link |
|---|---|
| Master design index | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=45-2 |
| **Founder-approved operating rules — highest product priority** | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=105-2 |
| Decisions/register and phase scope | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=94-200 |
| Design/engineering handoff entry | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=94-2 |
| Light minimalist landing page, desktop | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=52-2 |
| Light minimalist landing page, mobile | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=55-2 |
| Creative search directory | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=56-2 |
| DJ onboarding and profile | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=23-2 |
| DJ mobile application | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=9-2 |
| DJ desktop business tools | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=26-2 |
| Core client mobile booking | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=6-2 |
| Desktop client booking | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=37-2 |
| Booking and payment exception states | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=80-2 |
| Account, access and subscription states | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=81-2 |
| Core Super Admin dashboard | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=19-2 |
| Super Admin actions | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=83-2 |
| Multi-category/quote-first creator workflows | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=84-2 |
| Agency/Crew concept (later) | https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=30-2 |

At the time of handoff, the design file contains **165 top-level design/QA frames across 20 pages**, including documentation and future concepts. This is a **design inventory**, not a declaration of 165 routes to build. Verify the live Figma contents if the file has changed.

**UI design direction:** airy, minimalist, light ivory/white, modest warm gold, comfortable spacing and elegant editorial photography. The dark, nightclub-dominant early landing page was rejected. Keep featured creatives with ratings as a design treatment; do **not** ship fabricated profiles, testimonials or numeric ratings as real marketplace information. Publicly launch Jamaican DJ booking first; curate other categories in beta.

**Source precedence on a conflict:** the approved H06 operating rules and this handover define the **target product policy**; actual repository code/schema determine the **starting implementation baseline**, not permission to ignore the approved rules. Use Figma feature flows for UX, and treat earlier exploratory frames/decks as lower-priority references. Binding applicable law and real provider behavior override mockups. Document discrepancies and implement migrations rather than silently guessing.

## 2. Product mission and user roles

Lockd is a non-custodial **booking and business-management platform** for DJs, expanding into other creative professions. A DJ sets up a profile, service packages, availability, deposit instructions and agreement terms. A client books from a shareable DJ link without creating an account. Lockd manages the hold, signed agreement, evidence upload and DJ-side verification. The booking becomes **Lockd** only after the DJ confirms that funds were actually received.

User groups:

1. **Public visitor/client**: discover profiles, choose service/time, provide event details, sign terms, view DJ direct-payment instructions, upload evidence, access private status, request changes, review after completion.
2. **DJ/creative**: onboard, verify contact, publish profile, manage services/pricing/terms, manage availability/buffers, inspect and verify direct payments, manage bookings and cancellation, access records, subscribe.
3. **Super Admin and authorized staff**: approve/restrict listings, examine scoped support cases, manage software invoices and founding eligibility, resolve platform incidents, audit actions, respond to privacy requests. All capabilities server-role-gated with MFA for privileged operations.
4. **Agency/Crew (future)**: team roles, assignments, shared calendars, billing and crew workflow. Design exists, but do not treat as initial production scope.

## 3. Founder-approved launch decisions (implement these defaults)

### Commercial and subscriptions

| Item | Locked default |
|---|---|
| Free | J$0; maximum **3 active bookings** per DJ |
| Pro Monthly | **J$3,500 per month** |
| Pro Annual | **J$36,000 per year** |
| Founding | **J$25,000/year** to the **first 50 approved, paying Jamaican DJs** |
| Founding guarantee | Retain J$25,000 annual rate if every renewal is paid within **7 calendar days** of due date. Non-transferable. Unpaid/late renewal forfeits founder rate, subject to final signed terms. |
| Subscription collection at launch | **Manual JMD invoice**, payable to Lockd's **verified business bank account**. Staff reconcile *actual bank receipts* and then activate entitlements. **No automated card charge or simulated provider capture.** |
| Overdue Pro | Pro entitlements continue for **7 calendar days** after the renewal due date; then fall back to Free rules; preserve existing records. |

Free active-booking cap: count unexpired held bookings, agreement/deposit pending bookings, payment-verification pending bookings and confirmed future bookings. Do **not** count completed, cancelled or expired bookings. Enforce with a transactional backend check, including concurrent requests. Quote enquiries alone do not consume a booking slot until they create a hold. When capped, block new holds while retaining access to contracts, records and existing bookings.

Founding seats: allocate a seat **transactionally** only after approval and verified funds. A form or pending invoice does not reserve a spot. Prevent the 51st allocation. Avoid collecting a founding payment if cohort capacity cannot be reasonably offered; handle a late payment with an authorized alternative/refund process, not a silent downgrade.

### Availability / funds

- Provisional booking hold begins at creation, lasts **48 hours** and must be collision-safe against other holds, confirmed bookings and DJ blocked dates (including overnight and setup/travel buffers).
- If client evidence arrives **before the original hold expiry**, extend the same provisional hold **once**, by **24 hours from original expiry**, for DJ verification. Resubmitting proof must **never** restart/extend this period.
- If no proof arrives by original expiry or the DJ does not verify by the end of the single grace period, **release the slot** and keep the payment claim/evidence with its status. Do not mark a booking confirmed by a receipt image, reference number, OCR, AI classification or submission timestamp.
- If actual funds arrive or are verified after slot release, **do not override a conflicting booking**. Escalate to a new hold/date or DJ-managed refund.
- DJ must explicitly attest actual funds received in their payment account. Record verified amount, evidence reference, identity, timestamp, decision and audit. Handle partial/incorrect/missing proof and duplicate evidence.
- Clients pay **the DJ directly** (bank, Lynk or any explicitly supported DJ payment rail). Lockd never holds these event deposits as platform revenue.

### Cancellations / changes (business defaults, legal review before publication)

- Client cancellation **at least 14 full days** before event: standard **50% return of verified deposit**.
- Client cancellation **less than 14 full days** before event: standard **0% deposit return**.
- DJ/creative cancels: **100% return of direct deposit within 7 business days**. DJ—not Lockd—makes the refund using the appropriate payment rail. Laws and explicitly signed exceptions may override these defaults.
- One no-fee reschedule if requested at least **14 full days** before the event and the new date is within **90 days**, provided it is available. Travel/price differences may still require a revised quote.
- Never release a confirmed original slot while an amended date is merely proposed. Both parties must accept the new agreement version; preserve prior signed text immutably.

### Public marketplace and review policy

- **Launch public DJ profiles, DJ search and direct DJ booking links in Jamaica.** Other professionals enter through invitation-only curated beta and use quote-first flows; do not imply all illustrated creative categories are publicly bookable.
- **Reviews:** one review per eligible verified completed booking, subject to moderation. Show public aggregate stars only after **at least three eligible reviews**; before that show *New to Lockd* or *Not yet rated*. Never seed fake ratings in production.
- **Featured creatives:** editorially selected by authorized admins; any future paid placement must be clearly labeled *Sponsored*. Treat avatar photos and ratings currently in Figma as fictional design data only.
- Future card acceptance: **licensed-provider pilot around month 9 after first paid software launch, contingent on integration/compliance**. Broad rollout potentially **Year 2**. No card gateway dependency for MVP.

### Data and identity defaults

- Client booking status needs **no client account**, but must use verified short-lived email code or high-entropy private link; do not use a guessable booking ID as a credential.
- Proposed UX TTL: email one-time verification code **15 min**, private evidence access URL **10 min**. Backend should implement token hashing, rate limiting, and re-verification of sensitive actions.
- Proposed ordinary booking metadata retention: **24 months after completion**; standalone payment evidence: **12 months**; tax-relevant invoices/agreement records: **at least 7 years where legally applicable**, with legal-hold/deletion exceptions. These are **proposed product defaults, not independently certified legal requirements**; obtain legal/privacy sign-off.
- Non-DJ custom quotes valid **7 days** by default and must be versioned. Require explicit scope, deliverables, usage rights, revisions, deadlines, direct deposit and agreement terms before acceptance.

## 4. MVP architecture strategy

**Do not assume there is no existing app.** Inspect actual code and established technology. Preserve working integrations and conventions. If starting with a blank repository, the recommended baseline is:

- Web: Next.js App Router, TypeScript (strict), React, Tailwind and accessible component primitives (e.g. shadcn/ui).
- Backend/database: Supabase Auth + Postgres + Row-Level Security + private Storage, with server-only privilege elevation and explicit SQL migrations.
- Validation: shared Zod schemas or equivalent, server-side validation on every mutation, optional React Hook Form for complex forms.
- Testing: Vitest (unit/service), Postgres-backed integration tests, Playwright end-to-end, lint/typecheck in CI.
- Background operations: reliable scheduled expiry/notification jobs, idempotency keys, transactional outbox or equivalent, retry + delivery audit; choose queue/scheduler based on actual hosting.
- Hosting and email: use existing deployment/email provider if configured and authorized. Otherwise document choices before connecting production services.
- Use UTC for persisted instants; render local events with `America/Jamaica` and ensure overnight spans and event venue timezone can be represented. Monetary amounts in integer JMD minor units (or the existing precise-money convention), not JavaScript floats.

Do not invent, replace or secretly launch a payment gateway, impersonation/login-as-user feature, live payouts or custody accounts.

## 5. Proposed data model (adapt to actual repository)

Suggested tables / bounded contexts:

| Domain | Suggested entities / essential fields |
|---|---|
| Identity | `users`, `creative_accounts`, `creative_memberships`, `roles`, `staff_roles`; verified email, tenant/account IDs, RBAC scope |
| Public profiles | `creator_profiles`, `service_categories`, `service_packages`, `portfolio_assets`, `listing_visibility`, `featured_placements` |
| Availability | `availability_rules`, `blocked_intervals`, `booking_holds` (slot range, owner, initial expiry, single grace expiry, version, status) |
| Bookings | `bookings` (creative + package + client, interval, money, status), `booking_events` immutable transitions, `client_private_access` |
| Agreements and quotes | `quote_requests`, `quote_versions`, `agreement_versions` (exact text/content hash), `signatures` (version, actor, accepted_at, IP/device provenance as legally approved) |
| Direct DJ payments | `payment_claims`, `proof_assets` (private, access controlled), `payment_verifications` (verified amount, attester, time, reconciliation result) |
| SaaS billing | `subscription_plans`, `subscriptions`, `invoices`, `invoice_payments`, `manual_reconciliations`, `founding_memberships` (unique cohort slot, verified-paid event) |
| Trust, support, ops | `reviews`, `moderation_cases`, `support_cases`, `privacy_requests`, `audit_events`, `staff_approvals`, `notification_outbox`, `delivery_attempts` |

**Mandatory invariants:**

- Every business-owned record is tenant-scoped. Implement RLS policies and backend authorization: DJ A must never access DJ B's clients, files, payments or invoices.
- Protect private proofs/contracts in private storage; no public bucket or predictable permanent URL.
- Booking slot ranges must be guarded by database-backed concurrency controls (e.g. exclusion constraints or advisory/row locks plus transactions). A JavaScript check-then-insert is insufficient.
- `booking_events` and signed `agreement_versions` are append-only/auditable. Financial attestation cannot be silently edited to claim a different payment.
- Distinguish **claimed** direct payment, **verified** actual payment, **Lockd subscription revenue**, and **DJ service fee** everywhere.
- Carry `selected_creator_id`, `service_package_id`, `booking_id`, `hold_id`, `quote_version_id`, `agreement_version_id`, and `payment_claim_id` explicitly across server handlers; avoid leaking a demonstration creative from one flow into another.
- Use transactional/idempotent updates for allocation of founding seats, booking state transitions, invoice reconciliation and notification dispatch.

## 6. Canonical booking lifecycle

Start with this conceptual progression (actual enum naming may differ to preserve code compatibility):

`REQUESTED → HELD → AWAITING_SIGNATURE → AWAITING_DEPOSIT → PROOF_SUBMITTED → VERIFICATION_PENDING → CONFIRMED_LOCKD → COMPLETED`

Exceptions: `HOLD_EXPIRED`, `PROOF_REJECTED`, `PARTIAL_VERIFIED`, `CANCELLATION_REQUESTED`, `CANCELLED`, `RESCHEDULE_PENDING`, `AMENDED`, `DISPUTED`.

A state change is permitted only with actor authorization, valid previous state, a transaction, timestamp, relevant immutable event and idempotency protection.

Key business-state tests:

1. Two clients attempt same DJ interval concurrently: at most one valid hold.
2. Two different services on same DJ may still conflict due to setup/travel buffer.
3. Proof at 47:59 grants extension until original expiry +24h; proof at 48:01 does not.
4. Multiple uploads never extend the grace period.
5. Proof upload cannot make `CONFIRMED_LOCKD`; only authorized DJ reconciliation can.
6. A partial deposit records only verified actual amount; funds never assumed fully received.
7. Late verification after released/conflicting slot triggers a documented exception, not double booking.
8. Cancellation is not completed until the appropriate decision/terms are recorded; Lockd cannot itself reverse external funds.
9. Reschedule amendment preserves old signed agreement and holds the original confirmed slot until both sides accept.
10. Completing event changes Free-plan active-booking count and enables an eligible review invitation exactly once.

## 7. UI/UX implementation expectations

- Implement **light responsive public website** faithful to approved desktop/mobile Figma with real navigation and accessible search, and restrict public claims to real DJ data at launch.
- DJ setup: account/contact, stage name, services/packages, deposit instruction configuration, booking contract template, availability and published page. Use empty, pending, error and success states.
- DJ business interface: dashboard, calendar, bookings/holds, proof review, client list, package editor, agreement history, income reporting (DJ-entered/verified direct payments, not a Lockd bank ledger), subscription status.
- Client flow: booking link, date/time, event details, agreement, **DJ's** deposit instructions, secure evidence upload, pending verification, private status and confirmation. No mandatory account creation.
- Exceptions: payment reference mismatch, rejection, partial, expired hold, late verified claim, cancellation, rescheduling, duplicate upload, unreadable upload, no availability.
- Software subscription: choose Free/Monthly/Annual/Founding; distinct J$3,500 / J$36,000 / J$25,000 plan-specific invoices and pending states. Manual verification controls entitlements. No demo card field posing as real payment.
- Staff admin: protected dashboard, account reviews, approved suspensions, case-scoped evidence, billing invoice reconciliation, founded seat tracking, feature flags, moderation, privacy requests, incident response, audit records. Require MFA/re-auth and reason codes for sensitive mutations.
- Creative expansion: multi-category invite-only beta using same booking engine, with creator-type-specific quote forms and agreements. Do not block DJ-first MVP on future categories.
- Responsive target: 320, 360, 390, 768, 1024, 1440px; test keyboard-only, labels, focus states, screen-reader announcements, contrast, long stage names, mobile tap targets and narrow modal behavior.
- Use actual Figma component/layout semantics rather than importing flat screenshots. Prefer reusable components and design tokens.

## 8. Implementation phases and precise deliverables

### Phase 0 — audit, inventory, baseline

- Map existing source tree/routes/schema/environment/integrations/tests and Figma into a traceable feature matrix.
- Establish local setup, `.env.example` with placeholder keys only, migration workflow, lint/typecheck/test commands.
- Resolve obvious incompatibilities or existing branch conflicts before migration.
- Deliver `IMPLEMENTATION_STATUS.md`: current behavior, gaps, proposed milestones and risks.

### Phase 1 — secure DJ foundation

- Authentication, account verification/recovery, DJ onboarding, profile/service packages, deposit instructions, public DJ page.
- Multi-tenant RLS, private storage and route authorization.
- Availability blocks/calendar including buffer logic.
- Tests: permission boundaries, service validation, timezone/overlap checks.

### Phase 2 — the first real Lockd booking (highest priority)

- Client chooses a DJ/service/date; transactionally creates a hold.
- Signed immutable agreement and DJ-direct deposit instructions.
- Receipt claim/upload and safe private status access.
- DJ verifies actual funds; status becomes `CONFIRMED_LOCKD`; client receives confirmation.
- Hold/grace expiry scheduled processing and notifications.
- Demonstrate one complete working booking with two seeded test accounts and no pretend funds.

### Phase 3 — subscription revenue and booking exceptions

- Three-booking Free cap and paid entitlement enforcement.
- Three paid manual JMD invoice amounts, payment submission/reconciliation, founding eligibility and first-50 transactional seat allocation.
- Seven-day renewal grace, downgrade without record loss.
- Rejected/partial/late evidence, cancellation/reschedule/versioned agreements, overdue holds.
- Tests: billing reconciliation doesn't grant entitlements from proof alone; no overselling founding seats.

### Phase 4 — operational admin + production readiness

- Super Admin RBAC/MFA, account review, invoice audit, support evidence access, privacy case workflow, moderation, incident/event logs, feature flags.
- Idempotent notification queue and delivery visibility.
- End-to-end Playwright coverage, integration tests, accessibility baseline, staging deployment and failure-mode rehearsals.
- Review legal/privacy/bank/account dependencies before any public release.

### Phase 5 — controlled broader discovery (only after DJ MVP works)

- Moderated directory listing and discovery, invited creator types, versioned quotes, deliverables, usage rights and verified reviews.
- Do not start agency management, card gateway, lender-ready statements, international rollout, or advanced AI features without revisiting priorities.

## 9. Non-negotiable definition of done per milestone

A milestone is **not done** merely because the UI matches Figma. It requires:

- Working front-end + authoritative server actions + database migrations, no dummy persistence.
- Access isolation tests and clear evidence of real authorization checks.
- Positive and failure/edge-case tests, plus screenshot or demo of the tested flow.
- Fully implemented loading, error and empty states, accessible forms.
- No secrets in code; no unexplained third-party requests, no fake review data in public environments.
- Confirmation that a booking cannot be marked `CONFIRMED_LOCKD` just from a proof upload.
- Updated `IMPLEMENTATION_STATUS.md` stating what was implemented, changed files, executed tests, test output, migrations, environment requirements and remaining blockers.
- Prefer PR-sized vertical slices and atomic changes. If the repo already contains working code, preserve it and adapt rather than overwrite.

## 10. Launch gates (external approvals, not invitations to invent policy)

1. A **real designated Lockd business bank account** is supplied and authorized for subscription invoices, and reconciliations are operationally controlled. Never invent account numbers or bank instructions.
2. Customer-facing booking/cancellation/refund/e-sign terms are checked for legal enforceability, including Jamaican consumer-protection requirements and the specific contractual relationship with DJs.
3. Applicable Jamaican privacy/data protection obligations, retention policies, registration and processor agreements are reviewed. This document specifies proposed retention, not a statutory guarantee.
4. Email and optionally SMS/WhatsApp providers have authenticated credentials and opt-in handling; sending actual messages requires authorized configuration.
5. Security review covers RLS, storage, privileges, replay/idempotency, audit integrity, account recovery, token handling, rate limits and incident response.
6. The actual repository and deployment account are confirmed before changing production infrastructure or migrations.
7. Card processing remains disabled until a licensed provider, agreement, testing and compliance allow it.

## 11. Reporting format for Codex after each vertical slice

Return:

- **Implemented:** concrete working behavior.
- **Files and migrations:** paths created/changed.
- **Verification:** commands executed, passing/failing tests and any screenshots.
- **Security checks:** relevant RLS, private storage and concurrency tests.
- **Unresolved external dependencies:** credentials, legal review, bank settings, service access, etc.
- **Next slice:** the smallest valuable increment that moves the first real DJ booking closer to launch.

**Do not invent test results, deployment status, payment collection, permissions, account balances or available provider integrations.**
