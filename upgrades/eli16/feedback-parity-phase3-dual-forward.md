# ELI16 — Feedback parity Phase-3 dual-forward (emitter + client)

## The situation

Feedback about Instar agents currently lives in Dawn's Portal (a Python service backed by Postgres). We're migrating that whole feedback-processing pipeline over to Instar/Echo in reversible phases. Before Instar can be trusted to OWN the processing, it has to PROVE — against the Portal's live data — that it groups feedback into the same "clusters" the Portal does and reaches the same verdicts. "Phase-3 dual-forward" is the step where Echo computes a cluster verdict and forwards it to the Portal, which independently re-checks it before applying anything. This PR adds the two client-side building blocks for that forward.

## What the two pieces do

**The emitter** (`buildParitySubmitPayload`) takes Echo's cluster decisions — an array of `ClusterResult` (each says "this feedback item should merge into cluster X" or "create a new cluster") — and packs them into the exact request shape the Portal's `parity-submit` endpoint expects: `{ batchId, items: [{ feedbackId, action, clusterId, fingerprint, similarity, clusterTitle?, note? }] }`. The `fingerprint` is the cluster's identity hash, computed ONE way (the canonical `clusterFingerprint({type, title})` already used everywhere else in the processor) so there is a single source of truth; the Portal re-derives it only to confirm agreement, never to override. If a cluster id can't be resolved to a real cluster, or the batch id is empty, the emitter THROWS instead of quietly emitting a malformed batch.

**The client** (`submitParityBatch`) sends that payload to the Portal over HTTPS with a Bearer token, then reads the reply. The Portal answers with a per-item `status`: `matched` (fingerprints agreed, applied), `diverged` (mismatch — NOT applied, with a reason), `not_found`, or `error`. The client turns that into a tidy verdict keyed by `feedbackId`, and only reports `allMatched` when every single item matched.

## The one rule that matters most

If anything goes wrong on the wire — the server returns a non-200, the network drops, the body isn't valid JSON, or the reply's shape doesn't match the locked contract — the client THROWS a `ParitySubmitError`. It NEVER silently treats a broken or garbled submit as "matched / done." Silent success on a failed write is exactly how a data migration corrupts the canonical store, so we fail loudly and hand the decision (retry / escalate) back to the caller. This is the project's no-silent-degradation standard applied at the one network boundary.

## Why it's safe to ship now

Nothing is wired into a live pipeline yet — no production feedback traffic flows through these, and there are no database writes. They are the deterministic building blocks the later, operator-gated cutover step will call. They're covered by 21 unit tests (both sides of every decision boundary, including every fail-closed path) and were verified end-to-end against the Portal's live endpoint with an empty-batch round-trip (HTTP 200, locked shape parsed, correct verdict). The actual cutover to live dual-forward remains a separate, deliberate, operator-approved step.
