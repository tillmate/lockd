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

## ADR 007 — Profile editing and immutable amendments

One package remains supported per DJ. Owner-only settings use an integer revision to reject stale writes, keep the shared slug stable, and append the previous private profile/package snapshot to an immutable audit table. Unpublishing stops new holds but leaves private bookings accessible. Existing price, terms, payment instructions, duration and occupied travel/setup buffers never change with profile edits.

An eligible confirmed booking can use one complimentary date change, requested at least 14 full days before the current event. Interpret “within 90 days” as within 90 days either side of the original event, still more than 72 hours in the future at proposal. Only a date change with unchanged venue/service/price is supported; new quotes and changed travel costs are separate future work. A proposal expires 48 hours after creation, an engineering limit independent of booking hold/grace.

Every proposal creates a new immutable agreement version referencing and preserving the current signed text and hash. Proposal alone is not consent. Both parties separately accept the exact new hash with typed names. Account then booking locks serialize signatures, cancellation and competing availability allocations. Original occupancy stays intact until the second acceptance atomically updates the existing occupied range. The proposed date is **not** reserved beforehand. The GiST exclusion constraint rechecks availability on application: a conflict rolls back the last signature and all changes, preserving the original slot. Original duration and buffers come from the booked occupied range, not the subsequently editable package.

Declines, withdrawals and expiry do not consume the complimentary move. History remains visible; only application increments the one-move counter and changes the active agreement version. Cancellation requests block proposal/acceptance until resolved; approved cancellation voids any pending amendment. Guest-link expiry extends to at least 90 days after a later event and never shortens unexpectedly. Expired proposal state is projected on reads and persisted when a replacement is proposed; no original reservation is released by amendment expiry.

## ADR 008 — Cancellation and non-custodial refund records

For an upcoming active booking, a client request records its database timestamp and reason without releasing occupancy. DJ review records approval or decline, the signed-contract/legal basis and explicit responsibility attestation. The proposed default refund suggestion uses request time: 50% of actual verified funds at >=14 full days, otherwise zero; half-cent rounding favors the client. This is a suggested contract default pending legal validation, not an automatically imposed legal conclusion. An owner may record a different client refund only with an explicit basis; all decisions retain suggested and decided amounts. DJ-initiated cancellation always requires 100% of actual verified funds. Refunds cannot exceed recorded verified funds.

Approval atomically marks cancellation, releases occupancy and preserves agreements/payment history. Refund obligation, DJ attestation of an already completed external transfer, and client acknowledgement of actual receipt are three distinct records. No provider is called or money transferred. A refund never subtracts from historical verified receipts or becomes Lockd revenue. A unique canonical transfer reference and immutable records prevent silent reuse or rewriting. One full refund attestation is supported; installment refunds, disputed/corrected decisions and expired-booking late-fund resolution need a separate audited workflow.

Use a **conservative deadline of seven calendar days** from approval for positive refunds, including client refunds. This is within seven business days without guessing a Jamaican holiday calendar. It is an explicit engineering commitment stricter than the DJ-cancellation maximum; legal/business approval remains a launch gate. The UI distinguishes an outstanding obligation from DJ-attested transfer and client-acknowledged receipt. Both parties receive durable outbox events, with no external delivery claimed.
