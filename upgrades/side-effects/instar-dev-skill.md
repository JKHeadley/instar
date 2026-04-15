# Side-Effects Review — /instar-dev skill + enforcement hooks

**Version / slug:** `instar-dev-skill`
**Date:** `2026-04-15`
**Author:** Echo (autonomous, forward-plan Track 1)
**Second-pass reviewer:** self-review on the first commit (bootstrap exception applies); will be covered by independent review on first non-bootstrap change through the skill

## Summary of the change

Introduces a dedicated `/instar-dev` skill and its enforcement infrastructure. The skill wraps `/build` as the execution engine and adds five phases around it: principle check, planning, build, side-effects review, second-pass review (for high-risk changes), and trace+commit verification.

Files added:
- `skills/instar-dev/SKILL.md` — the skill definition.
- `skills/instar-dev/templates/side-effects-artifact.md` — the artifact template every change through the skill produces.
- `skills/instar-dev/scripts/write-trace.mjs` — helper that emits a trace file bound to a specific artifact and staged files.
- `docs/signal-vs-authority.md` — the architectural principle the skill enforces at Phase 4 Question 4.
- `scripts/instar-dev-precommit.js` — pre-commit gate that verifies a fresh trace + artifact matches the staged in-scope files.

Files modified:
- `.husky/pre-commit` — adds the gate invocation after the lint step.
- `scripts/pre-push-gate.js` — at push time, rejects release commits whose upgrade notes qualify for review but have no matching artifact in `upgrades/side-effects/`.
- `.gitignore` — excludes `.instar/instar-dev-traces/` from the repo (runtime state).

## Decision-point inventory

The change introduces TWO new decision points, both in the *developer-process* domain (not the agent-message-flow domain the signal/authority principle was primarily defined for):

- `scripts/instar-dev-precommit.js` — pre-commit gate — **add** — blocks git commits that stage in-scope files (src/, scripts/, .husky/, skills/**/SKILL.md or scripts) without a matching fresh trace + artifact.
- `scripts/pre-push-gate.js` Section 5 — pre-push release gate — **add** — blocks git pushes where the upgrade notes' "What Changed" contains fix/feature keywords but `upgrades/side-effects/` has no matching artifact.

Both decision points gate *developer actions on the instar repo itself*. They do not gate agent-to-user messaging, session lifecycle, or anything else in the runtime agent domain.

---

## 1. Over-block

**What legitimate developer actions does this reject that it shouldn't?**

- A developer wants to edit `src/` to experiment in a scratch branch, with no intent to commit. → The gate only fires on `git commit`, not on edits. Not over-blocked.
- A developer wants to commit purely documentation updates (README, docs/) that don't touch behavior. → The `inScope` filter only triggers on `src/`, `scripts/`, `.husky/`, and `skills/**/SKILL.md or scripts`. Pure docs pass through. Not over-blocked.
- A developer makes a legitimate emergency hot-fix. → They still need an artifact. The skill's anti-patterns section explicitly addresses this: emergency fixes are the changes most likely to cascade; the artifact requirement is minimal but not skippable. Intentional, not over-blocking.
- A developer wants to commit a source change after rebasing against main, where the trace from before the rebase is now stale (>60 min). → The gate will require a fresh trace. This is correct behavior — rebase is a fine trigger to re-review, since conflicts may have changed the semantics.
- A developer splits a logical change across two commits (say, src/ in commit 1, tests in commit 2). → If tests-only commits pass through (as currently coded), this works. If tests/ were in scope, the second commit would need its own trace. Current scoping puts tests/ out of scope — developer can commit them separately without artifact overhead. This is a deliberate trade-off.

**Conclusion:** minor risk of over-blocking on boundary cases (rebase, split commits) but all are intentional and aligned with the skill's purpose. No accidental over-block identified.

---

## 2. Under-block

**What developer-side shortcuts does this still permit that the process is trying to prevent?**

- `git commit --no-verify` — bypasses husky entirely. Cannot be structurally prevented at the git level. Mitigation: any commit with `--no-verify` lacks the skill's trace file, which is visible in the commit's metadata absence. A release-analysis step (not in this change) could flag commits whose artifact-paired state looks forged.
- A developer writes a minimal-stub artifact (just enough to clear `MIN_ARTIFACT_CHARS=200`) and a matching trace, then ships a bad change. → Mitigation is at the content level: second-pass reviewer subagent (Phase 5) for high-risk changes. Not structural, but documented.
- A developer writes an honest artifact, then edits the staged source afterward to add something not covered. → Mitigation: the trace records `coveredFiles` as a list; if the subsequent edit adds a new in-scope file, the gate fails. But if the developer only *modifies* an already-covered file, the trace passes — the content can drift from what the artifact analyzed. This is a gap; closing it would require hashing the file contents at trace time, which is complexity worth adding in a follow-up.
- A developer runs write-trace.mjs manually with fabricated inputs. → Possible. The `sessionId` field is recorded but not verified against any central authority. A trace-forgery check could be added in a follow-up (e.g., require the trace to include a signed token from a server-side endpoint), but the current enforcement relies on social contract for this layer.

**Conclusion:** the gate is a well-formed first-layer enforcement but has the known gaps above. All of them require deliberate circumvention; none happen accidentally.

---

## 3. Level-of-abstraction fit

The pre-commit gate is at the right layer. Pre-commit hooks are exactly the structural layer for "developer must do X before committing." It runs early, has access to staged files, and blocks the transaction.

