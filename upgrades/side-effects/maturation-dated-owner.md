# Side-Effects Review — Maturation Path clause (h): a dark rung has a dated owner

**Version / slug:** `maturation-dated-owner`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer session (claude-code subagent, read-only, no access to the author's reasoning)`

## Summary of the change

A constitution text change, with no code. *Maturation Path* gains clause (h). The **dated-owner** half says the next rung names an owner and a review-due date at ship time, and each later rung gets them when the rung below it is reached, on the feature's ladder entry. It is clause (c)'s registration content and *No Deferrals*' deferral lifecycle on the maturation axis, not a second mechanism. The **proven-awake** half says the carriers that re-surface a stalled rung must pass a positive control on the machine running the trial before the rung's clock starts. Both halves are named unenforced. The dated-owner half rides the existing (c)/(d) countdown, and the proven-awake half has its own (`STD-SUBCOUNTDOWN-maturation-h-awake`). Both are due 2026-12-21. The alignment map row 75 records (h) as 1.x-only. The Shipping family audit is re-recorded against the new text. Needs the operator's approving review (the direction guard on a ROOT article requires it).

## Decision-point inventory

- None at runtime. The text names a future build check (an owner or due date missing on the next rung) and a future positive-control record. Neither is built here.

---

## 1. Over-block

None now: nothing new refuses anything. When the countdown expires on 2026-12-21, `lint-documented-only-countdown` fails builds until the guards land or the operator re-dates them. That is the intended pressure.

## 2. Under-block

Until the guards exist, a feature can ship with no owner or date and no awake proof. The text says so, and the countdown bounds how long that stays true.

## 3. Level-of-abstraction fit

It belongs in the single governing article for graduation as a clause, not a new article. It reuses (c)'s registration, (d)'s home and *No Deferrals*' lifecycle rather than adding parallel ones. This was argued in the independent review. `lint-single-governing-obligation` is clean but does not measure it.

## 4. Signal vs authority compliance

Compliant. The owner and date are a record that re-surfaces a decision, and the positive control is a precondition on a clock. Neither flips a feature. The review's model still decides. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- *No Deferrals*: (h) applies its lifecycle and does not restate it.
- *Bug-Fix Evidence Bar*: the positive control is its live-state proof, applied to the carriers.
- *A Dark Feature Guards Nothing*: unchanged. It still owns critical paths that depend on a dark feature.
- instar-2 Rule 72 has a deadline but no owner and no awake proof. The PR's counterpart line says none, with the reason, and the map records the difference.

## 6. External surfaces

None at runtime. The published constitution text changes.

## 7. Multi-machine posture

Repo-tracked text, unified. The proven-awake half is machine-scoped on purpose ("the agent and machine that run a feature's trial"), because the 2026-11-06 incident was a marker false on two of five machines.

## 8. Rollback cost

Revert the text along with its Shipping audit record and the map row.

## Second-pass review

**Reviewer:** independent reviewer session (claude-code subagent, read-only), four passes: the first over the registry diff only; the second over the registry, the alignment map, the upgrade guide and the ELI16; the third and fourth over all eight changed files

First pass: did not concur, with twelve findings. The main ones were that (h) made a commitment the record (against clause (d)), that it duplicated *No Deferrals*' lifecycle, that it overlapped (c) with a second countdown, and that it misquoted the spec and over-attributed. All were resolved or noted with reasons in `docs/specs/reports/maturation-dated-owner-shipping-family-2026-11-14.md`. Second pass: the registry text was resolved. The upgrade guide and ELI16 still described the old record, and the audit file was missing. Both were fixed. Third pass (all eight files): did not concur on one point. The wording fix for finding 4 had made the clause say both that every unreached rung is dated at ship time and that later rungs are dated later. It also flagged an unrecorded verdict and passes described inaccurately in this artifact, and an overclaim about the lint in section 3. All were fixed, and the Shipping audit was re-recorded against the corrected text. Fourth pass (all eight files, after those fixes): VERDICT: concur

## Evidence

- Telegram record, topic 139880: Echo 2026-11-06 18:49:19 UTC (the rule's wording), Justin 19:06:28 UTC ("This is not just your memory, this should be a fundamental Instar requirement.").
- `src/data/feature-ladders.json`: 220 entries, none with a structured owner or review-due field.
- `logs/machine-coherence.jsonl`, 2026-11-04 to 11-07: `developmentAgent` false on two of five machines.
- `lint-documented-only-countdown` is clean. `standards-coverage --check` passes except for the direction guard (operator approval).
