---
title: "Explain Why Telegram Progress Messages Are Delayed"
slug: "telegram-capacity-attribution"
author: "echo"
eli16-overview: "docs/specs/telegram-capacity-attribution.eli16.md"
review-mode: operator-delegated-bounded-closure
full-convergence: false
approved: true
approved-by: "Chief scope9d7e7289 and bounded closureb039c9e8; exact prepared corrections received one external and one internal CLEAN check"
parent-principle: "Structure beats Willpower"
parent-principle-fit: "The existing send path records the actual capacity decision and timing with its attempt rather than requiring an agent to infer a cause from generic text."
review-convergence: "2026-11-23T03:37:58.177Z"
review-iterations: 6
review-completed-at: "2026-11-23T03:37:58.177Z"
review-report: "docs/specs/reports/telegram-capacity-attribution-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
cross-model-review-reason: "Chief b039c9e8 operator-delegated bounded closure after capped review; full-convergence false; actual external and internal checks clean; same family as author"
---

# Explain Why Telegram Progress Messages Are Delayed

## Problem statement

Project progress replies repeatedly wait after an attempt records credential-capacity-unavailable before Telegram network start; the current record does not establish whether the owner or caller stopped that attempt. The stored failure currently says only credential-capacity-unavailable. That does not reveal whether a short permission expired, the local socket failed, the lease was unavailable, or the rate window was full.

The Windows reply in finding N82 failed four times. Normal automatic recovery created a replacement marked as late; that replacement failed twice and was finally accepted at 2026-11-23T03:15:45.524Z. Recovery is slow/intermittent, not wholly stuck. No manual resend was performed. Historical exact refusal causes remain unproven.

Chief of Staff message 9d7e7289-64ea-4005-b82c-0f3b97406f80 states: “Add attributable timing for reserve, grant and consume per attempt, and separate the collapsed reasons (expiry, IPC, consume, lease, rate) in the stored failure, so the next failure names its cause. Then fix the root cause.” This design is the attribution phase only. No capacity policy or root-cause correction is asserted here.

## Existing boundary preserved

Installed version 1.3.1979 reserves its 250 ms grant AFTER durable claim/dispatch/policy checks. The authority retains a consumed marker until normal debit pruning. It checks consume liveness, owner identity, deadline, then grant lookup/consumed/matching expiry in that order. The current socket client returns grant/null and boolean, losing explanations.

Every permission, capacity debit, timeout, retry time and attempt-budget decision must remain unchanged. Existing 250 ms and rate-window numbers are inherited, not newly justified optimal floors. Their future revision requires measured cause evidence and a separate policy review. This phase cannot enlarge them or create a new sender/capacity pool.

## Proposed design

### Explain the same authority decisions

Add optional explained consume alongside explained reserve. Legacy wrappers delegate the same evaluation and return the same grant/null or boolean. Explained results name the FIRST observed failed predicate in the same order, never a guessed historical cause. Consume can report all reserve liveness failures except reserve-only rate-window-full. Wrong owner precedes expiry; expiry precedes lookup. Unknown-grant means lookup was reached and found no matching record. Already-consumed requires an existing positive marker. An expired pruned grant still reports grant-expired when the deadline check is reached first.

Cause enum: owner-closed, owner-not-ready, lease-not-held, account-unknown, owner-check-failed, rate-window-full, grant-expired, wrong-owner, unknown-grant, already-consumed, grant-mismatch, consume-refused, legacy-unexplained, ipc-timeout, ipc-unavailable, ipc-protocol. Explicit generic consume-refused is reserved for a received explained refusal whose implementation cannot give a more specific predicate; legacy boolean false uses legacy-unexplained.

### Compatible IPC without another mutation

Keep EXACT existing capacity-reserve/capacity-consume request shapes. Add optional explanation fields to the same responses. Old clients ignore them. New clients accept valid old responses as legacy-unexplained. Forward optional methods through TelegramOriginRuntime's wrapper.

Validate legacy decision fields FIRST. A valid grant or consumed=true remains success even when optional diagnostics are malformed or inconsistent. A valid grant=null or consumed=false establishes owner refusal, whose cause can still be unavailable. Absent explanation means legacy-unexplained; malformed/impossible optional explanation means invalid. Validate explanation phase/cause/decision/lease combinations: rate-window-full is reserve-only; positive owner response explanations have no owner refusal cause; lease explanation accepts null freshness when fallback ownsLease() actually refused; a provided holding verdict contradicts lease-not-held and is invalid. Unusable decision fields mean IPC protocol failure and UNKNOWN owner verdict. Timeout/disconnect also mean unknown owner verdict, since the owner may have consumed/debited before losing its reply. Never retry or switch protocols after that ambiguity. No additional reserve, consume or Telegram network start is authorized by diagnostics.

