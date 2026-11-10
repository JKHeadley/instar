# Side-Effects Review — Context Budget Phase 0 verification results (report + read-only measurement scripts)

**Version / slug:** `cb-phase0-results`
**Date:** `2026-11-10`
**Author:** `Echo (builder session)`
**Second-pass reviewer:** `not required`

## Summary of the change

Records the Phase 0 check results for `docs/specs/context-budget-layered-summaries.md` (§16 item 1, Maturation plan `test-agent-live`) in `docs/specs/reports/context-budget-phase0-results.md`, and adds five measurement scripts under `scripts/context-budget/` so the numbers can be re-taken on every machine: `scan-compaction-paths.mjs`, `topic-intent-inventory.mjs`, `sender-asymmetry.mjs`, `token-baseline.mjs` (all read-only) and `hook-delivery-capacity.mjs` (starts one headless `claude -p` session per size in a throwaway project under `$TMPDIR`). Nothing under `src/`, no hooks, no config, no migrations. Not imported by the build, not run by CI, not shipped in `dist`.

## Decision-point inventory

No decision-point surface. The report and scripts observe; nothing reads their output to decide anything.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Operator-run measurement scripts beside the spec's report, the same layer as the existing `scripts/` diagnostics. They reuse the canary's recovery-marker test and the resume-payload preamble rather than defining new ones. They do not duplicate a runtime component: the TokenLedger would be the natural source for the baseline, but it does not see follow-me config homes (recorded in the report as a gap), so the script reads transcripts directly.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Measurement output only; no runtime authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The scripts' classifications (what counts as a recovery block, an injected entry, a turn) are measurement definitions stated in each script header, not runtime decisions.

---

## 5. Interactions

- **Shadowing / double-fire:** none; nothing runs automatically.
- **Races:** the read-only scripts stream live transcripts and topic-intent files that sessions may be appending to; a scan sees a consistent prefix, which is what a snapshot measurement needs.
- **Feedback loops:** `topic-intent-inventory.mjs` deliberately avoids `GET /topic-intent/:id/briefing`, because that route bumps the `briefing_served` capture counters; it uses the read-only `diagnostics` and messages routes. (One manual briefing call during this work bumped topic 141133's counter by one; disclosed in the report.)
- **Load:** the transcript scans read ~2 GB on this machine in about 90 s under `nice`; run them one at a time.

---

## 6. External surfaces

- Other agents / install base: none.
- External systems: `hook-delivery-capacity.mjs` makes real model calls under whatever Claude login its environment inherits (3 small haiku sessions in this run). No Telegram, Slack or GitHub calls.
- Persistent state: none written by the read-only scripts. The capacity probe writes a throwaway project under `$TMPDIR` (removed by the operator afterwards) and Claude Code writes its own transcripts for those sessions.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** each script measures the machine it runs on (transcripts are per machine; the routes it calls have no pool scope), and every output carries the hostname. The report labels every number with its machine and states that peers were not measured. No notices, no durable state, no URLs. No status surfaces added or changed.

---

## 8. Rollback cost

Docs and scripts only — revert the commit. No persistent state, no agent repair, nothing user-visible.

---

## Conclusion

Clear to commit. The report surfaces one finding that affects later slices: Claude Code 2.1.322 replaces hook output over 10,000 characters with a file pointer and a 2 KB preview, so the live recovery block (~45 KB) reaches the model only partly and the canary's stdout-based detection would read it as delivered; and the TokenLedger misses sessions under follow-me config homes. Both are recorded in the report for the owning slices; this change does not fix either.

---

## Evidence pointers

`docs/specs/reports/context-budget-phase0-results.md` (sections 1–12, with the run times and machine for each number).
