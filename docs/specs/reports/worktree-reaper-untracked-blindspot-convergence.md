# Convergence Report — AgentWorktreeReaper untracked-blindspot fix

## Cross-model review: SKIPPED-ABBREVIATED (single-framework, load-aware)

Cross-model external passes were deliberately skipped: this is a tightly-scoped fix to a single safety gate, run during active load investigation. The mandatory lessons-aware reviewer ran (the structural anti-circular-self-verify check) plus an adversarial reviewer and the code-backed Standards-Conformance Gate — which together caught a deletion-safety BLOCKER, so the abbreviated round was not a rubber-stamp.

## Iteration Summary

**Round 1**
- **Standards-Conformance Gate: ran (1 flag).** "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes": the reaper drains a ~200-worktree backlog over repeated passes with no breaker for *sustained reclaim failures*. → ADDRESSED: added a per-path consecutive-failure breaker (`maxReclaimFailuresPerPath`, default 3) that stops attempting a permanently-unremovable path and surfaces it as `keep('reclaim-failed')`, emitting once.
- **Adversarial reviewer (general-purpose):** found the residue-denylist is NOT actually shared via `DEFAULT_RESIDUE_DENYLIST` (yield-safety reads a separate config list), and that the existing broad entries (`out/`, `build/`, `coverage/`, `*.log`) match user-authorable files — dangerous on a deletion path; also that non-`--force` `git worktree remove` does NOT refuse on untracked files, so `classifyPorcelain` is the SOLE gate for the untracked case. → ADDRESSED: the reaper now carries its own NARROW `REAPER_RESIDUE_DENYLIST` (only unambiguous-never-work entries; excludes the broad ones) and does NOT mutate `DEFAULT_RESIDUE_DENYLIST`; the spec's "second guard" claim was corrected.
- **Lessons-aware reviewer (general-purpose):** found the BLOCKER — `makeWorktreeDirtyCheck` fails OPEN (git error → "not dirty"), which inverts to the unsafe direction for a deletion gate (No Silent Degradation). Also disclosed a third consumer (`OrphanedWorkSentinel`) sharing `isClean`. → ADDRESSED: `isClean` calls the PURE `classifyPorcelain` on a successfully-read porcelain and keeps the fail-CLOSED catch (`return false` → dirty → KEEP); the OrphanedWorkSentinel coupling is documented + covered (narrow list = correct there too).

**Round 2 (convergence check)**
- All round-1 findings resolved in the spec AND the implementation; the unit tests pin both sides of every boundary (residue→clean, non-residue→dirty, broad-entry→dirty, git-error→KEEP/fail-closed, breaker trip + clear). No new material findings. **Converged.**

## Material findings & resolutions
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | BLOCKER | fail-open dirty-check on a deletion gate | pure `classifyPorcelain` + fail-CLOSED catch; do not use the wrapper |
| 2 | MAJOR | broad shared denylist on deletion path | narrow `REAPER_RESIDUE_DENYLIST`; don't mutate the shared default |
| 3 | MAJOR | undisclosed `OrphanedWorkSentinel` consumer | documented + tested; narrow list is correct there too |
| 4 | flag | No Unbounded Loops (sustained reclaim failure) | per-path failure breaker |
| 5 | MINOR | non-force remove doesn't guard untracked | spec corrected; `isClean` is the real gate (hence #1+#2 matter) |

## Decision-completeness
All decisions frontloaded; `## Open questions` is empty. Ships behind the existing `agentWorktreeReaper.enabled` + `dryRun` knobs (review the dry-run report first).
