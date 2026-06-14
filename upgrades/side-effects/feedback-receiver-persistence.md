# Side-Effects Review — Feedback-factory receiver persistence (Option-B receiving end)

**Version / slug:** `feedback-receiver-persistence`
**Date:** `2026-06-11`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (receiver/intake decision surface) — see appended response`

## Summary of the change

Implements the receiving end of the migration spec's Option-B write seam (docs/specs/feedback-factory-migration.md, Amendment A1 / Q2b, Dawn-confirmed 2026-06-11): the canonical front (feedback-front/ on Vercel) durably persists each ACCEPTED fleet report into a cloud Vercel-Blob inbox, and a new `InboxDrainer` on the operated machine ingests them into a new durable `JsonlFeedbackStore` (format-compatible with the proven AS-IS import artifacts). Files: `src/feedback-factory/inbox/BlobInboxClient.ts` (new — pinned Blob REST, zero deps), `src/feedback-factory/inbox/InboxDrainer.ts` (new), `src/feedback-factory/store/JsonlFeedbackStore.ts` (new), `src/feedback-factory/receiver/BlobInboxStore.ts` (new), `src/feedback-factory/receiver/handlers.ts` (handler made async over a narrow `ReceiverStore` seam — decision logic untouched), `feedback-front/src/feedback.ts` + rebundled `api/feedback.js` (persistence mode behind a deploy-time env token; byte-equivalent Phase-0 behavior without it), server wiring (`AgentServer.ts`, `routes.ts` GET /feedback-inbox/status, `CapabilityIndex.ts`), config type (`types.ts feedbackFactory.receiverPersistence`, dark default), Agent Awareness (`templates.ts`, `PostUpdateMigrator.migrateClaudeMd` + shadow marker). All three test tiers added.

## Decision-point inventory

- `handleFeedbackSubmit` intake defense chain (rate limit / fingerprint / honeypot / HMAC / validation / dedup) — **pass-through** — made async-capable; decision ORDER, status codes, and messages unchanged (existing unit tests re-asserted as async; the front's HMAC round-trip harness re-run green against the rebuilt bundle).
- Front mode selection (`inboxToken()` present ⇒ persistence mode, absent ⇒ Phase-0 verify-only) — **add** — a deploy-time structural gate, not a per-request heuristic; no content-based decision.
- `parseInboxItem` quarantine boundary in the drainer — **add** — classifies an inbox object as ingestable vs malformed. Malformed is PRESERVED (quarantine/), never dropped; no user-visible block.
- `feedbackFactory.receiverPersistence.enabled` config gate — **add** — dark default; enabled-without-token degrades to dark with a loud boot log line.

---

## 1. Over-block

The intake defense chain is untouched, so no new rejection of legitimate reports. The new quarantine boundary could over-classify: a future receiver writing a richer shape would still pass (extra fields flow through `[k: string]: unknown`); only a missing/empty `feedbackId`, `title`, or `description` quarantines — and the receiver structurally always writes those (it validated them two layers earlier). Residual: an operator hand-seeding the inbox with a malformed object gets a quarantined (preserved) object, which is the intended behavior. Precision note (second-pass finding): the validator only empty-checks `feedbackId`; an empty-STRING title/description passes ingest — the safe, less-quarantine direction, and the receiver validated both two layers earlier. No issue identified beyond that.

## 2. Under-block

- The per-IP rate limiter on Vercel is per-warm-instance, so a multi-instance burst admits more than 10/hr/IP (the reference's limiter has the same scope on its single deployment; fingerprint + honeypot + HMAC layers are instance-independent). Known accepted gap, flagged in the Phase-0 deploy runbook; durable backing is a deploy-time follow-up. <!-- tracked: topic-12476 -->
- Front-side dedup (`hasFeedback` = inbox prefix list) cannot see already-DRAINED ids — a retransmit after drain re-enters the inbox. By design: the drainer's canonical-store dedup drops it at ingest (integration test pins this), so end-to-end idempotency holds.

## 3. Level-of-abstraction fit

The front is stateless HTTP at the edge (Vercel — correct per spec §2.2); durability is a storage primitive at the platform layer (Blob — correct: a stateless function cannot host a durable buffer, which is exactly why the "forward + buffer in the function" alternative was rejected); the drainer is lightweight always-on at the operated-machine layer (Mini — matches §2.2's own placement taxonomy); the canonical store is data at the disk layer, format-aligned with the import machinery it inherits from. The drainer FEEDS the existing FeedbackStore seam rather than re-implementing any receiver logic. No layer inversion identified.

## 4. Signal vs authority compliance

No new blocking authority anywhere. Every accept/reject decision stays in the already-shipped, already-reviewed ported defense chain; the new components are pure transport/persistence; the status route is read-only observability; the quarantine path preserves rather than discards. Compliant with docs/signal-vs-authority.md — this change adds zero brittle checks with authority.

## 5. Interactions

- `cutoverReadiness` and the import machinery are untouched; the JsonlFeedbackStore deliberately READS the same JSONL shape `PersistedShadowImportTarget` writes, so the cutover import artifact seeds the canonical store without a translation step (unit test pins alias-id adoption).
- The handler's async change touches its one existing consumer (its unit test, updated). The front imported only defense fns before; it now also imports the handler — bundled at dev time, no runtime dep added.
- No double-fire risk: the drainer is single-instance (one server), `drainOnce` is reentrancy-guarded (`ticking`), and delete-after-commit + dedup makes overlap with a retransmit benign.
- Server boot: the init block is try/caught and null-on-failure (deny-safe 503), so it cannot cascade into adjacent component init.

## 6. External surfaces

- New Bearer-gated read-only route `GET /feedback-inbox/status` (+ CapabilityIndex + CLAUDE.md template/migration). No unauthenticated surface added.
- The front's PERSISTENCE mode changes what a fleet sender sees ONLY in that accepted reports now return the reference receiver's exact response shapes (it runs the faithful handler) — and the mode is unreachable until a Blob token reaches the function's env. Note (second-pass finding): the fallback to the store-injected `BLOB_READ_WRITE_TOKEN` means CONNECTING a Blob store to the Vercel project is itself the enabling act — deliberate, dashboard-gated, on a dedicated project, but it is the precise activation boundary, not "only the cutover deploy". Until a token exists the deployed front's no-token behavior is byte-identical Phase-0 (the 405/503 pre-gate bodies were restored to the original shape after the second-pass caught a dropped cosmetic `phase: 0` field; verify script re-run green against the rebuilt bundle).
- Blob objects are public-but-unguessable URLs (random suffix ON, pinned by unit test). Report bodies are fleet bug reports — same sensitivity class as today's POST-to-Portal path; pathnames are never predictable, and the drainer reads URLs from list results only. Token lives in env (front: Vercel env; operated machine: `FEEDBACK_INBOX_BLOB_TOKEN`), never in config.json or source.
- Timing dependence: the drainer is poll-based; a down machine only delays ingestion — the durable inbox is the buffer. That asymmetry is the design's point.

## 7. Rollback cost

- Dark by default: fleet installs see only an inert 503 route; no behavior change anywhere until BOTH the config flag and the token exist.
- Operated instance back-out: set `enabled: false` (or drop the token) and restart — the inbox simply accumulates durably until re-enabled; nothing is lost, nothing dangles.
- Front back-out: remove the token env from the Vercel project → next invocation is Phase-0 verify-only again. No deploy needed beyond an env change.
- Full revert of the PR is clean: no migrations of durable data, no schema, no external state created at merge time. The PostUpdateMigrator section-append is idempotent and harmless if orphaned (documentation text only).

---

## Second-pass review response (independent reviewer subagent, 2026-06-11)

Concern raised: the artifact's "byte-equivalent Phase-0 behavior without the token" claim was overstated — two responses in the front's no-token path changed. `feedback-front/src/feedback.ts` (405 method-not-allowed) and (503 receiver-not-configured) both dropped the `phase: 0` field that origin/main includes, and these two checks run BEFORE the token gate, so the change was live in today's no-token deployment. Materiality is low: the fleet sender never hits either path (POST-only, secret configured), the verify harness asserts neither, and dropping `phase: 0` there is arguably correct since those responses are now mode-independent — but the artifact asserted byte-equivalence twice and it was checkably false.

Everything else audited independently checked out:
- **Intake chain identical**: the `handlers.ts` diff vs origin/main touches only the new `ReceiverStore` interface, the async signature, and two awaited store calls — decision order, status codes, and messages unchanged; the handlers.test.ts diff reduces to pure async-call-shape edits.
- **Delete-after-commit + reentrancy real**: `drainOnce` guards on `ticking` (cleared in `finally`); `drainBlob` commits via a synchronous `appendFileSync` before `await client.del`; the quarantine path preserves-then-clears; pagination re-lists the first page with zero-progress and maxBatches guards; the integration test pins retransmit-after-drain dedup.
- **Dark default holds at all three gates**: server requires `rp?.enabled === true` AND the token env (warns + stays null otherwise); the route 503s on null; the front requires `inboxToken()`. Nuance: the `BLOB_READ_WRITE_TOKEN` fallback means connecting a Blob store to the Vercel project auto-enables persistence mode — deliberate, dashboard-gated, acceptable, but it weakens "unreachable until the cutover deploy".
- **Signal-vs-authority compliant**: no new blocking authority — `parseInboxItem` is a boundary structural validator whose failure path preserves rather than drops; all accept/reject judgment stays in the pre-existing ported defense chain. Minor imprecision (no action): §1's "empty title/description quarantines" — the code only empty-checks `feedbackId`; empty-string title/description pass (the safe direction).

**Resolution (author, same session):** the concern was fixed in the design's favor of byte-identity — `phase: 0` restored on both pre-gate responses (the no-token deployment is now literally byte-identical to origin/main), the front rebundled, and the verify harness re-run green. The two nuances were folded into §1 and §6 above. Iterated and closed.

---

## Post-merge live-API verification (2026-06-13, activation build)

Bringing the operated receiver live against the **real** Vercel Blob API surfaced one external-dependency defect not catchable by the stubbed unit tier (§6 follow-up):

- **`BlobInboxClient` x-api-version 9 → 7.** The hand-rolled client declared `x-api-version: 9` (carried over from the @vercel/blob source it was pinned against). The production Blob API REJECTS this client's v7-era request shape (pathname-in-URL, simple PUT body) with `400 bad_request "Invalid pathname"` once the declared version is 9+; the newer protocol versions expect a different request format the hand-rolled client does not build. Verified live against PUT/LIST/DELETE: all succeed at `7`, all fail at `9`/`11`. Pinned to `7` (the version whose wire contract matches the request this client builds). One-line fix in the shared client → corrects BOTH the front bundle and the operated-machine drainer. Adopting the @vercel/blob 2.x (`BLOB_API_VERSION=12`) protocol is a larger rewrite, tracked as receiver hardening. **Side-effect class:** external-API contract only — no data-shape, auth, dedup-key, or rollback impact (inbox object layout + drain semantics unchanged). This is the wire-version a request declares, not what it stores.
- **Activation evidence:** a signed HMAC POST to `https://feedback.dawn-tunnel.dev/api/feedback` returns `200 {received:true}` and the report lands durably in the Blob inbox as `inbox/<feedbackId>.json` with `verified:true, status:unprocessed` — the full §6 external surface exercised end-to-end against the live store.
- **Operator-env note (§6):** the operated receiver's webhook secret must be set with no trailing bytes — a prod env value of `instar-rising-tide-v1` + a literal backslash-n (NOT a real newline) was found and corrected. `normalizeWebhookSecret`/`trim()` strips real whitespace but NOT a literal `\n`, so a corrupt env value silently fails the HMAC. Set via `printf` (no trailing newline).
