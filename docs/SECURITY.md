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
- Software invoices and receipts have separate tenant RLS. Billing staff must complete time-limited TOTP step-up; codes are replay-protected, account-rate-limited and secrets encrypted. Staff cannot self-reconcile/self-approve or read event documents through the billing role. Collection starts disabled; only a clearly synthetic local adapter is supplied.
- Rate limits stored in PostgreSQL for auth, hold creation, guest exchange and proof uploads. No reliance on in-process rate-limit maps.
- Public source excludes secrets and local customer/test state. Public profile data uses only user-entered records; no ratings or testimonials are fabricated.
- Staff authority is per scope (listings, support, notifications, admin) on top of billing membership, always behind a fresh ten-minute TOTP step-up and enforced in PostgreSQL; staff cannot act on their own listing, messages or scopes; every action is an immutable audit row with a reason code.
- Email delivery runs under a separate `lockd_notifier` role limited to four queue functions; it cannot read bookings or call booking functions, and the web runtime cannot read the queue. Link tokens in queued email are AES-256-GCM encrypted with a dedicated `NOTIFICATION_KEY` and erased after the final delivery outcome. Delivery attempts are immutable audit rows. PUBLIC function execution is revoked schema-wide (ADR 011).
- Email bodies contain no payment instructions, receipts or bank references. Client link recovery adds a link instead of rotating the original, so it cannot be used to lock a client out, and never reveals whether an address matched.

## Explicit trust boundaries

Database credentials are trusted backend secrets. Possessing the runtime password gives access to backend auth functions and is a server compromise; never distribute it to a browser. The migration owner can change database security and must not serve application requests. RLS protects normal runtime queries and cross-tenant accidents, not a compromised migration administrator.

A private guest link is a bearer capability. Anyone with it can read the booking, sign and submit evidence until expiry. It is not a verified client email identity. The hold email and recovery email deliver it to the address the client typed, so whoever controls that mailbox controls the booking; the address itself is unverified, and a typo sends the link to someone else. Do not put private links in screenshots, shared logs, analytics or public issues.

The notification key and runtime credentials are both web-server secrets: anyone with both could decrypt queued link tokens. The worker needs the notifier credentials and the notification key, not the runtime or migration credentials for delivery (it still uses the runtime role for hold expiry).

The local mailbox intentionally contains rendered development messages, including raw link tokens, on disk and is accessible without authentication **only in explicit local mode with a loopback application origin**. `EMAIL_PROVIDER=local` is refused otherwise.

## Release blockers

1. Legal/privacy review of agreement defaults, e-sign consent/provenance, retention, controller/processor responsibilities and Jamaican launch obligations.
2. Case-scoped support access, privacy-request workflow and production staff provisioning/recovery/phishing-resistant authentication. Listing approval/restriction, scoped staff roles with MFA step-up, notification operations and a unified staff audit trail now exist (ADR 012).
3. Email: the durable worker, retries, delivery audit and Resend adapter are implemented and tested with a recording transport, but **no real provider account, API key or verified sending domain is configured**, and no real email has been sent. Before launch: provision a Resend account with SPF/DKIM/DMARC on the sending domain, set `RESEND_API_KEY`/`EMAIL_FROM`, trial on staging with `EMAIL_ALLOWED_DOMAINS`, and add bounce/complaint webhooks with a suppression list.
4. Managed secrets, TLS, backup/restore, encrypted storage configuration, logging redaction, monitoring, deployment review and least-privilege infrastructure operations.
5. Stronger abuse prevention for anonymous holds (e.g. verified contact / bot challenge), per-client network limits at a trusted edge, and load testing. Current per-email/per-DJ limits do not eliminate intentional calendar exhaustion.
6. Strict nonce-based production CSP. Current development CSP allows inline scripts/eval for Next.js dev behavior; do not consider it the final production policy.
7. Capability revocation and support workflow (email recovery of client links now exists), upload scanning/retention and deletion/legal-hold procedures.
8. Verified live Lockd business-bank configuration, business/tax invoice particulars and export, SaaS billing exceptions/refunds/overpayment resolution, operational dispute resolution, installment/corrected event refunds, and late-fund resolution after hold expiry. Manual software invoicing, actual receipt reconciliation, paid entitlements and founding allocation now work locally. No real bank account, payment provider or external collection is enabled.

Automated tests cover implementation invariants; they do not replace an independent penetration test or legal sign-off.
