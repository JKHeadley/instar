# Side-Effects Review — ask the worktrees which repo owns them

**Version / slug:** `worktree-repo-discovery`
**Date:** `2026-08-14`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1: pure addition with NO caller, therefore no runtime behaviour change on any agent. The consuming wiring is deliberately NOT in this change (see "What is deliberately not here").`

## Summary of the change

Adds two exported helpers to `src/core/AgentWorktreeDetector.ts` and one option on
`resolveDetectorInstarRepo`:

- `parseWorktreeGitPointer(contents)` — `gitdir: /repo/.git/worktrees/<slug>` → `/repo`, or null for anything
  that is not exactly that shape.
- `discoverInstarRepoFromWorktrees(roots, {maxWorktrees})` — reads each worktree's `.git` POINTER FILE under
  the given roots and returns the owning repo roots, ordered by how many worktrees name each.
- `ResolveDetectorRepoOptions.worktreeRoots` — when a caller passes ITS OWN `.worktrees` root(s), the
  discovered repos join the candidate chain after the operator-supplied `worktree.repoPath` and before the
  conventional-location guesses. Omitted ⇒ no candidates ⇒ byte-identical behaviour.

**Nothing calls it yet.** This lands the mechanism, verified, with the consuming wiring held back.

## Why it exists (observed, not hypothesised)

On a live agent, 2026-08-14: `GET /worktrees/agent-reaper` reported `enumerationOk: false`,
`enumerationFailures: 98`, error `git -C <agent home> worktree list --porcelain → fatal: not a git
repository` — while 45 worktrees and **27 GB** sat under that agent home.

Two blind spots, both a path assumed rather than resolved. `resolveDetectorInstarRepo` guessed at
`~/Documents/Projects/instar` and `~/instar`; neither exists there, so it returned null and the detector's
`if (repo)` guard silently skipped every tick. Separately the reaper was wired to `config.projectDir`, which
on that layout is the agent home and is not a repo at all.

The answer was on disk the whole time: a linked worktree's `.git` is a file naming its owning repo. This is
also the same defect class the reaper's own header records for 2026-07-29 — *"the reaper reported
`reclaimable: 0` against 73 worktrees because `git -C <path> worktree list` was failing outright."* That fix
made the failure VISIBLE (`enumerationOk` / `reclaimable: null`), which is how this was found; it did not make
resolution work.

## Decision-point inventory

- `parseWorktreeGitPointer` — ADD — pure function; returns null on anything unrecognised.
- `discoverInstarRepoFromWorktrees` — ADD — filesystem reads only, bounded by `maxWorktrees` (default 200).
- `ResolveDetectorRepoOptions.worktreeRoots` — ADD — inert unless passed.
- No runtime block/allow decision added or modified. No caller changed.

## 1. Over-block

Not applicable in the gate sense (nothing is blocked), but the analogous failure is **naming a wrong repo**,
and one real instance was caught during development and is now pinned by a test:

The first draft defaulted the discovery roots to `enumerateSafeRoots()`. That helper enumerates EVERY agent
home on the machine, so the agent asking the question resolved to a **different agent's repo** — whichever
owned the most worktrees. Measured on the real box: `echo` resolved to `instar-codey/repo`. A confident wrong
repo is strictly worse than the null this change removes — null makes a consumer skip, a wrong repo makes it
act. The API now has NO default: a caller must name its own root, documented on the option itself, and a test
asserts resolution takes no worktree candidate when none is named.

Other non-answers all return null/empty rather than a guess: a full clone under `.worktrees/` (its `.git` is a
directory, not a pointer), a malformed pointer, a submodule gitdir with no `/.git/worktrees/` segment, a
directory with no `.git`, an unreadable file, a missing root.

## 2. Under-block

**One agent's `.worktrees/` can legitimately hold worktrees of MORE THAN ONE clone of the same upstream.**
Measured on the agent that surfaced this: 29 worktrees owned by `<home>/.build/instar` and 17 by
`<home>/.dev/instar`. The helper returns BOTH, most-owned first; it does not merge them. A single-repo
consumer that takes only `[0]` therefore gets the largest coherent set and still will not see the smaller
repo's worktrees. That is an improvement over enumerating nothing and it is not full coverage — stated in the
function's own doc comment rather than left to be discovered.

Also unchanged: `resolveInstarRepo` still integrity-validates every candidate, so a discovered path that is
not a valid instar repo is rejected exactly as before.

## 3. Level-of-abstraction fit

Filesystem reads in a module that already does filesystem enumeration (`enumerateSafeRoots` next door).
**Deliberately no subprocess** — reading the pointer file is cheaper than `git rev-parse`, cannot block the
event loop, and keeps the helper usable from the runtime hot dirs where `lint-no-blocking-process-scans`
applies.

## 4. Signal vs authority compliance

The helper produces CANDIDATES, never an authority. Every candidate is still validated by `resolveInstarRepo`
before anything believes it. An operator-supplied `worktree.repoPath` continues to win outright.

## 5. Interactions

- `resolveDetectorInstarRepo()` with no `worktreeRoots` is byte-identical to before — verified by the existing
  detector suites (19/19 green, unmodified).
- No consumer passes `worktreeRoots` in this change, so no runtime path changes on any agent.

## 6. External surfaces

None. No HTTP route, no config key, no user-visible message. Not an agent capability, so the Agent Awareness
Standard does not apply.

## 7. Rollback cost

`git revert` of one source file plus one test file. No migration, no state, no deployed artifact, and — since
nothing calls it — no behaviour to restore.

## What is deliberately NOT here, and why

The consuming wiring (pointing `AgentWorktreeReaper` and `OrphanedWorkSentinel` at the resolved repo instead
of `config.projectDir`) is **held back for a Tier 2 spec + operator approval.** It is runtime code feeding a
guard with delete authority, and the cross-agent misresolution above is direct evidence that getting
resolution wrong here is easy. Landing the mechanism first makes that follow-up a small, focused, individually
reviewable diff. It is registered as a commitment, not an intention.

## Conclusion

Ship. Verified mechanism, zero runtime effect, one real misresolution caught during development and pinned by
a test.

## Evidence pointers

- `tests/unit/agent-worktree-repo-discovery.test.ts` — 14/14 green.
- Existing detector suites unmodified and green: `AgentWorktreeDetector`, `-attention-wireup`,
  `WorktreeEnumerationFailureStore` — 19/19.
- Full `npm run lint` chain green; `tsc --noEmit` clean.
- Real-machine measurement: with the caller's own root, discovery returns
  `[<home>/.build/instar, <home>/.dev/instar]` (29 and 17 worktrees respectively); with no root, resolution
  returns null exactly as before.
