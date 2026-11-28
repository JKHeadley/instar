# Side-Effects Review — The constitution check reads a spec whole, or says it did not check

**Version / slug:** `conformance-check-reads-whole`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent Opus reader for the Chief of Staff (records .instar/state/handoffs/reviews/conformance-check-reads-whole-review.md and -review-v2.md on the Studio): dissent on f47da6624 answered; concur at 4a326f592`

## Summary of the change

`POST /spec/conformance-check` stops cutting specs at 24,000 characters and stops reporting a run that could not judge as zero findings. Files: `src/core/reviewers/standards-conformance.ts` (whole spec always; `not-checked` fit verdict; provider failure labelled from the error with the prompt removed; both model calls on the locked-down reviewer path, so on Claude the spec goes over standard input), `src/server/specReviewRoutes.ts` (`checked`/`fitChecked`/`notChecked`; R32 only from a real check; the fit call gets what is left of the 180-second budget; a `specPath` file over 12 MB refused with 413), `src/core/specConstitutionCheckLedger.ts` (degrade reason, per-text run tally across machines, earlier texts, fit outcome, legacy records marked; B25 rule clauses), `src/commands/spec.ts` (NOT CHECKED and exit 2, including timeouts and an unrun fit), `skills/spec-converge/SKILL.md` plus `src/core/PostUpdateMigrator.ts` (a marked guidance block delivered to installed copies), `src/data/awareness/spec-approval-constitution-check.md`, tests. Spec: `docs/specs/conformance-check-reads-whole.md`.

## Decision-point inventory

- Conformance review prompt size — remove — the 24,000-character cut is gone.
- Degraded review / fit — modify — reported as not checked (`checked: false`, fit `not-checked`), never zero flags or `fit`.
- R32 ceremony evidence — modify — recorded only for a run that checked.
- B25 approval-ask rule — modify — also holds a clean claim from a not-checked or legacy record, a fit claim from an unrun fit, and one run picked from a spread.
- `specPath` size — add — over 12 MB refused (413, `checked: false`).
- CLI exit code — modify — 2 for not checked.

---

## 1. Over-block

The check itself blocks nothing (signal only). B25 can now hold an approval ask that reports one clean run while other recorded runs of the same text differ, or that rests on a legacy record; a legitimate ask passes by reporting the spread or saying the check could not run. A spec file over 12 MB is refused; at about 3 million tokens no model could judge it.

---

## 2. Under-block

- Approvals and R32 still bind to the spec's slug, not its exact text (CMT-060).
- A provider error that echoes an escaped prompt could still be labelled too-long instead of error; both mean not checked.
- Gemini's shared adapter still passes the prompt as an argument; it is not on this check's route today, and an oversized prompt there fails loudly.

---

## 3. Level-of-abstraction fit

The cut and the false pass are removed where they happened (the reviewer and the route); each consumer (CLI, skill, awareness note, B25 ledger) reads the same explicit `checked` signal instead of inferring from an empty list.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The check stays advisory. B25 is the existing LLM outbound reviewer judging by meaning; this change only gives it truthful records.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals point. The new B25 clauses are judged by the existing reviewer by meaning; the time split and size ceiling are floors stated in the spec's decision table.

---

## 5. Interactions

- **Shadowing:** none; the fit call runs after the review within one budget.
- **Double-fire:** none.
- **Races:** the ledger record step is synchronous in one process.
- **Feedback loops:** none.
- The spec-converge skill block is inserted by a `PostUpdateMigrator` step, once, never over a customized, learned or linked copy.

---

## 6. External surfaces

- Route response gains `checked`, `fitChecked`, `notChecked`; existing fields unchanged.
- CLI exit code 2 for not checked (1 stays a failed request).
- The B25 records section of the outbound review is bounded to 24,000 characters.
- On Claude the model call uses the hardened reviewer path (no tools, stdin, same model pin).
- Operator surface: none added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard renderer, approval page or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read**: each machine records its own runs; the existing peer read (`SpecCheckPeerCache`, `mergeSpecCheckRecords`) adds same-text tallies across machines. A peer that does not answer is left out, as the rendering says. No notices, no URLs, no new status surfaces.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. Installed skill copies keep the guidance block, which is harmless (it keys on `report.degraded`, which older servers also send). Ledger records keep their extra fields, ignored by older code.

---

## Conclusion

Three review rounds plus an independent reader shaped it: the time budget, the CLI and skill waits, the ledger tally and its cross-machine merge, the fit outcome, the stdin transport, and the reserved section budget. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent Opus reader for the Chief of Staff
**Independent read of the artifact: concur**

Dissented on f47da6624 (model calls not on standard input); concurred at 4a326f592 after the stdin move and the real-provider payload test. The only change since is four documentation lines the reader asked for (Gemini wording).

---

## Evidence pointers

Whole-file runs on the exact tree 4b0e76b9 on main 1d2c1ea8 through the M5 heavy-job wrapper (2026-11-27 18:24 PT): tsc clean; unit 85/85 and 67/67; integration 15/15; e2e 11/11. `node scripts/standards-coverage.mjs --check` passed on that tree. Convergence report: `docs/specs/reports/conformance-check-reads-whole-convergence.md`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unknown-classification-fail-open` — the reviewer (an agent-authored prompt pipeline) treated a run it could not judge as the safest result: an empty findings list and a `fit` verdict, which every caller read as a clean pass.
- **`closure`:** `guard`.
- **`guardEvidence`:** `{enforcementType: ratchet, citation: tests/unit/standards-conformance-gate.test.ts ("A spec is judged whole, never cut" and the not-checked fit tests), tests/unit/spec-conformance-cli.test.ts, tests/integration/standards-conformance-gate.test.ts, howCaught: every degraded review must carry checked false, a plain reason, zero judged characters and a not-checked fit verdict, and the CLI must exit 2, so a run that could not judge can no longer come back looking like a pass; the same tests require a 200,000-character spec to reach the model whole, so a reintroduced cut also fails}`.
