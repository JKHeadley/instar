# Convergence Report — Topic worktrees: stop the stale locks, and measure what is safely reclaimable

## Cross-model review: codex-cli:gpt-6-astra

The GPT-tier review ran in all six rounds, through the codex CLI with model gpt-6-astra. A clean-door Claude read also ran in every round (claude-code, claude-opus-5-5); it is a second read, not a cross-model opinion. Gemini is not signed in on this machine and did not run. In every round, an internal reviewer read the spec against the source on `origin/main` (d61d6173b) and against the real `.instar/worktrees` on the Studio (read-only). It covered these lenses: security, scalability, adversarial, integration, decision classification, Verify the State, Self-Heal, decision completeness, and the foundation the spec builds on.

## ELI10 Overview

When an agent works on code for a conversation, Instar gives it a private working copy of the code, called a worktree. Nothing ever cleans these up. On the Mac Studio there are 101 of them, part of about 70 GB.

The first design simply turned on a cleaner. Review found that this would not be safe, and would also clean almost nothing:
- Instar leaves its own files in every copy, so nearly all of them look as if they hold unsaved work.
- Some copies with a conversation-style name were made by hand.
- Copies link into each other, so removing one can break another.
- The existing cleaner froze the server for about 45 seconds each time it ran. That fix shipped separately and first, as PR 3449.

So this phase removes nothing. It does four things:
- clears the "in use" notes when a conversation ends, and at server start for conversations that are no longer running;
- gives both cleaners one map of which copies link into which, and fixes three hidden bugs in the existing cleaner;
- marks copied library folders, so a later cleaner can tell them apart from real work;
- measures, off the server, how much could safely be reclaimed, and double-checks each "safe" verdict a second way.

Actual removal is phase 2 (CMT-1958), built on those numbers.

## Original vs Converged

- **The spec was cut from "reclaim" to "stop the leak and measure."** Round 1 found six independent ways removal could misjudge or race:
  - the residue files;
  - provenance;
  - the links between copies;
  - creation races;
  - binding deletion;
  - the main-thread cost.

  It also found that only about 18 of 101 copies would even read as clean. Measuring first costs one release and shows whether removal is worth that machinery.
- **The locks.** The first draft swept expired locks at start. Two reviewers independently found that `signTrailer` uses the lock map without a liveness check, so a sweep would break commit signing for sessions that survive a restart. Now:
  - a lock is released when its session ends and its tmux session is gone;
  - at start, only locks whose session has no running record are released;
  - an unreadable or malformed record keeps its lock;
  - only a deletion that succeeds, or finds the file already gone, counts as released.
- **The existing cleaner's freeze** was part E for two rounds. The Chief of Staff moved it out, separately and first: PR 3449.
- **Three latent bugs in the running cleaner** are now fixed here:
  - a removal failure emits Node's special `'error'` event with no listener, which would crash the pass;
  - merged PRs into any branch counted as merged into main;
  - the index-lock check could never fire in a linked worktree.
- **The audit** went from a stability count to a complete outcome table:
  - for an ancestor, the result is independent;
  - for a squash merge, it is corroborated by patch-id;
  - for a branch that is patch-equivalent with no PR, it is "could not verify".

  Only a real disagreement counts as a false eligibility.
- **D's budget** moved after the whole-disk walk, so that walk keeps exactly today's budget. D's rows persist entry by entry.

## Iteration Summary

| Round | Standards-Conformance Gate | Material / design findings | Outcome |
|---|---|---|---|
| 1 | ran (3 flags) | codex 2, clean-door 4, internal 9 | cut to measure-first |
| 2 | ran (4 flags) | codex 4, clean-door 5, internal 0 | locks: no start sweep; tri-state audit |
| 3 | ran (4 flags) | codex 2, clean-door 2, internal 3 (all on part E) | E reworked, then moved out |
| 4 | ran (3 flags) | codex 3, clean-door 2, internal 2 | orphan-lock release; index lock; budget |
| 5 | ran (2 flags) | codex 2, clean-door 2, internal 1 | patch-id audit; budget clamp |
| 6 | ran (2 flags) | codex 2, clean-door 1, internal 0 | release on confirmed unlink; complete audit table; D after the whole-disk walk |

Findings fell from 15 design points in round 1 to 3 narrow ones in round 6, and each of those has a concrete fix that is now applied. The two flags the gate still raises are named below.

## Proportion

This is a Tier 2 change: it touches lock lifecycle and adds a measurement, and it removes nothing. The review weight matched that. Removal, the irreversible part, was deferred so this phase could be proven first.

## Left behind (accepted, with reason)

- **Judgment-floor numbers.** The 20 targeted lookups and the result-writing reserve are starting values. D reports the lookups and time it used and whether the reading is `partial`, so phase 2 sets them from data.
- **Known lock-release limits.** Two server processes overlapping during a restart, and a server that crashed between `new-session` and `saveSession`, can each release a lock a live session still needs. The cost is that session's commit trailer failing to sign; nothing is lost.
- **Lock takeover after 60 s.** Because nothing heartbeats, a second `resolve()` can take over a live session's worktree. This is filed as its own bug (fb-863304b6-8ae), and its fix (a lease with a heartbeat) is named under Alternatives.
- **Links nested deeper than depth 3,** and links created during a pass. Phase 2 must close these before any removal.

## Experience fit

The operator's outcome is "the Studio's disk stops filling with old copies". This phase stops the lock files piling up and measures the safe reclaim. It does not free the existing 70 GB, and the spec says so plainly. The operator is not asked for anything: the Chief of Staff approves the design, and the development agent decides the phase 2 step from the measured numbers.

## Chief of Staff fold-ins (approval 2026-11-18, msg 5ecf7d6f)

Approved to build (a maintainer approval, not a constitution change), with three fold-ins taken from the constitution check run at 18:41Z. All three are applied:
1. **Verify the State, Not Its Symbol.** The start-time lock release no longer trusts the session record alone. It also requires that no live tmux pane is working inside the worktree. A failed tmux read keeps every lock.
2. **Judgment Within Floors.** D's reserve is now a fixed 60 s, with its reason: D's longest bounded step is a 30 s `git` or `gh` call that may be in flight at the deadline, plus the result write and process exit.
3. **Maturation Path.** D ships dark and dev-only, behind `monitoring.diskSteward.topicWorktreeMeasure` on the dev-agent gate, with a ladder entry that graduates it on its own numbers.

## Constitution re-check after the fold-ins (2026-11-18, 18:4x Z)

The re-run raised 3 flags, all applied:
- **The startup restart race** is narrowed by the live-pane check. Both known windows are now stated.
- **The 30 s step timeouts** are the existing reaper's defaults, reused unchanged. That is now stated.
- **D's test-agent rung** now includes one live disk-steward run on a throwaway agent, before the development agent.

A second re-run raised 2 flags. Both are accepted, with their reasons:
- **The residual overlapping-server spawn race.** The release can only land in the moment between the lock write and the pane opening. The cost is one session's commit trailer failing to sign, and nothing is lost.
- **The inherited 30 s per-call timeouts.** D reuses the existing reaper's timeouts unchanged, and a call that times out reads as keep or `partial`. Adaptive budgeting is left to phase 2 (CMT-1958), with D's measured call times in hand.

## Approval

Approved by the Chief of Staff, msg 5ecf7d6f, with the three fold-ins above.
