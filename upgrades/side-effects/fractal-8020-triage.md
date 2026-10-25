# Side-Effects Review — fractal 80/20 convergence, size tiers, found-problem triage (CMT-917)

**Version / slug:** `fractal-8020-triage`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `not required (skill wording + an idempotent stock-only skill re-copy migration; no runtime behaviour, no authority change)`

## Summary of the change

Operator-approved 2026-10-22 09:01 PDT (topic 127831, tracked CMT-917). Skill content only, plus delivery to existing agents:
- `skills/spec-converge/SKILL.md`: convergence = a round raises no DESIGN-class finding (one quiet round); precision/long-tail findings listed under `## Left behind`, not iterated; cap 3 rounds Tier 1 / 6 Tier 2+ (was 10), at the cap safety/security/data-loss findings go to the operator and the rest are accepted with a reason; lens findings count only where the change touches the lens; report gains `## Proportion`. Removed "A smaller finding count is NOT convergence".
- `skills/instar-dev/SKILL.md`: plain size tiers; found-problem triage; proportion line in the side-effects summary / PR body.
- `.claude/skills/build/SKILL.md`: plain size rule, triage, SUMMARY gains Found problems + Proportion.
- `.claude/skills/autonomous/SKILL.md`: triage (and how it fits scope accretion), proportion line in the final report.
- `src/core/PostUpdateMigrator.ts`: `migrateFractalEightyTwentyTriage` (spec-converge, instar-dev, build) replaces the superseded `migrateConvergeDesignClassCriterion` (its marker left the bundled file, so it could never fire again); `/autonomous` gets a `FRACTAL_8020_TRIAGE` step in its existing marker chain.
- Test: `tests/unit/PostUpdateMigrator-fractalEightyTwentyTriage.test.ts` (replaces the superseded migration's test).

Proportion: Tier 1; 6 files, ~200 LOC of prose + one migration; 1 self-review round.

## Decision-point inventory

- spec-converge stop criterion — modify — when review ends (a judgment the reviewer declares; no code gate changed).
- Found-problem routing — add — guidance only.

---

## 1. Over-block

None. Nothing new blocks; the change removes iteration.

---

## 2. Under-block

A reviewer that mislabels a design defect as precision now ends review after one round instead of two. Mitigation kept: per-round class counts and the full Left-behind list are in the report the operator reads; safety/security/data-loss findings at the cap still go to the operator.

---

## 3. Level-of-abstraction fit

Skill prose is the layer that defines these processes; Occam's Razor article: no new gate or checker. The proportion signal is a report line, not machinery.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic. The size tier stays the agent's declared judgment (the commit gate's tier signal is unchanged).

---

## 5. Interactions

Later migrations that re-copy the same bundled files (judgment-floors, conformance, build methodology, autonomous chain) copy the new content too, so ordering cannot regress it. Scope-accretion server sweep unchanged: the autonomous text says to route an already-drafted artifact for a found problem and ask for ratification.

---

## 6. External surfaces

None.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Skill files are per-install and updated on each machine by its own migration run; no state.

---

## 8. Rollback cost

Revert the commit; agents that already took the migration keep the new skill text until the next skill-content migration (same as every prior skill change).

---

## Conclusion

Review and runs now stop on fractal 80/20 and route found problems instead of absorbing them.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/PostUpdateMigrator-fractalEightyTwentyTriage.test.ts`
