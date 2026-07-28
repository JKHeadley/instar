# Side-Effects Review — Feedback parity Phase-3 dual-forward (emitter + client)

**Version / slug:** `feedback-parity-phase3-dual-forward`
**Date:** `2026-06-08`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds the two deterministic client-side pieces of the feedback-process migration's
Phase-3 dual-forward: an **emitter** (`buildParitySubmitPayload`) that builds the
Portal's locked parity-submit request payload from `ClusterResult[]`, and an HTTP
**client** (`submitParityBatch` + `parseParitySubmitResponse` + `verdictFromResponse`)
that POSTs it to `/api/instar/feedback-factory/parity-submit` and parses the locked
response into a fail-closed verdict keyed by `feedbackId`. No call sites wire these
into a running pipeline yet — they are the building blocks the later cutover step will
invoke. No production feedback traffic flows through them.

## Decision-point inventory

1. **Emitter — `clusterId` resolves to a cluster?** Unresolvable → THROW (no silent drop).
2. **Emitter — `batchId` non-empty?** Empty → THROW.
3. **Client — HTTP status 2xx?** Non-2xx → THROW `ParitySubmitError('http')`.
4. **Client — body is JSON?** Non-JSON → THROW `('parse')`.
5. **Client — body matches the locked shape?** Drift (unknown `status`, missing
   counts, results-not-array, bad `action`) → THROW `('shape')`.
6. **Client — network/timeout?** fetch throws/aborts → THROW `('network')`.
7. **Verdict — `allMatched`?** True iff `results.length > 0` AND every `status==='matched'`.

## 1. Over-block

**What legitimate inputs does this change reject?** The emitter throws on an
unresolvable `clusterId` or empty `batchId` — both are genuine programmer errors that
must surface, not silently emit a malformed/partial batch; this is intended strictness,
not over-block. The client throws on any non-2xx / non-JSON / shape-drift / network
condition. A `diverged`, `not_found`, or `error` *item* inside a well-formed 200 is NOT
a throw — it is a normal verdict outcome surfaced in `diverged`/`errored`; only a
transport/contract failure throws. So a real divergence report is never mistaken for an
error. The 30s timeout could abort a legitimately slow Portal response — acceptable: a
fail-closed throw is the correct outcome (caller retries/escalates), never a silent
"done".

## 2. Under-block

**What does this still miss?** The client validates structural shape, not semantic
correctness of Portal-computed verdicts — if the Portal returns a well-formed but
wrong `status`, the client trusts it (correct: the Portal is the reference authority
for apply/diverge). `allMatched=false` on an empty `results[]` is deliberate (an empty
batch proves nothing). The emitter does not dedupe `feedbackId`s within a batch (caller's
responsibility; the Portal keys results by `feedbackId`). No retry/backoff is built in —
fail-closed surfaces the error to the caller, which owns the retry policy.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The emitter lives beside the existing `processor/parity.ts`
(reusing its canonical `clusterFingerprint` — no second fingerprint implementation), and
the client is a thin, injectable (`fetchImpl`) transport wrapper over the locked contract.
Fingerprint stays single-source-of-truth (computed once, echo-side; Portal re-derives only
to validate). The fail-closed policy is enforced at the one ingress/egress boundary
(`submitParityBatch`/`parseParitySubmitResponse`), not scattered across callers.

## 4. Blast radius

**What breaks if this is wrong?** Effectively nothing today: no call site invokes these
yet, no traffic, no DB writes, no migration to existing agents (pure new source under
`src/feedback-factory/processor/`, ships in dist). A bug would surface only when the later
cutover step wires `submitParityBatch` in — and the fail-closed design means a wrong/garbled
submit throws (caller halts) rather than silently corrupting the canonical store. Reversible
by not invoking it / reverting the two files.

## 5. Failure mode

**Fail-open or fail-closed?** Fail-CLOSED by construction — every transport/contract
anomaly throws `ParitySubmitError`; the dual-forward orchestration can never read a failed
submit as success. Verified live: the real client ran against Dawn's prod endpoint
(empty-batch round-trip) → 200, locked shape parsed, verdict `allMatched=false`, no throw.
