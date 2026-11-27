# Side-Effects Review — stop-check replay input (CMT-2204)

**Version / slug:** `stop-gate-replay-input`
**Date:** `2026-11-26`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (declared; dev-gated observability, a revert or the switch fully undoes it). Behind the new dev-gated `monitoring.stopGateReplayInput`, the UnjustifiedStopGate's provenance row keeps a credential-scrubbed copy of the stop reason, recent turns and trusted evidence it judged under the machine-local `_contentFull`, plus content-free replay identity (`promptSha256`, `replayPromptSha256`, `scrubChanged`, `scrubVersion`, `captureVersion`). The prompt assembly moved into the pure `buildStopGatePrompt` (byte-identical output) so a stored copy can rebuild it. Files: `src/core/UnjustifiedStopGate.ts`, `src/commands/server.ts`, `src/core/types.ts`, `src/core/devGatedFeatures.ts`, `src/data/feature-ladders.json`, `src/data/awareness/stop-check-replay-input.md`, plus three test tiers. Size: about 10 files, ~420 added lines (most of it tests and docs). Effort: no spec-converge rounds (Tier 1, mirrors the approved CMT-1679 pattern); one commit attempt planned.

## Decision-point inventory

- `unjustified-stop-gate` (UnjustifiedStopGate continue/allow/escalate) — pass-through — the verdict path is untouched; only the observability block handed to `intelligence.evaluate` as `options.provenance.context` gains fields when the switch is on.

---

## 1. Over-block

No block/allow surface added or changed — over-block not applicable. The unit test `the switch never changes the prompt or the verdict` compares the sent prompt and the parsed result with the switch on and off.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Replay-coverage gaps, stated plainly: (a) the scrub is credential-shape only (`scrubSecrets`), so a row whose text contained a key is replayable but not byte-exact (`scrubChanged: true`); (b) a stop reason big enough to push the row past the 64 KB clamp leaves the row ineligible (on the Stop-hook path turns are bounded at 3 × 2,000 chars by `stopGateTranscriptTail`; the reason, and any other caller's input, is bounded only by the clamp). When the clamp fires, `contextFull` keeps only a truncated head, so that row loses its capture and its content-free replay fields there; `contextRedacted` was built before the clamp and keeps the identity fields; (c) the census `budget:300` valve still drops most rows per day, so the replay set is a sample, not every call.

---

## 3. Level-of-abstraction fit

Correct layer. The capture is built where the prompt is built (the only place that knows the guard-filtered untrusted content the model actually saw), and it rides the existing provenance enrollment and `_contentFull` machine-local field rather than adding a parallel log. Same shape as CMT-1679 for completion-claim-verify.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It adds recorded data only. It does not change who decides, what is decided, or when.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The only new logic is an eligibility check on stored rows (sha equality), which is an invariant, not a judgment.

---

## 5. Interactions

- **Shadowing:** none. The gate's verdict, breaker and fail-open paths are unchanged; the capture is computed inside `buildStopDecisionContext`, wrapped in try/catch that returns `captureVersion: 'capture-failed'` and never throws into the call.
- **Double-fire:** none; one row per call, as before.
- **Races:** none; pure functions over the call's own input.
- **Feedback loops:** none. The stored rows are read only by offline replay analysis.
- **Prior design note:** `enrol-unjustified-stop-gate` (#1632) chose to record no text. This deliberately extends it on development agents only, exactly as CMT-1679 did for the claim check, using the machine-local field built for this purpose; the fleet keeps the #1632 posture. Its existing test (`unjustified-stop-gate-provenance-enrollment.test.ts`) still passes because the default is off.
- **Cost:** one extra JSON serialization and two sha256 digests of a ~10 KB string per call; negligible against a model call.

---

## 6. External surfaces

- Other agents / install base: none; dark on the fleet.
- External systems: none; nothing new leaves the machine. `GET /judgment-provenance` serves redacted rows only (integration test asserts the text and `_contentFull` are absent).
- Persistent state: dev-agent provenance rows grow by up to ~10 KB each (≤300 rows/day under the census budget, ≈3 MB/day worst case), in the existing 0700/0600 store with 14-day retention.
- Privacy: the stored copy contains conversation prose (stop reason and up to 3 recent turns, including user turns when the self-deferral guard is on). Credential shapes are scrubbed; ordinary prose and paths are not, by design, so the replay stays faithful. The trusted evidence (artifact paths, commit SHAs, detector booleans, session start time) is stored unscrubbed; it carries no conversation text. None of it leaves the machine.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the captured text is sensitive conversation content, and `_contentFull` is excluded from the cross-machine allowlist precisely so it never travels. Rows are written on whichever machine runs the stop check. No user-facing notices, no URLs, no new status surfaces; the content-free replay identity is visible pool-wide through the existing `GET /judgment-provenance?scope=pool` redacted merge.

---

## 8. Rollback cost

Set `monitoring.stopGateReplayInput.enabled: false` (takes effect on restart) or revert and ship a patch. Already-written captures age out with the 14-day retention; no migration and no user-visible regression.

---

## Conclusion

Clear to ship as an observability-only, dev-gated change. The review surfaced one honest limit, written into the row itself: replay is byte-exact only when the scrub changed nothing (`scrubChanged`), and the eligibility helper reports `exact` separately from `eligible` so a replay analysis can choose to use only exact rows.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Claude, read-only), 2026-11-26
**Independent read of the artifact: concur**

Concur with the review. It confirmed the prompt is byte-identical for guard on/off and with or without user turns, that every new step is inside the capture's try/catch, that `_contentFull` stays top-level through the recorder and is stripped before the served and pool-merged field, that the provider never receives the provenance block, and that the eligibility helper rebuilds with the recorded guard setting. Notes folded into this artifact: the turn bound holds on the hook path only; the trusted evidence is stored unscrubbed; a clamped row loses its capture in `contextFull`. Its one weaker-evidence note: the lifecycle test proves the server construction site by matching the source line that calls the shared resolver, rather than booting the full server; the resolver itself is exercised for real.

---

## Evidence pointers

- `tests/unit/stop-gate-replay-input-capture.test.ts` (7 tests), `tests/integration/stop-gate-replay-input-provenance.test.ts` (1), `tests/e2e/stop-gate-replay-input-lifecycle.test.ts` (4), all passing; neighbour suites (UnjustifiedStopGate*, provenance enrollment, routes-stopGate, stopGate, awareness registry, dev-gated wiring, dark-gate lint, feature ladders) 514/514 passing.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added.
