---
title: "A shared signal read by two consumers with opposite polarity cannot be made safe for one without checking the other"
date: 2026-07-30
author: echo
severity: medium
status: open
kind: lesson
tracked-by: ACT-1225
relates:
  - "docs/specs/worktree-read-path-eventloop-safety.md"
  - "docs/findings/2026-07-30-armed-deleter-with-no-evidence-trail.md"
  - "docs/STANDARDS-REGISTRY.md"
---

# A shared signal with opposite polarity

## The rule

**When a signal feeds two consumers that read it in opposite directions, "make it fail
safe" is not a well-defined instruction until you say *safe for which one*.** Hardening it
for one consumer will, by construction, weaken it for the other.

## The instance

`isInUse(path)` answers "is something using this worktree?" Two consumers:

| Consumer | `true` means | Its safe direction |
| --- | --- | --- |
| `AgentWorktreeReaper` (a **deleter**) | KEEP — do not delete | `true` |
| `OrphanedWorkSentinel` (a **detector**) | SKIP — do not flag as abandoned | `false` |

Review found the deleter's version failing *open*: a failed process scan returned an
empty set, indistinguishable from "nothing is using it", clearing a gate on the path to an
irreversible delete. The fix collapsed a failed scan to `true` — correct for the deleter.

It silently blinded the detector. Every worktree became `skip('owner-alive')` whenever the
scan failed, and the route reported `orphanedCount: 0` — "nothing stranded" — on the
surface whose entire purpose is not losing stranded work.

**Note what was false.** Not the skip; skipping on uncertainty is defensible for a
detector too, because a false abandonment claim is also harmful. The false part was the
**reason**: `owner-alive` asserts a live owner that was never observed. The truth was
"liveness could not be determined", and those are different facts that had been collapsed
into one word.

## Why it slipped through

The change that introduced it was made *by the author of the artifact whose closing lesson
reads*: "an interface was widened and its consumers were never audited."

That lesson was written about widening a **type** (`boolean` → `Awaitable<boolean>`) and
missing a consumer. The regression widened a **value** (`boolean` → `boolean | 'unknown'`)
and missed a consumer. Same defect, one layer up, committed within hours of naming it.

The generalisable part is not the carelessness. It is that **naming a failure mode does
not protect you from it — only a check does.** The author had the words and still made the
mistake; a reviewer executing the code found it.

## The fix, and the shape worth copying

Do **not** collapse the third state at the source and hope each consumer wants the same
collapse. Expose the uncollapsed answer and let each consumer collapse it for its own
polarity, with its own vocabulary:

- The signal now exposes `isInUseTriState` → `true` / `false` / `'unknown'`.
- The deleter keeps a boolean `isInUse` that collapses `'unknown'` → `true` (KEEP), with a
  comment at the definition naming the polarity hazard.
- The detector reads the tri-state and emits a distinct `owner-liveness-unknown`, so
  "could not tell" never renders as "nothing here".
- The detector's snapshot carries `undeterminedCount`, so a zero orphan count cannot be
  read as an all-clear when the real answer is that nothing could be determined.

That last point is the same principle as the sibling armed-deleter finding: **an
unanswerable question must be visibly unanswerable, not silently rendered as a negative
answer.**

## The check to build

Type-level collapse of a multi-state answer into a boolean at the *source* is the smell.
Where a signal has more than two states and more than one consumer, the collapse belongs at
each call site, not at the definition.

There is no lint for this today, and the related class — truthiness on an `Awaitable`
union, which recurred once in this same change — has no lint either. Both are currently
guarded by a code comment saying "never do this here", which is the willpower-shaped
remedy that *Structure beats Willpower* rejects. Tracked under ACT-1225 alongside the
reaper's other structural gaps.