Use bounded enums and numbers only. Do not serialize errors, socket paths, account IDs, nonce, owner boot ID, credentials or message text in evidence.

### Per-attempt evidence at existing send boundary

The prepared egress closure captures monotonic reserve/consume durations and same-host epoch timestamps. No cross-process monotonic comparison. Freeze the resulting snapshot. Local refusal evidence travels on the existing request-bound refusal object authenticated by consumeOriginLocalRefusal; successful capacity evidence is read from the SAME prepared closure. Associate only with that exact existing claim/attempt, including accepted and unknown transport outcomes. If capacity was not reached, do not invent evidence.

Owner verdict describes the latest reached decision: reserve grant -> granted; received null -> refused; received consume true -> consumed; received false -> refused; lost decision -> unknown. A final caller deadline check can refuse the network start while ownerVerdict remains granted or consumed. That does not rewrite owner success as owner refusal.

Keep the existing outcome `reason`, `localRefusal` classification, lease retry notifications, next-attempt calculation and budget treatment EXACTLY as before. Do NOT map new diagnostic causes into scheduler reasons. Store the distinct named capacity cause separately in `capacityEvidence` on the existing attempt readback. For a formerly unexplained IPC lease refusal now served by an upgraded owner, evidence names lease-not-held while the scheduler reason stays generic. A truly old-format null/false reply can establish only legacy-unexplained and retains that same generic reason. A consume-time explained lease false also retains its previous generic scheduler reason. For the already-explained direct reserve lease refusal, retain its existing specific reason. Test STORED reason and before/after next-attempt equality through the runtime wrapper for both mixed-version directions, with direct reserve lease refusal as the existing lease-specific control. Keep newly explained IPC/consume causes ONLY on capacityEvidence, never on the refusal property consumed by originLocalRefusalReason. The user-visible/operator diagnosis reads the evidence cause, never infers it from scheduler reason.

### Exact evidence type

Full version-1 evidence allowlist (field count derived from this validator, not a handwritten count):

- version: 1
- authority: direct | ipc | legacy
- stage: reserve | consume | pre-network | network-start
- cause: one cause enum above or null
- ownerVerdict: granted | consumed | refused | unknown
- reserveStartedAtMs, reserveEndedAtMs, consumeStartedAtMs, consumeEndedAtMs, checkedAtMs, grantExpiresAtMs: nullable nonnegative safe-integer epoch milliseconds
- reserveDurationMs, consumeDurationMs: nullable finite nonnegative monotonic durations, absolute value at most Number.MAX_SAFE_INTEGER (fractions allowed)
- remainingAtReserveMs, remainingAtConsumeMs: nullable finite signed values within the same safe range
- clockUncertain: boolean
- explanation: complete | legacy-unexplained | invalid

Unreached stage fields are null, never invented zeroes. remainingAtReserveMs = grantExpiresAtMs - reserveEndedAtMs; remainingAtConsumeMs = grantExpiresAtMs - consumeStartedAtMs. checkedAtMs uses the SAME Date.now sample that decides the actual final caller deadline check, never a second sample. The final deadline observation derives from grantExpiresAtMs - checkedAtMs. Test consumption starting before expiry with a delayed reply arriving afterward: retain owner success and the separate final caller check.

A positive owner decision can have cause=null with any explanation quality when no caller-side failure follows. The top-level cause describes the observed capacity or capacity-IPC failure that prevented network start, distinct from ownerVerdict; transport failures after successful capacity consumption keep cause=null. In particular, a final caller deadline failure records stage=pre-network, cause=grant-expired and ownerVerdict=granted or consumed (whichever was actually received), with zero network starts; it never rewrites the owner result. A negative decision without usable cause has cause=legacy-unexplained, with explanation legacy-unexplained or invalid. A lost response has the actual ipc-* cause and ownerVerdict unknown. Later valid decisive refusal replaces an earlier stage's explanation quality; malformed reserve diagnostics followed by an explained consume refusal therefore store the latter actual cause/explanation, while preserving reserve timings. Null cause means no capacity refusal; malformed positive diagnostics do not fabricate one.

