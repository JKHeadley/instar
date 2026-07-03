# Side-Effects Review — Evidence-Bar Extension (defect class 3, dark increment)

**Version / slug:** `evidence-bar-judge-extension`
**Date:** `2026-07-03`
**Author:** `echo`
**Tier:** `1 (dark increment — additive classification + one pinned ratchet; no runtime wiring, no operator-gated text)`

## Summary of the change

The mechanical arm of the "Evidence-Bar Extension to Judge Prompts" standard (defect class 3 / `claim-vs-evidence` closure; `docs/specs/evidence-bar-judge-extension.md`), shipped as a self-contained DARK increment. It ships:

1. **`src/data/llmBenchCoverage.ts`** (additive) — `LLM_JUDGES_CLAIMS`, the `judgesClaims` axis of the program's ONE shared per-callsite metadata record (sibling of the authority-clause `untrustedInput` axis, co-located in the same file). `ClaimKind` = `completionClaim | healthClaim | scoredCredit`; `JudgesClaimsFlag` = `{ claimKind }` (a judge) | `false` (not a judge) | `{ false: reason }` (a judge-shaped callsite argued out of scope). Required-explicit for every `COMPONENT_CATEGORY` key.
2. **`tests/unit/judges-claims-classification-ratchet.test.ts`** — required-explicit + no-dangling + valid-claimKind-per-judge + the spec-named JUDGE-SEED pinned as a judge + argued-false-shrink-only + real-reason floor. Same pinned-baseline family as the sibling ratchets.
3. **`docs/specs/evidence-bar-judge-extension.md`** + **`.eli16.md`** — the converged spec + plain-English overview (carried in with the closure so the standard's authority is on canonical main).

## What is DELIBERATELY out of scope (not orphan deferrals)

- **The registry amendment (spec §1).** Operator-gated — ships ONLY with Justin's explicit sign-off (spec front-matter `operator-gate`; the amendment is DRAFTED in spec §1). This run does not write `docs/STANDARDS-REGISTRY.md`.
- **The bench-axis pair ratchet (spec §3).** A bare-claim (false-accept) case + a real-evidence (false-reject) case per `judgesClaims` judge. Blocked on the program-wide "batteries readable by CI" decision — `research/` is absent from canonical main, so main's CI cannot read axis fields (`class-closure-gate.md` §"Program-shared machinery" #2, binding all three sibling axis specs). The sibling authority-clause axis ratchet deferred on the identical blocker; the keystone (#1347) staged its axis-requirements ratchet into its OWN dark increment for the same reason. Landing it under one standard's name would be doing shared cross-program infra as a side effect.
- **The `evidenceBar()` prompt clause (spec §4).** A sibling of the authority clause, defined by the spec to live in `src/core/promptClauses.ts`. That shared library is introduced by the still-OPEN sibling PR (authority-clause, #1351); creating it here would hard-collide on the same new file and break auto-merge for whichever PR merges second. The clause is consumed only by the A/B-gated per-component migrations (spec §4 / rollout §2), which are behavioral and deferred regardless — so shipping the clause function now would add a caller-less string with a merge hazard and no live value. It lands as a follow-up once the shared library is on main.
- **Per-component A/B clause migrations (rollout §2).** Behavioral prompt-text changes, each gated by the A/B protocol; the completion judge goes LAST (three wordings have already failed honestly — the named legitimate terminal state is "incumbent stands + routing mitigation + tracked gap"). A downstream task, not this dark increment.

## Decision-point inventory

- `LLM_JUDGES_CLAIMS` (`src/data/llmBenchCoverage.ts`) — **add** — build-time metadata only. Read by the new pinned ratchet; no runtime consumer. A SIGNAL producer (which callsites judge a completion/health claim), never a runtime authority.
- `tests/unit/judges-claims-classification-ratchet.test.ts` — **add** — a CI-only pinned baseline (same family as `llm-bench-coverage-ratchet`). It gates the build (adding an unclassified LLM callsite / mis-shaping a judge entry is red CI), never a runtime path.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None at runtime — nothing is wired to a runtime allow/deny path. The only new red-CI surfaces are build-time and intentional: (a) adding a new LLM component to `COMPONENT_CATEGORY` without an explicit `judgesClaims` classification, (b) shaping a judge entry with an invalid `claimKind`, (c) marking a spec-named JUDGE-SEED callsite as `false`, or (d) drifting the argued-false pinned baseline. Each is a self-describing failure with fix-instructions in the assertion message — the "visible, reviewed act" the standard exists to force, not an over-block of legitimate work.

## 2. Under-block

**What failure modes does this still miss?**

- The classification records WHICH callsites judge claims; it does NOT yet enforce that each judge carries the bare-claim + real-evidence axis PAIR (that is the deferred bench-axis ratchet, spec §3). So a classified judge can still ship with no false-accept/false-reject coverage until that ratchet lands. This is the known staged-rollout gap, tracked in the spec rollout, not a silent miss.
- Classification accuracy is author-judged (like the sibling `untrustedInput` axis). A judge mislabeled `false` beyond the spec-named seed would pass — the JUDGE-SEED floor + the argued-false shrink-only pin catch the measured judges and every judge-shaped exemption; the seeding PR IS that review.
- A prompt bar cannot AUTHENTICATE material — a fabricated transcript showing a fake PASS passes any in-prompt bar (spec "Honest reach"). The authoritative verification arm is the deterministic real-check `verification_command`, which is out of this classification by construction and named in the spec as the true-verification owner.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The classification extends the ONE shared per-callsite metadata record the program mandates (`src/data/llmBenchCoverage.ts`), not a new parallel registry — exactly where the sibling `untrustedInput` axis lives; the ratchet is in the established pinned-baseline vitest family. No higher gate already owns "which callsites judge a completion claim"; no lower primitive is duplicated.

## 4. Signal vs authority compliance

`LLM_JUDGES_CLAIMS` and the ratchet are SIGNALS (which callsites judge a claim; is each judge classified and axis-eligible) — they inform the build and the reviewer, never grant or deny a runtime action. No model-produced field is wired to satisfy any check. The (future, deferred) prompt clause, once consumed, would make a model REPORT that a bare claim is unverified rather than CREDIT it — it never becomes the authority; the deterministic real-check verifier owns what is TRUE.

## 5. Interactions with existing systems

- **`llm-bench-coverage-ratchet`** — unaffected: `LLM_JUDGES_CLAIMS` is a NEW additive export; the existing `LLM_BENCH_COVERAGE` union and its ratchet are untouched (both green post-change under a bounded run).
- **`untrusted-input-classification-ratchet` / `promptClauses.ts`** (sibling authority-clause, PR #1351, still open) — this increment adds a PARALLEL axis export in the same file and a parallel ratchet; it does not import or depend on the authority-clause work. Both append to `LLM_BENCH_COVERAGE`'s file region, so a textual rebase against #1351 may be needed depending on merge order — an additive, mechanical resolve, no semantic conflict.
- **`class-closure-lint.mjs`** — already names `src/data/llmBenchCoverage.ts` as an agent-authored artifact; touching it routes the PR to operator review (the lint is report-only today). The defect class `claim-vs-evidence` already carries `closureStandard: evidence-bar-judge-extension` on master — untouched here.

## 6. Failure modes / rollback

Pure additive TypeScript + one test + spec docs. Rollback = revert the commit; nothing persists state, nothing runs at runtime, no migration, no config key (spec §"Decision points touched": none at runtime; no agent-side config key exists or is wanted — repo posture only, so no Migration Parity work). tsc clean, `npm run lint` exit 0, both ratchets green under bounded single-file runs (machine under intermittent external CPU pressure; verification used bounded vitest per the CI-as-gate pattern, full suite gated by CI).

## 7. Second-pass reviewer

Self-review (bounded machine-pressure build). The change is additive, dark, and test-pinned; no runtime surface. Key self-checks: (a) confirmed the JUDGE-SEED is exactly the spec §2 named LLM judges (real-check verifier correctly excluded as the deterministic arm); (b) the two stall-confirm adapters (Telegram/Slack) classify true by the spec's stated inclusion criteria (stall/health classifiers), the safe over-inclusive direction; (c) the required-explicit ratchet actually fired during authoring (caught 3 unclassified callsites), proving it is not a no-op; (d) argued-false baseline is empty and the type still supports it for future judge-shaped exemptions.
