# Side-Effects Review — Sibling-Transport Brakes

**Version / slug:** `sibling-transport-brakes`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent, autonomous session per Justin's direction)`
**Second-pass reviewer:** `focused adversarial reviewer subagent — CONCUR on all four probes (the #874 pattern itself carries tonight's line-level CONCUR)`

## Summary of the change

The #874 brake pattern applied verbatim to the two remaining mesh transports: `HttpLiveTailTransport` and `ReplyMarkerTransport` get `AbortSignal.timeout` (30s default, the #874-corrected sizing above the fleet's 5–40s receiver-stall envelope) on their fetches, and `PeerFailureLogGate` state-change failure logging (live-tail N=360; reply-marker N=50 for reply cadence) replacing per-attempt lines, with non-ok responses now gated-logged. Files: both transports, one test file.

## Decision-point inventory

- Both transports' `broadcast()` — **modify (bounded)** — same requests, same return semantics; failures abort at the timeout instead of hanging; logging gated.

## 1. Over-block / 2. Under-block

(a) A 30s abort can drop a reply-marker a slower wait might have delivered — widening the marker's documented Two-Generals residual. Reviewer-traced: `broadcast()`'s return is void-discarded at its ONLY callsite (fire-and-forget by design); provider redelivery + the dedup gate + git-committed ledger state are the explicit backstops. Pre-accepted, not new risk. (b) Perfectly alternating ok/fail logs one transition pair per cycle — at reply cadence this is bounded and is diagnostic signal for a genuinely unstable peer (reviewer: not a blocker; an across-resets suppressor would mask real instability). (c) A local `encryptFor` throw logs under the peer's key — imprecise label, but the error detail (the real exception message) disambiguates and the operational meaning ("this peer's flush did not deliver") is identical. (d) Remaining audit item is the SessionRouter design <!-- tracked: CMT-1109 -->.

## 3. Level-of-abstraction fit / 4. Signal vs authority

Brakes in the transports that generate the cost; cadence stays with callers; reuses the canonical gate class rather than re-implementing. **Signal-only** per `docs/signal-vs-authority.md`: log shaping + failure-timing bounds. Critically verified: neither transport feeds lease renewal/suspend (`.isReachable()`'s only src consumer is `LeaseCoordinator` via the LEASE transport) — the #874 reviewer's false-self-suspend concern structurally cannot apply here.

## 5. Interactions

- **Exactly-once (the marker's job):** unchanged — the timeout affects only the best-effort fast path; the dedup gate and ledger sync carry correctness (reviewer probe 1).
- **#867's per-topic backoff:** composes — backoff bounds live-tail attempt RATE per topic; the gate bounds LOG volume per peer across topics.
- **Old format pins:** none — pre-existing transport suites pass untouched.
- **Node engines / AbortSignal-vs-test-clocks:** identical to #874 (verified there; same package.json).

## 6. External surfaces / 7. Rollback

Logs only; no API/schema/config/persistent state; no migration (in-code defaults). Rollback = revert; the hang exposure and per-attempt logging return.

## Conclusion

Completes the mesh-transport brake set: all four cross-machine wires (lease #874, heartbeat #881, live-tail and reply-marker here) now carry P19's brakes. Mechanical extension of a twice-validated pattern, with the one novel risk (marker-drop under timeout) traced to a documented, backstopped design acceptance.

---

## Phase 5 — Second-pass review (cross-machine exactly-once adjacency → performed)

A focused adversarial pass probed only what is novel beyond #874's reviewed pattern: (1) the Two-Generals widening from a 30s marker abort — traced `broadcast()`'s only callsite (void-discarded, fire-and-forget, comment-documented backstops): pre-accepted by design; (2) gate key granularity + alternating ok/fail behavior — peer-bounded memory, transition chatter acceptable-and-diagnostic at reply cadence; (3) local `encryptFor` throws misattributed to the peer — disambiguated by the error detail, operationally equivalent; (4) ran the new + pre-existing transport suites (15/15) and tsc (clean). **Verdict: CONCUR.**
