# AGENTS.md — Lockd repository instructions for Codex

You are implementing Lockd, a Jamaican DJ-first, non-custodial booking SaaS. Read `LOCKD_CODEX_HANDOVER.md` before planning or writing code. Figma source: https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk. Approved decisions: https://www.figma.com/design/1XhnP4WXnv6m9mf95x0Gnk?node-id=105-2.

## Work mode

- Inspect the real repository before editing. Reuse its stack, existing migrations and integrations; do not overwrite functioning code.
- Implement end-to-end vertical slices, not decorative UI or unpersisted demo flows.
- Use strict typing, server-side validation and meaningful automated tests; run them and report actual results.
- If a third-party dependency, secret, Figma access, live account or legal sign-off is missing, state it and develop safe mock/test adapters without presenting them as live.
- Do not make production deployments, mutate live data, initiate payments, contact customers or publish terms without explicit permission.
- Track implementation coverage and blockers in `IMPLEMENTATION_STATUS.md`.

## Locked MVP rules

- Public DJs and shared DJ booking links in Jamaica first; other creative roles curated invite-only beta.
- Free limit: three active bookings (held, pending, future confirmed; not expired/cancelled/completed).
- Pro: J$3,500/month; J$36,000/year. Founding: first 50 verified-paying approved DJs at J$25,000/year with 7-day renewal grace.
- Lockd subscriptions paid via manual JMD invoice to verified Lockd business bank account. No simulated gateway/autopay. DJ event deposits paid **directly to DJ** and never counted as Lockd revenue.
- Hold: 48h plus exactly one 24h proof review grace if proof received before original expiry. No automatic confirmation on screenshot/claim; actual DJ receipt verification required.
- Client cancellation >=14 days: default 50% deposit return; <14 days: default 0%. DJ cancels: 100% return within 7 business days. These are proposed contract defaults pending legal validation.
- One no-fee reschedule requested >=14 days in advance, for a free date within 90 days; preserve prior signed contract.
- Pro renewal 7-day unpaid grace then Free; preserve data and apply cap. Founding cohort limited transactionally to first 50 paid and approved.
- One eligible review per completed verified booking; public stars only after >=3. Figma ratings/profiles are illustrative and cannot go live as fabricated data.

## Technical invariants

- Multi-tenant RLS and server-side authorization on every read/write; staff MFA, scoped access, reason codes and audits.
- Transactionally prevent overlapping bookings, including holds and setup/travel buffers. Record UTC instants and render Jamaica timezone correctly.
- Preserve signed agreement versions, payment verification events and sensitive action audit trail immutably.
- Private receipts/contracts with short-lived authorized access; never expose proof by predictable booking ID.
- Quote/contact, payment claim, actual funds verified, subscription invoice and settled platform revenue are distinct concepts.
- Business rules must live in services/database constraints, not only in UI buttons.
- Treat Figma as UX specification; prototype connections and displayed sample values are not proof of implemented features.

## Model-led engineering sequence

1. Audit existing repository and Figma, create implementation matrix.
2. Build secure DJ account/profile/services/availability foundation.
3. Implement full client booking → contract → direct deposit claim → DJ verified confirmation.
4. Implement hold expiry, concurrency, partial/rejected payments and cancellations.
5. Add subscription invoice collection, entitlements and founding cohort.
6. Add privileged Super Admin operations and staging release checks.
7. Add curated other creative types and public reviews after DJ launch is reliable.

## Expected closing report

For each slice report: changed files, migrations, test commands and results, screenshots/demo, security checks, blockers and next action. Do not claim completion before tests and real backend behavior confirm it.
