# Architecture decisions

## ADR 001 — New local app, PostgreSQL first

No repository or integrations existed; the owner confirmed this. Use the recommended Next.js/TypeScript family. Supabase credentials and a project were not supplied, and creating production infrastructure is excluded. Native embedded-postgres starts a real PostgreSQL 18 server with disk persistence and independent TCP connections. SQL migrations are portable to managed PostgreSQL. The local launcher is a developer tool, not a production database supervisor.

Supabase Auth/Storage adoption, if selected later, requires a deliberate identity and storage migration, not changing environment variables and assuming compatibility. Existing tokens, agreement history and receipt access must remain intact.

## ADR 002 — Transaction boundaries and roles

Runtime database credentials belong only to the Next.js server. They are not Supabase browser credentials. The server places hashes of authenticated session/guest cookies in transaction-local settings. RLS resolves those hashes against database sessions/bookings; no client-provided tenant ID establishes authority.

Functions have a fixed `lockd,pg_temp` search path. Auth functions are callable only by the trusted backend runtime; table reads for auth records are not granted. All business mutations are via functions; raw UPDATE/INSERT/DELETE grants are absent. The migration owner deliberately has higher authority and must never be used by web routes.

Each booking mutation locks the DJ account first, then the booking. Both Free-cap allocation and occupancy insertion happen in that transaction. All holds, confirmed bookings and personal blocks share `occupied_slots`; its database exclusion constraint is the last collision guard. Expired provisional occupancy is removed before new allocation. The worker improves notification timeliness; integrity does not depend on its uptime.

## ADR 003 — Exact hold policy

Original expiry is persisted as creation +48 hours. Validated evidence accepted before that expiry sets `grace_used=true` and expiry to original +24 hours. Never add 24 hours to the upload time. Subsequent proof is allowed during grace but cannot extend it. An expired booking can retain new evidence and actual-funds verification; its status remains expired and its slot stays released.

Timing is determined by the database after obtaining the account lock. A request arriving at an HTTP handler is not considered accepted proof until its image has validated and its transaction can accept the claim. This deliberately errs against reviving an expired hold. A request started earlier but blocked by another transaction must not bypass expiry.

For this slice, online events must start more than 72 hours and no more than 730 days ahead. This avoids a hold/grace outliving the performance. This is a documented engineering restriction, not a founder-approved new pricing or cancellation rule. Short-notice requests need a separately designed expedited workflow.

## ADR 004 — Evidence and verification

PNG/JPEG only, up to 5 MB and 20 million decoded pixels. Re-encode to PNG without metadata. Save the private bytes and claim in the same database transaction. This avoids public buckets and storage/database rollback mismatches. It trades database size for simpler privacy and atomicity; object storage and retention jobs are a later operational requirement.

Image digest uniqueness is per DJ. An exact retry with the same booking, reference and amount returns the prior claim. Reusing it with different claim details is rejected. This is exact duplicate detection, not forensic fraud detection. Verified bank references are unique per DJ to prevent crediting the same reference twice.

Each claim receives one immutable reconciliation decision. A partial receipt records only the actual verified amount; a distinct top-up claim is required for the remainder. When total actual verified funds reach the deposit and a live occupied slot and signature exist, the booking can become confirmed. Late funds remain recorded and produce an exception event requiring a new date/hold or DJ-managed refund. Lockd never reverses external money.

## ADR 005 — Guest access and signatures

Browser-generated 256-bit random capability is supplied with an idempotent hold request. It is sent over the local origin (HTTPS required for a future remote deployment), stored only as a hash in the database, and embedded in the private link fragment so it is absent from HTTP URL logs and referrers. The original capability must be retained by the client for link recovery; only the hash is persisted server-side.

The link is exchanged for an HttpOnly, SameSite=Strict cookie lasting one hour. Original link access expires 90 days after the event. A single browser guest cookie represents one open client booking at a time. Typed name plus explicit intent checkbox records agreement ID, exact content hash, identity supplied by the client and database timestamp. This records intent; it is not a claim of legal validation or independently verified client identity. IP/device collection is deferred pending privacy/legal review.

## ADR 006 — Development-only email and public source

No customer communications are authorized or configured. A local mailbox makes verification/recovery testable without sending mail. Outbox notification events are stored transactionally; they are not falsely marked delivered. A production dispatcher needs an authorized provider, encrypted token delivery payloads, deduplication keys, retry scheduling and delivery audits. Do not repurpose the local mailbox as a public endpoint.

Public Git source was explicitly requested. Exclude `.local`, `.env.local`, database files, local mailbox tokens, traces and build caches. Screenshots included in `docs/evidence` contain only synthetic QA data. No production deployment is part of source publication.
