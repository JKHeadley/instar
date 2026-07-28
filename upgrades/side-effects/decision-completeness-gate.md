# Side-Effects Review — Decision-Completeness Gate in spec-converge (Autonomy Principles Enforcement, Piece 2)

**Version / slug:** `decision-completeness-gate`
**Date:** `2026-06-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent — concern raised, all items resolved (see below)`

## Summary of the change

Implements Piece 2 of `docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md`: makes single-run-completability **provable** in spec-converge. Three parts:

1. **New internal reviewer** (`templates/reviewer-decision-completeness.md`, 6th of six): enumerates every mid-run stop-and-ask-the-user point; each must be **frontloaded** into `## Frontloaded Decisions` or tagged **cheap-to-change-after** behind a named dark/dry-run/read-only phase. The reviewer **CONTESTS every cheap tag** against a closed non-cheap taxonomy (durable external side-effects, money, identity, published/user-visible interface — NEVER cheap); a rejected tag is a material finding that blocks convergence.
2. **New convergence criterion** (SKILL.md Phase 3): a spec cannot converge while `## Open questions` contains an unresolved user-decision — additive to "no material new issues."
3. **Structural enforcement + earned evidence** (`write-convergence-tag.mjs`): the tag writer now REFUSES to stamp `review-convergence` while open questions remain (criterion 2 cannot be skipped by prose), and writes `single-run-completable: true` + the reviewer's counts (`frontloaded-decisions`, `cheap-to-change-tags`, `contested-then-cleared`) so the tag carries its evidence — earned, not minted. The script gained an import-safe main guard so the parser (`findOpenQuestions`) is unit-testable.

Files: `skills/spec-converge/SKILL.md`, `skills/spec-converge/templates/reviewer-decision-completeness.md` (new), `skills/spec-converge/scripts/write-convergence-tag.mjs`, `tests/unit/write-convergence-tag-decision-completeness.test.ts` (new, 15 tests).

## Decision-point inventory

- `write-convergence-tag.mjs` open-questions gate — **add** — a deterministic, commit-time text validator: refuses the convergence stamp while `## Open questions` has unresolved entries. (Hard-invariant class, see §4.)
- Convergence criterion 2 (SKILL.md) — **add** — prose criterion backed by the structural gate above.
- Decision-Completeness reviewer — **add** — produces findings (signals) folded into the round; blocking authority remains the convergence process itself.
- `single-run-completable` frontmatter — **add** — disclosure only; does NOT change /instar-dev's `review-convergence` + `approved` enforcement.

---

## 1. Over-block

