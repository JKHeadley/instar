# Side-Effects Review — Chief of Staff: "PR merged" done items it can check itself

**Version / slug:** `cos-pr-merged-done-items`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; a read-only evaluator under an approved spec, no gate added)`

## Summary of the change

The Chief of Staff spec (docs/specs/chief-of-staff-topic.md §1.3, approved 2026-11-09) names four deterministic done-item kinds, starting with "PR merged into the default branch". Only one, `page <url> contains "<text>"`, was built, and it lived inline in `src/commands/server.ts`. On Echo, 15 of 22 projects read verdict `unknown` forever because no done item could be checked (fb-e9d75715-316). This change moves the evaluator into `src/core/ChiefOfStaffEvidence.ts` as `buildDoneItemEvaluator` (now unit-testable), keeps the page check byte-for-byte in behaviour, and adds `PR owner/repo#N merged`: it reads `repos/<repo>/pulls/<N>` through the existing authenticated gh runner, only for a repo the owner linked, and passes only when the PR merged into that repo's default branch. `server.ts` shares one cached default-branch lookup between the gather and the evaluator. An awareness entry tells drafting agents to write done items in the two checkable forms and to fill linked repos. Files: `src/core/ChiefOfStaffEvidence.ts`, `src/commands/server.ts`, `src/data/awareness/chief-of-staff-checkable-done-items.md`, `tests/unit/ChiefOfStaffDoneItemEvaluator.test.ts`, `tests/unit/chief-of-staff-loop-wiring.test.ts`.

## Decision-point inventory

- `Chief of Staff done-item evaluation (§2.2 gather)` — modify — one more item form can now read `pass`/`fail` instead of always `unknown`. The authority floors in the loop (§2.5/§2.6) are unchanged: a deterministic pass still needs every judgment item confirmed before `done-verified`, and close stays reversible (owner `reopened`).

---

## 1. Over-block

No block/allow surface. A PR-form item that names an unlinked repo reads `unknown` (not `fail`), so an owner who forgot to link a repo sees "not known" rather than a false failure.

---

## 2. Under-block

A PR that merged into the default branch and was later reverted still reads `pass`; the spec's evaluator is "merged by SHA", and a revert is a new PR the owner can add as an item. A done item phrased in prose stays `unknown`, as before; this change does not rewrite existing bindings (that needs the owner's confirm, separately).

---

## 3. Level-of-abstraction fit

Right layer: the gather (§2.2) is where deterministic evidence is read, and this reuses its gh runner, timeout and per-tick cache instead of a new GitHub client. It feeds the existing judge and floors; it adds no parallel decision.

---

## 4. Signal vs authority compliance

Compliant. The evaluator is a deterministic read of a structured API (GitHub's merged_at and base ref), not brittle text matching on free prose. Its only effect is an evidence value; the loop's existing floors hold the authority, unchanged.

---

## 5. Interactions

Shares the `prCache` default-branch entry with the net-diff compare (same key, same value), so one lookup per repo per tick. The evaluator runs inside the gather's existing `withTimeout(probeTimeoutMs)`; a slow GitHub call reads `unknown`. No change to the judge, the floors, the note, or restart logic.

---

## 6. External surfaces

One extra read-only GitHub API call per PR-form done item per check (cadence ~24h per project), through the agent's existing authenticated gh. No new outbound messages, routes or stored fields. The awareness entry adds a paragraph to every agent's Feature notes.

---

## 7. Multi-machine posture

Machine-local by design, like the rest of the gather: whichever machine holds the Chief of Staff lease runs the check and writes the check-event, which already replicates through the CoS journal. No new state.

---

## 8. Rollback cost

Revert the PR. The page check returns to its inline form with identical behaviour; PR-form items go back to `unknown`. No data migration, no stored state to repair.

## Proportion

Tier 1, 5 files, ~110 LOC (half tests). One build pass, no spec rounds (builds an approved spec).
