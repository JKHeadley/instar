# Upgrade Guide — Feedback-factory receiver persistence (Option-B receiving end)

<!-- bump: minor -->

## What Changed

Implements the receiving end of the feedback-factory migration's Option-B write seam (`docs/specs/feedback-factory-migration.md`, Amendment A1 / Q2b — Dawn-confirmed 2026-06-11): the operated instance can now durably ACCEPT live fleet feedback with **no operated machine in the intake critical path**.

- **Durable cloud inbox at the front.** `feedback-front/` (the canonical Vercel receiver) gains a PERSISTENCE mode: when a Vercel Blob token is present in the function's env, the FULL ported intake pipeline runs (`handleFeedbackSubmit` — rate limit, agent fingerprint, honeypot, non-blocking HMAC, validation, dedup) and every accepted report is written as one JSON object to a Blob inbox (`inbox/<feedbackId>.json`, random-suffixed → unguessable URLs). A report is durable the instant it is accepted — a sleeping/restarting operated machine only delays processing, never loses a report. With no token the deployed front's behavior is byte-identical Phase-0 (verify-only).
- **Zero-dependency Blob client.** `BlobInboxClient` is a hand-rolled REST client (request shape from `@vercel/blob` 0.27.3, declared as `x-api-version: 7`) shared by the front bundle and the server — the front keeps its no-install deploy contract, and both ends of the inbox speak one protocol with zero drift. (Live-verified against the production Vercel Blob API: the client's pathname-in-URL request shape is rejected with `400 "Invalid pathname"` once the declared api-version is 9+, so the header is pinned to `7`, the version whose wire contract matches the request this client builds — verified across PUT/LIST/DELETE.)
- **InboxDrainer on the operated machine.** Polls the inbox and ingests into the canonical store with at-least-once + feedbackId-dedup idempotency, delete-only-after-durable-commit ordering, poison-object quarantine (preserved under `quarantine/`, never dropped), reentrancy guard, and consume-safe pagination. Read-only status at `GET /feedback-inbox/status`.
- **Durable canonical store.** `JsonlFeedbackStore` — append-only JSONL with last-write-wins load, boot-time atomic compaction, and torn-line tolerance. Deliberately format-compatible with `PersistedShadowImportTarget`, so the cutover's proven AS-IS import artifact (1,412 clusters + 148,115 rows, zero integrity issues) seeds the canonical store with no translation step.
- **Receiver handler async seam.** `handleFeedbackSubmit` is now async over a narrow `ReceiverStore` (hasFeedback/addFeedback, sync or async) — decision order, status codes, and messages are unchanged (existing unit tests re-asserted; the front's HMAC round-trip harness green against the rebuilt bundle).
- **Ships DARK.** Everything is behind `feedbackFactory.receiverPersistence.enabled` (default off) + a Blob token env (`FEEDBACK_INBOX_BLOB_TOKEN`); the route 503s when dark. Nothing changes for any install until the operated instance's cutover deploy.

## What to Tell Your User

- "The feedback system I report bugs to is moving to new infrastructure. Nothing changes for you — this update only installs the (dormant) receiving machinery; the switch-over happens later, announced separately."
- "If this install ever runs its own feedback factory: incoming reports are now made durable in the cloud the moment they're accepted, so a machine being asleep or restarting can never lose one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Feedback-inbox drain status | `GET /feedback-inbox/status` → `{ running, drained, duplicates, quarantined, errors, lastDrainAt, ... }` (503 when dark) |
| Durable receiving end (operated instances) | `feedbackFactory.receiverPersistence.enabled: true` + `FEEDBACK_INBOX_BLOB_TOKEN` env |
| Front persistence mode | Provide a Blob token in the Vercel function env (connect a Blob store); no token = Phase-0 verify-only |

## Evidence

- All three test tiers, new: 4 Tier-1 unit files (JsonlFeedbackStore durability/adoption/compaction, BlobInboxClient wire protocol, InboxDrainer semantics incl. both sides of the quarantine boundary, BlobInboxStore + async handler path), Tier-2 integration (the full accept → durable inbox → drain → canonical store pipeline over a real local Blob-protocol HTTP server, incl. retransmit-after-drain dedup), Tier-3 e2e lifecycle (dark → 503; enabled on the production init path → 200 + WIRING INTEGRITY: a seeded inbox blob lands as a durable row in the real on-disk store at the production default path).
- Unit tests caught two real bugs pre-commit (consume-while-paginating skip; compaction threshold off-by-half) — both fixed, suites green.
- Independent second-pass review of the side-effects artifact (`upgrades/side-effects/feedback-receiver-persistence.md`) raised one concern (a dropped cosmetic `phase: 0` field falsifying a byte-equivalence claim) — fixed in favor of byte-identity, front rebundled, verify harness re-run green.
