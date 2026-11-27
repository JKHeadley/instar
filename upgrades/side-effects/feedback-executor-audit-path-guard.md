# Side-Effects Review — Feedback executor audit path guard

**Version / slug:** `feedback-executor-audit-path-guard`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `independent GPT-6 Astra security review`

## Summary of the change

The confined feedback worker's final change-set gate now treats `.instar` and every descendant as protected, including case-folded spellings and normalized relative paths. Both sandbox configurations also deny writes to the workspace `.instar` tree. A worker-supplied decision record is held before the trusted publisher commits or pushes. The approved feedback triage and execution spec already requires a tooling-path gate; the observed PR #2442 showed that its implementation omitted this repository state tree. This patch touches `executePolicy.ts` and unit/E2E tests. It does not add an exception for trusted audit files or alter the independent-review rule.

## Decision-point inventory

- `isToolingPath` and `toolingPathsTouched` — modify — a hard publication safety invariant on exact repository paths, consumed before `gateAndPublish` for fixes.
- `buildSandboxRuntimeSettings` and `buildClaudeSandboxSettings` — modify — defense in depth on writes by confined commands and the session.
- Independent reviewer and decision-audit CI — pass-through — their existing policy conflict remains unresolved for PR #2442.

---

## 1. Over-block

A confined fix that legitimately needs to modify `.instar/` now stays held. That is the intended boundary: those files include agent state, audit evidence, hooks and settings, and require a trusted development path. A source fix whose tests try to write fixture data under the repository's own `.instar/` may fail in the sandbox; tests should use an isolated temporary project directory. Prefix matching is confined to the repository root, so a source file named `src/instar.ts` remains allowed.

## 2. Under-block

The sandbox deny is a second layer, not the authoritative gate. A test process or misconfigured sandbox might create a different spelling of `.instar`; the final gate case-folds and rejects changed entries before publication. Symlink/special-file changes are already refused by `buildChangeSet`. The guard does not authenticate any audit record created later by trusted publisher code; that requires the separate provenance design. The existing reviewer can still reject legitimate feedback PRs whose other changes touch agent guidance or tooling.

## 3. Level-of-abstraction fit

The path predicate belongs in the existing change-set tooling gate, where all added, modified and deleted entries pass before publication. The sandbox policy provides an earlier refusal but cannot substitute for the final byte comparison. No separate route or mutable configuration is added.

## 4. Signal vs authority compliance

This is a hard safety invariant on an exact repository directory, not a judgment about the meaning of a report or code. The existing deterministic authority for publishable paths already blocks `.github`, `.claude`, hooks and executor code; extending it to `.instar` closes an omitted protected tree. An LLM reviewer remains responsible for judging the allowed code change.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new semantic judgment point is added. The rule is a structural path and provenance boundary; it does not rank feedback, interpret intent or decide whether a source fix is good.

## 5. Interactions

The worker can no longer supply the decision-audit records that the repository's ordinary CI requires for source changes. This exposes the existing policy collision instead of accepting untrusted audit bytes. Publication must stay held until a separate trusted provenance carrier is designed and reviewed. The positive source/test/doc path allowance and secret, size and regression gates remain active. Both local and deployed executor configurations call the shared policy builders.

## 6. External surfaces

No new API, message, outbound domain or credential is added. The effect is fewer PRs published from confined sessions, with `needs-review-tooling` and the touched path list recorded by existing executor state. The worker still cannot read the publish clone or hold GitHub credentials.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The existing held-attempt action item names the blocked path and reason. It should not tell the operator that their approval is required to waive this invariant. The PR #2442 review packet continues to explain the unresolved audit and reviewer conflict with a direct link.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is pure source policy installed with Instar on every machine; there is no machine-local state to replicate. Only the canonical executor owner may publish. A machine handoff uses the same final change-set gate and cannot make a prior worker-supplied `.instar` entry acceptable.

## 8. Rollback cost

The code has no migration or persistent schema change. Reverting would reopen the observed untrusted audit-file publication gap, so rollback should disable executor publication or replace this with an equivalent stricter guard. Previously published PRs are not retroactively trusted by this change.

## Conclusion

The guard closes a concrete unsafe publication path but is not a complete end-to-end provenance repair. It can ship under the approved executor spec after its own unit, integration, E2E, full-suite and independent review gates pass. PR #2442 remains open until the decision-audit versus independent-review conflict and merge checks are resolved separately.

## Second-pass review (if required)

The independent GPT-6 Astra reviewer found one blocking bypass in the first version: POSIX allows a literal backslash in a filename, and rewriting it as a path separator before normalization could make a real `.instar` file appear to be an allowed `src/` path. The guard now rejects a literal backslash on POSIX before any rewriting and refuses parent-path segments. A regression creates the actual filename under `.instar`, builds a change set and checks that the publication gate holds it. On re-review the reviewer reported: **“Concur with the review.”** The reviewer also noted that the mocked E2E sandbox assertion proves configuration wiring, while the final change-set gate remains the authoritative protection even if the runtime sandbox is misconfigured.

## Evidence pointers

- Approved spec: `docs/specs/feedback-triage-and-execution.md` and its ELI16 companion.
- Code: `src/feedback-factory/execute/executePolicy.ts`, `src/feedback-factory/execute/FeedbackExecutorService.ts`, `src/feedback-factory/execute/changeSet.ts`.
- Focused tests: `tests/unit/feedback-factory/execute-units.test.ts`, `tests/unit/feedback-factory/execute-service.test.ts`, `tests/e2e/feedback-execute-lifecycle.test.ts`.
- Live finding: https://github.com/JKHeadley/instar/pull/2442#issuecomment-6537745039

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is claimed. This is a publisher path-confinement defect, and its regression guard is the final change-set refusal plus focused service test; no class-closure declaration is made for the artifact registry.
