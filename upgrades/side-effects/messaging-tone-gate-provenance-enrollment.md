# Side-Effects Review — MessagingToneGate Provenance Enrollment

**Version / slug:** `messaging-tone-gate-provenance-enrollment`
**Date:** `2026-07-12`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (verified all 6 axes; see Second-pass review section)`

## Summary of the change

Enrolls the **MessagingToneGate outbound gate** as a WIRED provenance decision point, executing the pending→wired expansion path that PR #1458's LLM-Decision Quality Meter (`docs/specs/llm-decision-quality-meter.md`, §5.6) already defined and tracked. The census (`src/data/provenanceCoverage.ts`) already carried `messaging-tone-gate` as `status: 'pending:ACT-1193'`; this flips it to `wired` with the mandatory volume valve, and adds the `provenance: {...}` enrollment to the tone gate's single verdict-producing LLM call — mirroring the exact `options.provenance` pattern #1458 established for CompletionEvaluator/ExternalHog. The tone gate is the highest-volume decision point in the fleet (3,641 of 4,098 LLM calls/24h on the dev agent per §5.6), so it enrolls at `budget:500/day` (a hard count ceiling with a loud `droppedByBudget` counter — never `full`), and its content is stored as **identity only** (a sha256 of the candidate + byte/char bounds + code-derived features: channel, messageKind, recent-message count, gate-signal kinds) — **never the message body and never any plaintext slice of it**. Enrolling a 4th wired customer structurally required activating the §5.5 per-point round-robin grading sub-budget (`decisionGradingPass.ts`, `SUBBUDGET_IMPLEMENTED` false→true), so grading capacity is shared fairly across points instead of one point starving the others. Files: `provenanceCoverage.ts`, `MessagingToneGate.ts`, `decisionGradingPass.ts`, + ratchet floor test + 2 new tests. Recording is dev-gated behind the same `provenance.uniformSeam` flag #1458 uses (ENABLED on dev, DARK on fleet).

## Decision-point inventory

- `MessagingToneGate` outbound-gate (`messaging-tone-gate`) — **pending→wired (observe)** — records the identity + verdict of the existing tone-gate authority. The gate's block/allow decision is untouched; the seam consumes the provenance block before any adapter and it never reaches the model.
- `decisionGradingPass` (per-point sub-budget) — **modify (mechanism)** — a 4th wired point activates the §5.5 round-robin sub-budget; no decision authority added, it only allocates grading capacity fairly across points.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** Observability-only. The `provenance` block is passed into the tone gate's LLM call options and consumed by the router-settlement seam *before any adapter*; it never reaches the model, never gates, holds, delays, or filters a message. The tone gate's PASS/BLOCK verdict is byte-identical whether the provenance write succeeds, fails, or is disabled (fail-open, inherited from #1458's recorder; asserted by test).

## 2. Under-block

**No block/allow surface — under-block not applicable.** This records what the tone-gate authority already decided. The remaining ~49 pending census points stay tracked under `pending:ACT-1193` and the monotonic ratchet still forbids silent regression — this change *shrinks* the pending set by one (tone gate) and *grows* the wired set to 4.

---

## 3. Level-of-abstraction fit

Correct layer, and deliberately NOT a parallel mechanism. The enrollment sits at the tone gate's own verdict call (the only place the structured verdict exists), reusing #1458's census + recorder + envelope + ratchet rather than rebuilding any of it. The census entry was already authored as `pending:ACT-1193` for exactly this expansion; flipping it is the intended, ratchet-enforced growth path. (This increment is the corrective successor to a duplicate parallel build — PR #1460, closed — which is why it is scrupulously on #1458's seam.)

## 4. Signal vs authority compliance

**Fully compliant — pure signal-side, zero authority added.** Per `docs/signal-vs-authority.md`: this records the existing tone-gate authority's verdict; it adds no detector-with-authority and no new authority. The one forbidden direction — a graded outcome feeding back into a decision input — is not crossed: grading only reads recorded rows and writes verdicts to the quality store; nothing here wires a feedback edge into model/door/prompt/floor selection (that remains the future benchmark increment's own spec).

## 5. Interactions

- **Volume:** the tone gate fires on every drafted outbound message. The `budget:500/day` valve is the load control — a hard per-UTC-day count ceiling on the provenance JSONL archive with a loud `droppedByBudget` counter, deterministic rather than probabilistic. This is why `full` is forbidden for this point.
- **Grading fairness:** activating the §5.5 sub-budget (required by the 4th point) means the periodic grading pass round-robins capacity across all wired points; without it a high-volume point could monopolise the grading budget. Covered by 3 new sub-budget tests.
- **No shadow/double-fire:** one enrollment per verdict at the single `review()` call site; the deterministic availability-fallback paths are not the LLM decision and are not enrolled.
- **`/metrics/features` agreement:** model/door/tokens come from the existing usage/attribution path, so the provenance row and cost row agree by construction.

## 6. External surfaces

- **`GET /judgment-provenance` / the decision-quality read surface** now also returns tone-gate rows (redacted, identity-only, Bearer-gated) — reusing #1458's existing envelope + `no-store` route. No new route.
- **Privacy — the load-bearing property:** content is stored as `sha256(candidate)` + bounds + code-derived features, **never the body and never a plaintext head**. This deviates from the initial "hash + bounded head" instruction: an integration test (written first) caught the literal outbound body landing on the served row because the credential-scrub does NOT strip non-credential PII/prose. The head was dropped entirely, matching the CompletionEvaluator content-bearing sibling's hash-only discipline — the stricter, correct reading for the very text this gate inspects for leaks.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local write, proxied-on-read** — identical to #1458's provenance posture (inherited, not re-declared). Full rows are credential-scrubbed + machine-local (0700/0600, never-served-raw, short retention) and never replicated; the unified read is the existing redacted `?scope=pool` merge that #1458 built. Identity-only content further reduces the at-rest surface for this point. The ratchet + census are CI-level (machine-independent). No new machine-local surface is introduced.

## 8. Rollback cost

**Cheap and reversible.** Recording is dev-gated behind `provenance.uniformSeam` (dark on fleet); flipping it off leaves the tone gate behaving exactly as before with zero rows. Full back-out is a plain revert: the census entry returns to `pending:ACT-1193`, the enrollment is removed, and `SUBBUDGET_IMPLEMENTED` reverts (the sub-budget is inert with <2 wired high-volume points anyway). No migration, no persisted state beyond the short-retention JSONL, no fleet coordination. Because recording never touched the tone verdict, a revert cannot regress any outbound-messaging behavior.

## Second-pass review (independent)

**Concur with the review.** Verified against the real diff + code (not the artifact) on all six axes:

- **A / critical-path (holds):** In `review()` the `provenance` block is added to `opts` (`MessagingToneGate.ts:737-742`) and passed to `provider.evaluate(prompt, opts)` — but `IntelligenceRouter.mintDecision` clones the options and `delete internal.provenance` BEFORE any attempt (`IntelligenceRouter.ts:1138-1139`), so it never reaches the model. Settlement runs on the router's own path after the verdict (`:1110-1116`), and the single write is try/catch-contained — "the decision call is never failed or delayed by its audit trail" (`recordSettlement` :1288-1290); an errored exit re-throws the ORIGINAL error unchanged (`:1113-1116`), which the gate's own fail-closed/tier logic handles. `buildToneDecisionContext` is built synchronously outside the try block, but it is throw-proof: `crypto` (node:crypto, imported :21), `Buffer.byteLength`, `String().slice`, and `detectGateSignals` (itself fully try/catch-guarded, returns `[]` on any input — `GateSignalDetectors.ts:238-258`). A recorder failure/slow-write/throw cannot alter or hold the verdict — fail-open is real, not asserted.
- **B / body-leak (holds — load-bearing property intact):** `buildToneDecisionContext` (`MessagingToneGate.ts:128-160`) stores `candidate: {sha256, bytes, chars}` + `channel` (a 32-char slice of the CHANNEL name, not the body) + `messageKind` + `recentMessageCount` (a count) + `gateSignalKinds` (kind labels). Grepped the whole diff: the only `.slice` is on `context.channel`; no plaintext head/body field exists anywhere. The integration test drives a REAL gate→router→recorder→JPL→`GET /judgment-provenance` and asserts the distinctive body marker is absent from the served JSON AND `ctxParsed.candidate.head` is `undefined` (`messaging-tone-gate-provenance.test.ts:150-165`); the unit suite additionally proves a 1MB message yields a <512-byte envelope and an in-body secret never crosses. The router's `rawResponseHead` (`:1227-1230`) captures the MODEL's verdict JSON, never the candidate body.
- **C / volume valve (enforced, not cosmetic):** census is `budget:500` (`provenanceCoverage.ts:200`), and the recorder genuinely enforces it — `resolveJsonlDisposition` parses `budget:<N>`, counts today's rows, returns `'budget-dropped'` past the ceiling and bumps the `droppedByBudget` counter (`DecisionQualityRecorderImpl.ts:300-302, 338-346`) while still writing the ~250-byte SQLite row. The ratchet fails a `full` valve for this point (`not.toBe('full')` + `toMatch(/^budget:[1-9]\d*$/)`).
- **D / §5.5 sub-budget (no feedback edge):** `GRADE_PASS_POINTS = [DP_EXTERNAL_HOG_KILL_LEAVE]` (one point) → `perPointSubBudget(N,1)===N`, byte-identical to the prior single-point walk; the hog grading body was extracted verbatim into `gradeOnePoint`. The tone gate is explicitly NOT graded by this pass. The pass reads recorded rows + hog-store records and writes grades only — it touches no model/door/prompt/floor selection. Covered by 3 new sub-budget tests + the unchanged hog correctness tests.
- **E / ratchet monotonicity:** the `messaging-tone-gate::…::ACT-1193` line was removed from `PENDING_BASELINE`, so a regression to pending fails the shrink-only pending pin (a new unbaselined line) AND the dedicated `status==='wired'` assertion — two independent failures. No other census entry changed (4 wired = 3 first-customer + tone; 6 exempt unchanged).
- **F / dark-gate:** recording gates on the same `provenance.uniformSeam` flag #1458 uses (`DecisionQualityRecorderImpl.ts:195`, early-return `:212`) and the router no-ops when `getDecisionQualityRecorder()` is null. Gate-off = the inert `provenance` options block is never consumed; zero rows, zero behavior change.

Ran the three unit suites (47 passing, incl. the typed-import wired-verification) + the integration test (2 passing, body-marker-absent) + `tsc --noEmit` (clean). One cosmetic note (non-blocking): the summary line calls tone-gate the "4th wired customer" whereas the census/tests correctly call it the "third enrolled CUSTOMER" (customers key on `baseOf(component)`, so CompletionEvaluator + /P13 collapse to one) — the code and ratchet are internally consistent; only the artifact's prose is loose. No parallel mechanism; it rides #1458's seam exactly.