The pre-push gate is at the right layer for release-level checks. It catches the case where a developer committed with the bootstrap exception or `--no-verify` and is now trying to push. It re-verifies artifacts at the release boundary.

Neither of these is a runtime-agent-decision-point, so the signal/authority principle doesn't apply to them in the same way. They ARE "brittle checks with blocking authority" in a literal sense, but their domain is narrow and well-defined (specific file path patterns, specific content patterns), and false positives are cheap for the developer to resolve (produce the artifact).

---

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has block/allow surface, but in the developer-process domain, not the agent-runtime domain. The principle's "brittle detectors cannot judge" rule is about judgment calls that require conversational/semantic context. These gates judge only file paths and literal content patterns — constrained domains where deterministic matching is appropriate (see `docs/signal-vs-authority.md` "When this principle does NOT apply" section: hard-invariant validation at system boundaries).

**Key point:** the gates don't gate AGENT behavior. They gate DEVELOPER behavior on the instar repo itself. The signal/authority principle is explicitly scoped to judgment decisions in agent-message-flow and session-lifecycle domains. Pre-commit hooks on file paths are transport-layer mechanics, not judgment.

That said, the `MessagingToneGate` violation observed 2026-04-15 — the authority citing rules not in its prompt — is a reminder that authorities also drift. The enforcement for THIS change's domain doesn't have that risk because there's no LLM involved; the gate just reads JSON and checks file existence. But future work on the tone gate will include a structured-reasoning constraint.

---

## 5. Interactions

- **`.husky/pre-commit`:** the gate runs after `npm run lint`. If lint fails, the gate is not reached. Lint failures are the developer's problem to fix first. No shadowing concern.
- **`scripts/pre-push-gate.js`:** the new Section 5 runs after Sections 1–4. If earlier sections produce errors, all errors are still reported (errors accumulate, then exit 1 at the end). Not short-circuited.
- **Bootstrap exception:** the pre-commit gate detects the first-ever commit that introduces itself and passes through. This exception fires once by design. Subsequent commits no longer trigger it. No way to re-trigger it without deleting and re-adding the script, which is structurally visible.
- **`upgrade-guide-validator.mjs`:** separate concern from the artifact. The validator checks upgrade-note content quality. The pre-push gate's Section 5 checks artifact existence. Two different files, two different checks, no overlap.
- **Existing instar runtime:** zero runtime interaction. These are developer-time hooks; they don't affect any agent, any session, any message flow.

**Race conditions:** none. Pre-commit and pre-push are serial git operations.

---

## 6. External surfaces

- **Other agents:** zero impact. These hooks run only when someone commits to the instar repo. No agent at runtime cares.
- **Other users:** zero impact at runtime. Developers who commit to instar see different behavior (commits blocked without artifact) — that's the point.
- **External systems:** zero impact.
- **Persistent state:** `.instar/instar-dev-traces/` accumulates trace JSON files. Gitignored. Developers may want to prune periodically. No state outside the instar repo.
- **Timing / runtime conditions:** the 60-minute trace-freshness window is a policy choice. If developers hit it on long-running work, they can always re-run the skill to produce a fresh trace. Not a true coupling to runtime conditions.

---

## 7. Rollback cost

Near-zero.

- Revert the `.husky/pre-commit` addition (one line removed).
- Revert the `scripts/pre-push-gate.js` Section 5 addition.
- Delete `scripts/instar-dev-precommit.js`, `skills/instar-dev/`, `docs/signal-vs-authority.md`.
- Revert the `.gitignore` entry.

No persistent data migration. No user-visible regression. The only cost is that any developer who produced an artifact during the live window will have written a markdown file they no longer need — easily deleted.

---

## Conclusion

The change introduces a structural enforcement layer for the `/instar-dev` process. The layer is well-scoped (developer-process domain, not agent-runtime domain), its decision points are in constrained domains appropriate for deterministic gates, and its rollback cost is near-zero. The known under-block gaps (trace forgery, stub artifacts, post-trace staged edits) are documented for future closure but do not block first-ship — they require deliberate circumvention and are visible in git history.

The change is clear to ship as an infrastructure commit. It does not need a version bump or public release note — it's internal process infrastructure. Track 2 reworks will be the first changes to ride through the new skill and will exercise the full lifecycle including the second-pass reviewer.

## Second-pass review

**Reviewer:** not required for this change. Per the skill's Phase 5 criteria, second-pass is required when the change touches block/allow decisions in the agent-runtime domain (outbound messaging, dispatch, session lifecycle, etc.). This change's decision points are in the developer-process domain.

The first Track 2 rework will be the first real-world exercise of the second-pass mechanism.

## Evidence pointers

Dry-run verification of the pre-commit gate performed 2026-04-15:

- Block case: staging `src/core/types.ts` with no artifact → gate exits 1 with "commit BLOCKED" banner listing the in-scope file and "No trace directory found" reason. Verified.
- Pass case: stage a matching artifact in `upgrades/side-effects/`, run `write-trace.mjs` to produce a trace, re-stage → gate exits 0 with confirmation line identifying trace filename and artifact path. Verified.

Pre-push gate Section 5 verified by running against the current NEXT.md state: the section correctly detects fix/feature keywords in "What Changed" and reports the missing-artifact error alongside existing NEXT.md template-placeholder errors. Exit code 1. Verified.
