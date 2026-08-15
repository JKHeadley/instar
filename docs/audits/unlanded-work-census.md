# Unlanded work census — 2026-08-15

**Why this exists:** Justin, 2026-07-25 —

> *"I feel like instead of trying to expand we need to stop slow down and
> consolidate and converge and heal"*

This is that instruction turned into a number.

## The measurement

Across my own agent home (`~/.instar/agents/echo/.worktrees/`):

| | count |
|---|---|
| worktrees | 56 |
| with commits ahead of `origin/main` | 44 |
| ...whose content is genuinely not in main | **44** (0 squash-merged) |
| ...**with no open PR** | **43** |
| with uncommitted changes | 20 |
| open PRs on the repo | 15 (only **1** matches a local worktree) |

**43 branches carry work that has no path to landing.** Not blocked, not in
review — simply never opened. Oldest dated 2026-06-04.

Heaviest, by commits:

| branch | commits | last touched |
|---|---|---|
| `echo/option-c-degraded-tier` | 23 | 2026-08-04 |
| `echo/memory-pressure-metric-sibling` | 15 | 2026-08-04 |
| `pr1463-approve` | 13 | 2026-07-28 |
| `echo/quiet-settings-overlay` | 11 | 2026-07-13 |
| `echo/telegram-invisible-payload-guard` | 10 | 2026-08-12 |
| `agent-signature-provenance` | 10 | 2026-08-15 (today — mine) |
| `echo/window14-decision-package-application` | 7 | 2026-08-13 |

Largest uncommitted piles: `echo-grok-build-integration` (93 files),
`authorship-provenance` (56 — at the operator's approval gate, deliberately
untouched), `item1-verify` (25), `reaper-enum-fail-closed` (20).

`guard-effectiveness-observability` shows 190 commits / 331 files, which almost
certainly means it is tracking a stale base rather than holding 190 commits of
novel work — flagged as a data question, not counted as a finding.

## How this was measured, and what it does NOT prove

- **Content, not commit counts.** A squash-merge leaves commits "ahead" whose
  content is already in main. I diffed `origin/main...HEAD` per branch and kept
  only those with a non-empty file list. Zero turned out to be squash-merged, so
  the 44 is real rather than an artefact of counting commits.
- **PR state came from the GitHub API**, cross-referenced on each worktree's
  actual branch name (directory names differ: `fix-lease-poll…` vs
  `fix/lease-poll…`). Matching on directory names would have inflated the
  abandoned count.
- **The limit, stated:** "content differs from main" proves the branch is
  **unlanded**. It does not prove the *work* is missing — main may contain a
  later, different implementation of the same idea, done on another branch. This
  census measures unlanded branches, not lost capability. Establishing which of
  the 43 are genuinely still-wanted requires reading them, which this does not do.
- Two entries report branch `HEAD` (detached worktrees) and are counted but not
  individually named.

## Why it matters

This is the expansion pattern, quantified. Each of these branches represents work
that was built, tested, committed — and then left. The cost is not the disk
space; it is that **finished work provides no value until it lands**, and every
one of these was at some point somebody's priority.

It also explains a shape seen elsewhere today: my own ASP branch is #6 on that
list within hours of being created. The reflex that produced 43 abandoned
branches is the same reflex that would have produced a 44th today.

## Triage: which of them could still land today

Merge-tested each stranded branch against current `main` (read-only, no working
tree touched):

| | count |
|---|---|
| **still merges cleanly** | **9** (8 excluding today's own branch) |
| needs conflict resolution | 35 |

The clean nine are small and recent — mostly single-commit branches from
2026-08-14:

| branch | commits | last |
|---|---|---|
| `echo/sync-spawn-alias-resolution` | 1 | 2026-08-14 |
| `echo/claimcheck-absence-is-not-zero` | 1 | 2026-08-14 |
| `echo/native-module-health-banner` | 1 | 2026-08-14 |
| `echo/destructive-lint-local-bindings` | 2 | 2026-08-14 |
| `echo/tmux-send-lint-multiline` | 1 | 2026-08-14 |
| `echo/topic-creation-lint-resolution` | 1 | 2026-08-14 |
| `echo/grok-build-integration` | 1 | 2026-08-14 |
| `echo/three-queues-verification-gap` | 1 | 2026-07-30 |

**This sharpens the finding.** "43 stranded" is the headline, but 8 of them carry
no technical obstacle whatsoever — they would land today untouched. Those are
pure omission. The other 35 have drifted far enough from main to need real work,
and for the oldest the honest question is whether the premise still holds at all.

### A broken probe, caught by uniformity

The first merge-test returned **0 clean / 44 conflicted**. That is implausible on
its face: my own branch was cut from current `main` hours earlier and must merge
cleanly. Uniformity across every row is the signature of a broken instrument, not
a finding.

Cause: `git merge-tree` was invoked with two arguments, which the old three-arg
form (base, ours, theirs) silently misreads. Both correct forms — the three-arg
version with an explicit merge-base, and `--write-tree` — report my branch clean.
Re-run with `--write-tree`, the real split is 9/35.

Had I reported the first number, the conclusion would have been "all 44 have
rotted beyond easy recovery" — the opposite of the truth for eight of them, and
an argument for abandoning work that is one merge away from landing.

## What I did NOT do

I did not open PRs, delete branches, or rebase anything. Landing 43 branches in
bulk would be the same error in the opposite direction — and several are old
enough that their premise may have expired, which is a reading task per branch,
not a batch operation.

The useful next step is triage, not action: for each branch, one of *still
wanted → open a PR*, *superseded → delete*, *premise expired → delete and record
why*. That decomposes cleanly and is good delegable work.
