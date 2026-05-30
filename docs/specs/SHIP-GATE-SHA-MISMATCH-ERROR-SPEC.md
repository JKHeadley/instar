---
title: Ship-gate prints the exact sha and a recipe on artifact-sha-mismatch
review-convergence: retrospective-single-pass
approved: true
eli16-overview: SHIP-GATE-SHA-MISMATCH-ERROR.eli16.md
---

# Ship-Gate sha-Mismatch Error Becomes Self-Service

## Problem

`scripts/instar-dev-precommit.js` blocks a commit when the staged side-effects
artifact's sha256 does not match the sha recorded in the trace. The old message
was:

> artifact content has changed since the trace was written (sha mismatch)

It never told the author WHAT sha to write. So the author regenerates the
artifact to "fix" it — but the artifact carries a volatile field (a `Date:`
line), so regenerating changes the bytes, which changes the sha, which still
does not match the trace. The author chases the hash forever. This is a real
non-determinism trap that cost a ~2h grind on 2026-05-30; it bites codex agents
hardest because they tend to regenerate artifacts rather than freeze them.

The hook already computes the correct sha at the moment it reports the mismatch.
It simply was not printing it.

## Scope

Improve the sha-mismatch error to be self-service.

In scope:

- `scripts/instar-dev-precommit.js` — when the sha mismatches, the message now
  includes the recorded sha (truncated), the EXACT computed sha to write, and
  the recipe: set `artifactSha256` to the computed value, re-stage BOTH the
  artifact and the trace, commit fresh (no amend), and do not regenerate the
  artifact (freeze the bytes, hash once).

Out of scope: the broader ship-gate cost for codex agents (LLM-bound steps on a
loaded box) — a larger topic; this closes the single most-painful, concrete
instance.

## Design

The change is strictly to the failure-path message string. The pass/fail logic
is untouched: the sha is still computed the same way and the commit is still
blocked on a mismatch. Only the text printed on a block changes — from a dead end
into a copy-paste fix. The printed sha is the artifact's content hash (not
sensitive).

## Testing

- **Unit** (`tests/unit/instar-dev-precommit-sha-error.test.ts`): a sandbox git
  repo stages a valid evidence bundle (spec + eli16 + artifact + src + fresh
  trace) but with a deliberately WRONG `artifactSha256`. Running the hook
  subprocess: the commit is blocked, and the output contains the EXACT computed
  sha of the artifact plus the recipe phrases (`re-stage`, `do NOT amend`,
  `sha mismatch`). Mirrors the established `runHook` sandbox harness from the
  deferrals test.
- **Regression**: the existing `instar-dev-precommit-deferrals` suite (11 tests)
  stays green — those fixtures use correct shas, so they never hit this branch.

## Risks and non-goals

- No functional/behavioral change — the gate blocks exactly the same commits; it
  only explains the failure better. The worst case is a longer (but accurate)
  error message.
- This is a `scripts/`-scoped change, so it trips the very gate it improves —
  whoever ships it dogfoods the new message, which is the best possible
  acceptance test.