clockUncertain only annotates observed sampling/clock disagreement. Compare wall/monotonic intervals for reserve, the gap to consume, and consume. A difference above Date.now's 1 ms precision sets the flag but certifies neither a clock jump nor an elapsed-expiry root cause; scheduling between samples can explain it. This never changes a permission check.

The entire full object is capped at 4096 UTF-8 bytes, derived as a generous bound above fixed keys plus maximal safe numeric/enum representation. Reject extra keys before serialization. Validate before worker crossing and again in storage. A wholly invalid diagnostic object becomes EXACTLY `{version:1, explanation:"invalid"}` (a separate union branch). This marker supplies no cause or permission. Invalid diagnostics must never discard an outcome, change its existing reason, or produce local-refusal retry proof.

### Durable readback, archive and rollback

Use a separate attempt-keyed capacity-evidence table, written within the SAME existing fenced outcome transaction using a nested savepoint around only the optional evidence insert. A recoverable evidence-only SQL error rolls back that savepoint, records a fixed capacity-evidence-unavailable event using the existing attempt-event mechanism, and still commits the original fenced outcome. Readback exposes capacityEvidenceStatus=unavailable for that event, collected for valid evidence, or legacy-or-not-reached when neither exists. New archive JSON preserves the optional status. If recording the fixed event also fails, use existing fatal transaction/uncertainty handling; never synthesize acceptance or authorize resend. Emit only a coalesced secret-free fixed code through existing degradation reporting, whose failure cannot affect the outcome. No accepted attempt is retried because its diagnostics failed. Fatal transaction/database failure follows existing outcome-uncertainty handling and cannot authorize a resend. Inject an evidence-only insert failure after an accepted send and prove acceptance commits without a second send. Idempotent CREATE TABLE and AFTER DELETE trigger on telegram_origin_attempts remove only associated evidence when even an old binary purges an attempt. Existing table layouts and positional inserts remain unchanged; no foreign_keys dependency.

Add optional capacityEvidence to OriginAuditRecord attempts. Existing local HTTP, federated readback and new archive JSON carry it without a new endpoint. Existing archive compaction preserves record JSON. Old archives omit it and read normally. A rolled-back old binary ignores new optional archive data but can newly archive a live attempt without its diagnostic field; this is an explicit diagnostic-loss limitation, not custody/delivery loss. The DB trigger prevents orphan evidence. Test old/new archive, compaction, retention, rollback purge and no orphan rows. If outcome storage fails, existing handling remains unchanged: diagnostics cannot create fallback send authority.

machine-local-justification: attempt-authority — this evidence belongs to the existing local authoritative outbox attempt; existing federated/forwarded readback carries the same operation data. No independent cross-machine queue or capacity pool is created. Local timings do not establish lease permission.

## Decision points touched

- Existing capacity authority predicates — invariant; basis: irreversible-consequence; evidence: granting a second network start after unknown Telegram acceptance can publish a duplicate owner message that cannot be reliably recalled; preserve existing ownership and one-use authority. Existing numeric policy remains unendorsed and out of this delta.
- IPC parsing and fixed evidence schema — invariant; basis: enumerable-domain; evidence: the protocol decision domain is grant/null and true/false, and the fixed cause/field enums are fully enumerated in this spec; unknown diagnostic keys cannot become grant fields.
- Outcome retry proof and scheduling — invariant; basis: irreversible-consequence; evidence: returning transport budget without the matching request-bound no-network proof can replay a possibly accepted message; diagnostic fields must not alter that proof, existing scheduling reason or retry calculation.
- Root-cause repair choice — judgment-candidate; basis: actual cause/timing evidence must determine the next delta, rather than tuning TTL from generic text.

## Verification and completion

Unit: every authority predicate on both sides, boolean/grant equivalence, exact schema combinations, secret rejection, invalid marker, owner success with invalid diagnostics, stage-specific cause validation, before/after scheduler equality, exact request-bound proof. Repeat consume before expiry (retained consumed marker), missing unexpired nonce, expired/pruned record.

Real socket integration: both mixed-version directions; success/refusal; malformed optional explanation versus unusable decision; owner consumed but reply lost; no second mutation. HTTP integration: actual stored capacityEvidence in existing authorized origin readback, unauthorized/unavailable boundaries preserved. Lifecycle: production runtime/socket/outbox initialization and same-operation recovery after deterministic isolated cause clears; archive/rollback lifecycle as above. No production bot, manual resend or live queue mutation. Throughput allocates exact targeted batches; full final-head LocalVerify is required.

