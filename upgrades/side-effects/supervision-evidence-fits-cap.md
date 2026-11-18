# Side-Effects Review — job supervision evidence fits its cap instead of holding the job

**Version / slug:** `supervision-evidence-fits-cap`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`projectSupervisionEvidence` (src/scheduler/JobSupervisionEvidence.ts) builds the bounded evidence text a script job's result supervisor reads. It used to assemble every anomaly line plus a 1000-character output tail and return `evidence-over-cap` when the total passed 2000 characters. `JobScheduler` treats `evidence-over-cap` as a supervision contract violation and holds the slug, which drops the job back to its agentmd session route. The live health-check reports one anomaly per server degradation, so on a busy server (12 anomalies, 5 fields, full tail ≈ 2,200 chars) every run tripped the hold; health-check has been held since 2026-11-13 and runs as a Haiku session every cycle (CMT-1610). The change assembles the evidence to fit: head, fields and independent signal are always kept; anomaly lines are kept while they fit, with an explicit `anomalies-omitted: N of M` line for the rest; the free-text tail takes the remaining room (still at most 1000). Omitted anomalies make `sufficientForRoutine` false. `evidence-over-cap` remains only for the case where the required lines alone cannot fit.

## Decision-point inventory

- `projectSupervisionEvidence` → `evidence-over-cap` refusal — modify — now only when head + fields + signal alone exceed the cap.
- `sufficientForRoutine` — modify — additionally false when any anomaly line was omitted.
- `JobScheduler` contract-violation hold on `evidence-over-cap` — pass-through (unchanged; fires far less often).

---

## 1. Over-block

Reduced: a healthy job reporting many conditions is no longer refused and held. No new refusal is added.

## 2. Under-block

A script that floods anomalies no longer trips a hold by volume alone. That is acceptable: anomaly count is bounded by the parser's own caps (`overCap`, `ignoredAnomalies` → `output-truncated` / `parser-integrity` still refuse), and omitted anomalies force supervisor judgment (not routine closure). The supervisor sees the explicit omitted count.

## 3. Level-of-abstraction fit

Right layer: the projection owns the evidence budget, so it should spend it. The hold in `JobScheduler` is an authority over contract violations; volume was never a contract violation of the script, only of this projection's own sizing.

## 4. Signal vs authority compliance

The change narrows a brittle size check that held blocking authority (hold the job) to the case it was meant for, and keeps the smart reviewer (result supervisor) as the judge whenever information was cut. Complies.

## 4b. Judgment-point check

No new static heuristic at a competing-signals point; the cut is deterministic packing, and any cut routes to judgment.

## 5. Interactions

`JobSupervisionReplacementPrompt` checks its own copy of the cap; the projected text is now always ≤ cap, so no new throw. Evidence hash changes for over-long runs (it is a content hash; no stored hash is compared across versions). Existing holds are not released by this change; release stays an explicit, recorded `POST /jobs/:slug/supervision-hold/release`.

## 6. External surfaces

The evidence text sent to the supervisor model may now contain an `anomalies-omitted:` line and a shorter output tail. No route, config or message changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine projects evidence for its own script runs, same as before.

## 8. Rollback cost

Revert the commit and release. Holds created under the new code behave identically to before.

## Conclusion

Narrow fix to a sizing bug that put the health check on a permanent supervision hold; reversible by revert.

## Evidence pointers

- tests/unit/job-supervision-evidence.test.ts: two new cases fail on the old code (over-cap refusal) and pass now; 7/7 pass.
- Adjacent: JobScheduler-script-job, ScriptJobSupervisor, job-supervision-replacement-prompt, job-supervision-benchmark-corpus — 19/19 pass.
- Live: GET /jobs/health-check/supervision-hold → hold reason `evidence-over-cap` since 2026-11-13T17:05Z; a manual run of health-check.mjs produced 12 anomalies + 5 fields + 3,104 bytes of output.
