# Side-Effects Review — scheduled-result outage backup audit

**Version / slug:** `job-supervision-replacement-audit`  
**Date:** 2026-10-30  
**Author:** Echo  
**Review tier:** Tier 2, independent second pass concurred

## Summary

The opt-in benchmark uses exact JSON parsing, a schema request for Haiku, a concrete Haiku pin, a Codex strict-model option, and provider-reported Haiku model identity. The report distinguishes parsed labels from proven valid-format answers. No production rollout gate opens and no new scheduled job runs.

## Decision-point inventory

1. **Candidate answer validity:** every replacement caller must explicitly report format validity; a missing, malformed, or over-cap answer fails the model call and leaves the result unchecked. Usage reported before failure is retained, and usage reported after a timeout updates only that failed call's audit row while the store remains open. A valid `cannot-tell` answer remains unresolved.
   The optional usage callback remains nonfatal if it throws; the code marks that narrow fallback explicitly, and the silent-fallback ratchet test checks the boundary.
2. **Model identity:** Haiku must report one served model matching the pinned concrete version. A mismatch leaves the result unchecked while retaining the reported model and token usage in the failed call row. Codex uses the CLI model pin and has no independent served-model attestation; that remains an explicit qualification limit.
3. **Call budget:** the alias and concrete Haiku pin debit the same UTC-day input-token cap. Invalid case IDs and duplicate IDs are rejected before a call.

## 1. Over-block

A valid Haiku reply without a `modelUsage` entry, or with multiple served-model entries, cannot settle. This is conservative for an audited decision; the benchmark records the failure for diagnosis. The schema-constrained response parser also refuses `is_error: true` and responses without the CLI's `structured_output` envelope, even if a plain `result` string looks valid.

## 2. Under-block

Codex CLI's resolved pin is not independently attested by the model service. Internal transport retries may remain opaque to a CLI caller. Consequently this evidence does not qualify Luna for production. A future production selector must keep the backup gate closed until the audit contract and full benchmark floor are satisfied.

## 3. Level-of-abstraction fit

CLI argument and response handling belong in the intelligence providers. The strict JSON verdict check belongs in the replacement prompt module. The benchmark selects corpus cases and writes result summaries; the production worker owns the durable pre-call and settlement journal.

## 4. Signal vs authority

A formatted model answer is still only a verdict. The independent evidence-sufficiency floor in `JobSupervisionStore` remains authoritative for routine closure. A malformed answer gains no authority.

## 4b. Judgment within floors

The benchmark and worker still refuse unqualified replacement choices. No prompt wording can override the code-owned evidence, budget, or rollout floors.

## 5. Interactions

The new options are opt-in. Existing Claude and Codex calls retain their prior arguments and fallback behavior. The shared `IntelligenceOptions` type gains optional fields. The circuit-breaking wrapper forwards the served-model callback through its existing options spread.

## 6. External surfaces

Benchmark calls reach configured Claude or Codex providers only when the explicit live-benchmark environment gate is set. The script writes private local audit state. The production job-result route remains dark.

## 6b. Operator-surface quality

The ELI16 and evidence report state the partial result and why it cannot be called qualified. No new user-facing runtime copy changes.

## 7. Multi-machine posture

The benchmark journal is local to the agent. Each run has a unique ID; no shared certificate or fleet gate changes. The daily cap scans prior summaries for both Haiku names on this machine.

## 8. Rollback cost

Reverting the code restores previous benchmark behavior without migrating data. Existing audit summaries remain readable. A rollback must not reinterpret malformed historical answers as proven accurate.

## Conclusion

The safe state is unchanged: Jev decisions and outage replacement are off. The October 30 5 PM PDT Haiku retry failed all ten calls and left every result unchecked; the CLI exit cause needs diagnosis before another capped trial. The remaining 35-case coverage, served-model assurance for Codex, live outage trial, and development shadow are release gates.

## Evidence pointers

- `docs/specs/job-result-supervision-v2-benchmark-evidence.md`
- Focused provider, prompt, and worker unit tests; authenticated route integration test; joined test-agent lifecycle test pending shared suite slot.
- Local SQLite pre-call and settlement journals under `.instar/state/benchmarks/job-result-supervision-replacement-v1/`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is closed by this benchmark change. Candidate qualification remains open.

## Second-pass review

The independent reviewer initially found that provider errors could lose usage already reported before the error. After the observation callback and a test for that case, the reviewer found a second race: usage arriving after a timeout could miss the failed audit row. The worker now records late usage only on the same failed call epoch, without changing its verdict or status, and a store test covers that boundary.

**Second-pass reviewer:** Concur with the review. The late update is limited to the same failed call and cannot change its verdict or status.

**Follow-up second pass:** Concur with the review. The explicit fallback annotations cover only optional usage observation and a store already closed after timeout; the fail-closed verdict behavior remains intact.