Throughput owns normal deployment and observation. One separately allocated positive-control refusal must run through a supported throwaway installed server/Lifeline/socket path with no real owner message/bot; inspect stored attempt and HTTP/archive readback and verify teardown. After normal deployment, inspect the next naturally occurring affected operation read-only by attempt ID. A no-new-failure observation is an explicit limitation, not proof of cause or restoration.

N82 remains the durable OPEN repair item owned by persistent Echo development identity, accountable to Chief, until the delivery root cause is fixed or Chief deliberately closes it with stated evidence limits. Existing tracked action ACT-442 is pending with dueBy 2026-11-24T03:30:00Z. Throughput's normal deployment receipt triggers the first bounded read-only follow-up to Chief. <!-- tracked: CMT-2198 --> If no affected failure exists, record that limit and review again by ACT-442's due time, then explicitly renew the due date or record Chief's deliberate closure. Existing commitment checking surfaces overdue work; no new polling loop. Attribution completion and the later cause-specific repair are distinct. No extra production restart, TTL increase, manual drain or resend is authorized by this design.

## Open questions

*(none)*

## Maturation Plan

- **test-agent-live:** Allocated isolated installed socket/outbox positive-control refusal and successful recovery, HTTP/archive readback and verified throwaway cleanup; no production bot.
- **dev-agent-live:** Throughput normal deployment followed by read-only naturally occurring attempt evidence; explicitly disclose no-new-failure limits.
- **fleet:** Normal release progression after development-agent evidence; no fleet claim from local tests.
- **graduation criterion:** Exact candidate passes all normal gates and installed diagnostics name the actual observed cause without changing scheduler reason, retry timing or permission. N82 root-cause repair remains independently open.
- **dark-window:** Observe installed development-agent attribution before claiming readiness for fleet diagnosis; no feature switch or new authority.
- **ladder:** not applicable: diagnostics repair adds no new feature flag.

## Frozen Follow-Through Carrier

> **CMT-2198** — Echo owns N82 and ACT-442: after deployment, inspect the next affected attempt read-only. If none occurs, review by 2026-11-24T03:30Z and record evidence plus a renewed due date or Chief closure. Keep the cause repair open until verified. No manual resend, capacity tuning, production queue mutation or production restart.

ACT-442 remains the canonical dated work record. This commitment mirrors that same obligation for offline review and has no duplicate notification or execution loop.


## Normal-verification positive control

Chief messages `fadc7c59-09aa-44d4-a483-96a61b58f095` and `0acf7276-e766-4a70-b34d-8e3104342440` authorize committing the corrected positive control into draft PR3674, with the proof executed by the new head's complete normal verification. No standalone priority mechanism or private retry is authorized. The existing root-cause and full-convergence limits remain unchanged.

The repository-collected lifecycle case is `tests/e2e/telegram-capacity-positive-control.test.ts`, with tracked fixtures under `tests/fixtures/telegram-capacity-positive-control/`. It uses the current built distribution in the verifier's actual checkout and records its tree head and imported compiled-module hashes. It has no dependency on a hard-coded old candidate or an untracked private manifest. Separate front and capacity-owner processes communicate through the real local IPC socket; credentials are synthetic and the front's external transport is deny-only. The front is eligible while the owner is not. One operation must retain the precise lease refusal, real timing, unchanged generic scheduler reason and next-attempt behavior, protected HTTP readback and zero transport starts.

The front must exit naturally with code0, and the owner also closes without a forced success exit. The real referenced300000ms route interval is observed with unchanged timer delegation and immediate registration restoration; only route-owned handles are cleared after assertions. Existing120-second case and bounded cleanup limits remain. The parent independently checks exact process absence, listener refusal, removed guarded home and socket. Every invocation creates its own fresh receipt path and validates its identity and front PID. Positive receipt and cleanup evidence are retained in normal verification stdout as well as the unique evidence directory.

This case has an explicit Windows skip because the existing IPC implementation requires a chmod-protected POSIX filesystem socket. That is a platform limitation, not a successful result. Studio and M5 must collect and execute the case without skipping. The normal skip-added independent-review gate remains authoritative; one unified review/trace covers all changed test paths so this boundary is not waived or hidden. No Windows runtime or IPC authority is added in this test-only increment.

Historical standalone evidence remains distinct: the first actual case failed its unchanged120-second deadline despite supporting internal assertions; later corrected invocations ended from ordinary capacity timeout before admission/collection. None qualifies the committed positive control as passed. Its actual full-gate result remains required.
