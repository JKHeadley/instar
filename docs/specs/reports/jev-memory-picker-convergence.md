# Convergence Report — Jev memory picker

**Spec:** [docs/specs/jev-memory-picker.md](../jev-memory-picker.md)
**Slug:** `jev-memory-picker`
**Converged at:** 2026-09-30
**Iterations:** 1 internal review round (one 80/20 round, per the build brief)

## Review

One independent reviewer (a Claude subagent, read-only) covered security,
adversarial, integration and decision-completeness in one pass. It returned 2 design
findings and 6 minor ones. All were folded into the spec and the code before the build
finished. None was set aside.

Cross-model review: not run. The build brief limits this spec to one 80/20 round, and
Codex quota is kept for Astra reviews. The Standards-Conformance Gate was not run
either. This is recorded as it happened.

**Convergence rule, stated honestly.** The skill's criterion is two consecutive rounds
with no design-class finding. This spec had one round. It is closed under the
operator's standing 80/20 rule (Justin, 2026-09-17: "usable soon beats perfect") and
the brief's explicit one-round limit. The feature is shadow-only and signal-only: in
shadow it cannot change what a session sees.

## Findings and what was done

1. **[design] Inject can only add, never reorder.** Claude Code still loads the
   positional prefix. The first draft ranked every line and "kept the budget at 117",
   which the mechanism cannot produce. It also ranked lines that load anyway. Fixed:
   only the non-pinned lines past the cut are ranked (about half the questions). What
   gets added is capped by `injectLines` (40) and `injectMaxChars` (10,000).
2. **[design] Two answers for a Jev failure.** Fixed: a failure adds no ranked line.
   Only pinned lines past the cut are added, since they need no ranking. With nothing
   pinned, which is the state on ship, that is exactly today's load. Tested.
3. **[minor] Symlinks.** Fixed: the path checks rerun on `realpath`, and an index file
   that is a symlink is refused (`lstat`). Both refusals are tested.
4. **[minor] Worktree sessions.** Claude Code keys memory on the git root. Fixed: the
   hook sends the root from `git rev-parse --git-common-dir`, and a missing index is a
   `no-index` skip.
5. **[minor] B+C with no glossary was never measured.** Addressed in the real-shape
   replay: the note's hard case was run with and without a two-line glossary.
6. **[minor] Trigger events.** Stated in the spec. Each row logs `source`.
7. **[minor] New data class leaving the machine.** Named in the spec's bounds section
   (memory index lines past the cut).
8. **[minor] The call cap resets on restart.** Accepted and stated.

## ELI10 Overview

The list of my saved memories is cut off after about 117 lines. This picker asks a
fast model which of the cut-off lines matter for the conversation at hand, and logs
its answer. Later it can also show those lines to me. If anything fails, it does
nothing.

## Open items

None blocking. Switching on inject mode is a later, separate decision, taken on the
shadow rows.
