# Security boundaries and remaining work

## Implemented controls

- RLS on all business and auth/outbox tables; owner-scoped or matching guest capability reads. Private data is never exposed through public profile queries.
- Trusted server-only runtime credentials, separate migration credentials, no runtime bypass-RLS/superuser/table-write rights.
- 12–128 character passwords, salted scrypt, cryptographically random tokens, hashes at rest, verified email, expiring HttpOnly sessions, session revocation on reset/logout.
- Exact Origin validation for every mutation, SameSite cookies, no-store private responses, no-referrer and anti-framing headers. HTTPS cookie security activates for HTTPS origins.
- Backend input validation and database constraints. Bounded HTTP bodies, image signatures, pixel limits, decoding and re-encoding. No arbitrary HTML or SVG uploads.
- Database-serialized Free cap, exclusion constraints for ranges and lock ordering for state transitions.
- Immutable agreement/signature/claim/attestation/audit records. Evidence alone cannot confirm a booking.
- Profile edits reject stale revisions and preserve private audit snapshots. Amendments require independent role-authorized signatures; atomic range replacement retains the original booking on conflicts. Cancellation/refund records are immutable, tenant-scoped and never initiate a payment.
- Rate limits stored in PostgreSQL for auth, hold creation, guest exchange and proof uploads. No reliance on in-process rate-limit maps.
- Public source excludes secrets and local customer/test state. Public profile data uses only user-entered records; no ratings or testimonials are fabricated.

## Explicit trust boundaries

Database credentials are trusted backend secrets. Possessing the runtime password gives access to backend auth functions and is a server compromise; never distribute it to a browser. The migration owner can change database security and must not serve application requests. RLS protects normal runtime queries and cross-tenant accidents, not a compromised migration administrator.

A private guest link is a bearer capability. Anyone with it can read the booking, sign and submit evidence until expiry. It is not a verified client email identity. The client must save the original link. Do not put private links in screenshots, shared logs, analytics or public issues.

The local mailbox intentionally contains raw development tokens on disk and is accessible without authentication **only in explicit local mode with a loopback application origin**. The development and production start commands both bind loopback. This is not a production email implementation.

## Release blockers

1. Legal/privacy review of agreement defaults, e-sign consent/provenance, retention, controller/processor responsibilities and Jamaican launch obligations.
2. Listing approval/moderation and staff MFA/RBAC. Current onboarding publishes the DJ's page locally; there is no production approval console.
3. Authorized email provider and durable delivery worker/retry/delivery-audit implementation. Current outbox remains pending; account messages use the local adapter.
4. Managed secrets, TLS, backup/restore, encrypted storage configuration, logging redaction, monitoring, deployment review and least-privilege infrastructure operations.
5. Stronger abuse prevention for anonymous holds (e.g. verified contact / bot challenge), per-client network limits at a trusted edge, and load testing. Current per-email/per-DJ limits do not eliminate intentional calendar exhaustion.
6. Strict nonce-based production CSP. Current development CSP allows inline scripts/eval for Next.js dev behavior; do not consider it the final production policy.
7. Capability recovery/revocation and support workflow, upload scanning/retention and deletion/legal-hold procedures.
8. SaaS manual invoices, founding eligibility and paid entitlements; operational dispute resolution, installment/corrected refunds, and late-fund resolution after expiry. Upcoming-booking cancellation, complimentary rescheduling and full direct-refund records now exist locally; all event funds remain outside Lockd custody.

Automated tests cover implementation invariants; they do not replace an independent penetration test or legal sign-off.
