# Side-Effects Review — exact replay input for completion-claim-verify (CMT-1679)

**Version / slug:** `claim-replay-input`
**Date:** `2026-11-14`
**Author:** `Echo (builder for CMT-1679)`
**Second-pass reviewer:** `not required (no gate, sentinel, guard, watchdog, lifecycle or messaging decision is touched)`

## Summary of the change

Tier 1 (small, reversible, dev-gated, fleet byte-identical). Brief: `.instar/jev-reassessment-20261114/cmt-1679-capture-brief.md`. `ClaimClauseArbiter.arbitrate` now builds the prompt string once and sends that same string. Behind the new option `recordReplayInput` (resolved in `AgentServer` from `monitoring.completionClaimVerification.recordReplayInput` via `resolveDevAgentGate`), the provenance context gains content-free replay identity (`promptSha256` as a structured sha, `includeGeneral`, `scrubVersion`, `captureVersion: claim-replay-input-v1`, `incumbentLabelsRecorded: false`) and `[CONTENT_FULL_KEY]: { message, evidence }` with the already-scrubbed message and already-bounded evidence. New pure helpers `buildClaimReplayIdentity`, `rebuildClaimArbiterPromptFromCapture`, `assessClaimReplayEligibility`. `CompletionClaimVerifier` passes the option through. Flag registered in `devGatedFeatures.ts`, a composed ladder entry in `feature-ladders.json`, a `types.ts` field, and one CLAUDE.md awareness bullet in `templates.ts` mirrored by `PostUpdateMigrator` (Migration Parity). Size: 7 source files (~120 LOC added), 3 new test files, 1 test list line. Effort: one design pass, no spec rounds.

## Decision-point inventory

- `completion-claim-verify` arbitration — pass-through — prompt text, model, timeout, parse and `routeActionClaim` input are unchanged; only what the provenance row records changes, and only when the flag is on.
- `assessClaimReplayEligibility` — add — an offline, pure eligibility label for later replay; nothing in the runtime calls it, it gates nothing.

---

## 1. Over-block

No block/allow surface. The eligibility helper may mark a genuinely replayable row "not eligible" only if the row was clamped or its stored inputs differ from what was hashed; both are correct refusals.

---

## 2. Under-block

No block/allow surface. As an instrument: turns that never reach the arbiter (prefilter skip, privacy-boundary deny, evidence unavailable) produce no row, by design. The incumbent's per-clause labels are not on the decision row (parsed after the call); the row says so with `incumbentLabelsRecorded: false` rather than leaving a grader to assume.

---

## 3. Level-of-abstraction fit

Uses the existing provenance seam and the existing machine-local `_contentFull` key (the MessagingToneGate pattern); no new store, route or retention. The capture is attached after `buildTranscriptSliceIdentityContext`, so the bounded builder's 300-char string clamp cannot cut it; the row's own 64 KB clamp still applies and is detected.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority. Observability only. The verifier was observe-only before and remains so.

---

## 5. Interactions

- Prompt construction: built once, previously inline; same arguments, same string.
- Provenance row: on dev agents the served `contextRedacted` gains five short label/digest fields (within its 2,000-char clamp; the grouped sha survives the credential scrubber by design). `contextFull` grows by the scrubbed message (≤16 KB) plus evidence; a row over 64 KB is truncated by the existing clamp and the helper reports `row-truncated`.
- Fleet: option resolves false, the context object is built exactly as before (unit test compares byte-for-byte).

---

## 6. External surfaces

None new. `GET /judgment-provenance` serves only `contextRedacted`, from which `_contentFull` is stripped before projection (integration test asserts the message and the key never appear). No outbound calls.

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the captured content lives only in `contextFull`, which `readRedacted` omits and the cross-machine allowlist excludes. Each machine records the checks it ran. The flag is per-machine config resolved at boot.

---

## 8. Rollback cost

Set `monitoring.completionClaimVerification.recordReplayInput: false` and restart, or revert the commit. No migration; captured rows age out under the existing 14-day retention.

---

## Conclusion

Safe to ship: the arbiter's behaviour is unchanged (same prompt string, tested), the fleet row is byte-identical (tested), the content never reaches a served surface (tested over HTTP), and parity is proven on the real boot path (e2e).

## Evidence pointers

- `tests/unit/claim-replay-input-capture.test.ts`
- `tests/integration/claim-replay-input-provenance.test.ts`
- `tests/e2e/claim-replay-input-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable: this adds a capture for later replay, it does not fix a defect.