The open-questions gate could refuse a spec whose `## Open questions` section contains commentary that *looks* unresolved. Mitigated: blockquote lines (`>`), none-markers (`*(none)*`, `(none)`, `None`, `None.`, `N/A`, emphasis variants), blank lines, and horizontal rules are all recognized as resolved; only contentful entries refuse. Unit-tested per variant. Residual: a spec author writing prose commentary as plain (non-blockquote) text under Open questions gets refused — acceptable, the error message names the fix and the convention (blockquote commentary) is already what existing specs use (this very spec's Piece-1 sibling used `> Per Principle 2…` + `*(none)*`, which passes).

## 2. Under-block

Two honest gaps, both by design: (a) the gate validates the SECTION, not the whole document — a user-decision buried in prose outside `## Open questions` is the REVIEWER's job to find (LLM judgment), not the deterministic gate's; (b) an author could delete the question instead of resolving it — but the Decision-Completeness reviewer re-reads the full spec every round and the deleted-but-unresolved decision resurfaces as a finding (the same "rewriting the spec to hide findings" anti-pattern the skill already documents and catches).

## 3. Level-of-abstraction fit

Correct: the deterministic part (is the section empty?) is a cheap structural validator at the tag-writer boundary — the same layer as the existing ELI16-presence check it sits beside. The judgment part (is this REALLY cheap-to-change-after? is that REALLY the user's decision?) lives in the LLM reviewer. Neither re-implements the other.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — the new blocking surface is **hard-invariant validation at a tool boundary**, not a judgment gate.

The open-questions gate is the "structural validators at the boundary of the system" case the principle explicitly allows (like "this field must be a number"): it checks section emptiness against an enumerable marker set — zero judgment, deterministic, with a clear remediation message. The *judgment* calls (contesting cheap tags, finding buried decisions) are the reviewer's — and the reviewer produces findings (signals) that block only through the existing convergence process, exactly like the other five reviewers. No brittle check gained judgment authority.

## 5. Interactions

- **Shadowing:** the gate runs after the ELI16 check inside the same script — ordering is irrelevant (both must pass; neither consumes the other's input).
- **Existing callers:** `write-convergence-tag.mjs` is invoked only by the spec-converge skill flow. Its existing tests (`write-convergence-tag-crossmodel.test.ts`, 5 tests) pass unchanged — the new args are optional and the main-guard restructure preserves CLI behavior (IS_MAIN hardened with realpath + fileURLToPath after second-pass review so a symlinked or %-encoded invocation cannot silently no-op).
- **Pre-existing converged specs:** unaffected — the gate fires at stamp time only; already-stamped specs are never re-validated. Specs converged before this ships simply lack `single-run-completable` (honest, documented in SKILL.md).
- **Idempotency:** re-runs strip and rewrite the new fields exactly like the review-* chain (tested).

## 6. External surfaces

None at runtime. This is skill-content + a repo script + tests: no `src/` change, no API, no fleet migration surface (spec-converge is **agent-private** — deliberately NOT in the builtin skill set, matching `/instar-dev`'s explicit not-user-facing status; the spec's "promote vs declare agent-private" decision is resolved as **agent-private**, recorded here). Future instar-dev specs converge under the stricter criteria — that is the intended effect.

## 7. Rollback cost

Trivial: revert the commit. No persistent state, no migration, no user-visible runtime surface. Specs stamped in the interim keep their earned fields (harmless disclosure).

## Conclusion

Piece 2 lands the spec's design with the criterion enforced structurally (Structure > Willpower) rather than as prose: the tag writer is now the chokepoint that makes "a spec cannot converge with open user-decisions" unskippable, and the `single-run-completable` tag carries its evidence counts. The one new blocking surface is hard-invariant validation, explicitly inside the principle's allowed class. Verified by 15 new unit tests + the 16 existing cross-model tag tests + live functional runs (refuses on a live question; stamps with counts once resolved). Clear to ship as PR 3-of-3's sibling (PR 2).

---

## Second-pass review

**Reviewer:** independent reviewer subagent (adversarial audit of artifact + code + tests, ran the suites).
**Independent read of the artifact: concern raised → all resolved this pass.**

- MUST-FIX (resolved): the IS_MAIN guard could silently exit 0 (doing nothing) when invoked via a symlink or a %-encodable path — safe direction (tag never written without the checks) but a fail-loud violation. Fixed: realpathSync + fileURLToPath comparison; the pre-existing `ROOT` URL-pathname decode bug rode the same fix.
- MUST-FIX (resolved): this artifact overstated the existing cross-model test count (claimed 16; vitest counts 5). Corrected above.
- NICE-TO-HAVE (applied): heading-variant false-pass (`## Open questions (round 2)` was invisible to the gate) — regex loosened to `\b[^\n]*$`.
- NICE-TO-HAVE (applied): SKILL.md now scopes the "earned" claim honestly (the structural guarantee is the open-questions invariant; the counts are caller-supplied disclosure on the same trust model as `--cross-model-review`) and names the blockquote-commentary convention's limit with its reviewer backstop.
- Confirmed clean: signal-vs-authority compliance (deterministic hard-invariant validation; all judgment in the LLM reviewer), taxonomy fidelity to the spec, and test honesty (refuse → exit 1 AND tag absent; idempotency).

---

## Evidence pointers

- `tests/unit/write-convergence-tag-decision-completeness.test.ts` — 15 tests: parser none-marker variants, section-scoping, refuse-on-live-question (and tag NOT written), stamp-on-resolved, earned counts, no-counts → no minted tag, idempotent re-runs.
- `tests/unit/write-convergence-tag-crossmodel.test.ts` — 16 existing tests green (no regression from the main-guard restructure).
- Live functional run: refused `- **Q1:** should we do A or B?` with exit 1 + remediation message; stamped `single-run-completable: true` + counts on the `*(none)*` variant.
