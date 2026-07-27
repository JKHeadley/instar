# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`runRound`'s `verifyMergedItems` seam defaulted to a no-op returning an empty set, documented in
place as "production callers should pass a real one". No production caller ever did —
`src/commands/server.ts` passes tracker, projectId, roundIndex and targetRepoPath, and nothing else.

Consequences, all read from the code: the all-items-merged stop condition could never be true, so a
round whose items were **all merged still spawned a child to redo them**; `outcome: 'complete'` was
unreachable; and because the progress digest counts only completed rounds, a project could report
`0 of 5 done` with its items merged and verified.

The no-op default is deleted. The seam now defaults to the real `verifyMergedItemsViaGit`, carries
the three-state `MergedVerificationResult`, and a new `unverifiable` outcome records **no** round
status. `resolveCanonicalMainRef` moved from `src/server/routes.ts` into the core module both
consumers share.

## Evidence

Live: project `convergence-towards-coherence` had items 1, 2 and 3 at `pipelineStage: merged`
(item 3 verified against merge commit `3443efd1d`) while the session-start digest read `0 of 5 done`.

Refusals, by falsification. Neutralising the evidence predicate:

```
× an item that RECORDS a merge commit but cannot be checked → no respawn, and NO round verdict
× child exits 0 but the shortfall is entirely uncheckable → unverifiable, NOT partially-complete
```

Re-introducing a default that returns an unconditional empty verdict:

```
× the seam cannot default to silence again > has no default verifier that returns an unconditional empty set
```

Restored: 27/27 across the three affected files; `tsc --noEmit` exit 0.

## Known limits

Verification is still merge-base reachability of a recorded commit — an item merged with red CI
verifies. Nothing here schedules rounds; it makes a run able to conclude. And
`resolveCanonicalMainRef` remains best-effort: without `gh` it falls back to `origin/main`, which on
a fork-origin home under-verifies toward spawning rather than toward a false complete.

## What to Tell Your User

A round of project work can now actually be recorded as finished.

The piece that checks "has this work landed?" was a placeholder that always answered "nothing has
landed". Nothing failed visibly — it just quietly always said no. So a round could never be marked
complete, your progress line could read "0 of 5 done" while the work sat merged, and asking the round
to run again would start a fresh session to redo work already finished.

It now uses the real check. And when the check genuinely cannot run, it says so rather than guessing:
it will not start a session to redo work that may already be done, and it records no verdict at all
rather than claiming the round failed.

The distinction that took the most care: "no merge recorded yet" and "there is a merge but I couldn't
check it" look identical in the data and mean opposite things. Read the first as unknown and every
new round stalls forever; read the second as not-done and you are back to redoing finished work.

## Summary of New Capabilities

No new endpoint, command, or config key. An existing round runner gained a working merged-state check
and an honest "could not determine" outcome that records nothing instead of inventing a verdict.
