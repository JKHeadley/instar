<!-- bump: patch -->
<!-- audience: agent-only -->

## What Changed

Phase-3 dual-forward of the feedback-process migration (Dawn Portal → Echo/Instar) gains its two deterministic client-side pieces, both built to the Portal's locked parity-submit contract:

- **Emitter** (`buildParitySubmitPayload`, `src/feedback-factory/processor/paritySubmit.ts`) — turns an array of `ClusterResult` + a cluster-resolver into the locked request payload `{ batchId, items: [{ feedbackId, action, clusterId, fingerprint, similarity, clusterTitle?, note? }] }`. The per-item `fingerprint` is computed echo-side via the canonical `clusterFingerprint({type, title})` (single source of truth — the Portal re-derives only to validate). Throws on an unresolvable `clusterId` or an empty `batchId` (no silent drop); optional fields are omitted when absent.
- **Client** (`submitParityBatch` + `parseParitySubmitResponse` + `verdictFromResponse`, `src/feedback-factory/processor/paritySubmitClient.ts`) — POSTs the emitter payload to `POST /api/instar/feedback-factory/parity-submit` (Bearer `INSTAR_ECHO_READ_TOKEN`, 30s AbortController timeout) and parses the locked response `{ batchId, processed, matched, diverged, errors, results: [{ feedbackId, action, status, clusterId?, divergenceReason?, error? }] }`. `status` (`matched|diverged|not_found|error`) is the per-item branch predicate; the derived verdict is keyed by `feedbackId`, with `allMatched` true only when every result is `matched`. **Fail-closed (no-silent-degradation standard):** a non-2xx response, network error, non-JSON body, or any shape drift THROWS `ParitySubmitError` — a failed/garbled submit is never silently treated as "matched/done".

## What to Tell Your User

Internal migration infrastructure — nothing to configure, and no production feedback traffic flows through it yet. This is the client half of the parity dual-forward: Echo computes a feedback cluster verdict and submits it to the Portal, which re-derives the fingerprint to confirm agreement before applying. Cutover to live dual-forward remains a later, operator-gated step.

## Summary of New Capabilities

| Capability | How to use |
|-----------|-----------|
| Build the locked parity-submit payload from cluster results | `buildParitySubmitPayload(results, clusterResolver, { batchId })` |
| Submit a parity batch + get a fail-closed verdict | `submitParityBatch(payload, { token })` → `{ allMatched, diverged, errored, byFeedbackId, response }` |

## Evidence

Unit tests green: emitter 9/9 (`tests/unit/feedback-factory/parity-submit.test.ts` — both sides of every boundary: merge/create, fingerprint-correct-by-construction, optional-field present/absent, Map+fn resolver, throw-on-missing-cluster, throw-on-empty-batchId) and client 12/12 (`parity-submit-client.test.ts` — request shape incl. Bearer auth + default endpoint, verdict partitioning, and every FAIL-CLOSED path: non-2xx, non-JSON, shape drift, network throw, missing token). `tsc --noEmit` clean. **Live-verified:** the real `submitParityBatch` ran end-to-end against Dawn's live prod endpoint (empty-batch round-trip) → HTTP 200, locked shape parsed with no drift-throw, verdict `allMatched=false` (correct for empty results), `batchId` echoed. Tier-1 change; side-effects review at `upgrades/side-effects/feedback-parity-phase3-dual-forward.md`. Earned from topic 12476 (feedback-process migration, Dawn-coordinated; response contract locked by Dawn 2026-06-08).
