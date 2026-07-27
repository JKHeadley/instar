<!-- internal-only -->

## What Changed

Adds `docs/audits/topic-29723-convergence.md` — the git-tracked ledger for the recursive
convergence-to-coherence sweep the operator opened over that topic. Rounds 1 and 2 recorded; the
verdict is **NOT CONVERGED**, and the convergence validator refuses the stamp accordingly.

Documentation only. No `src/` surface, no route, no config, no behaviour change.

## Evidence

`node scripts/write-audit-convergence.mjs --audit docs/audits/topic-29723-convergence.md --check`
parses both rounds and exits 1 with:

> `NOT converged: final round (Round 2) must have 0 new findings; found 7 row(s) / line=7`
> `→ an honestly-incomplete audit is fine to commit; it just cannot carry a converged: stamp.`

That is the intended outcome: the ledger is well-formed, every one of its 14 rows carries a valid
closed disposition, and the file is honestly unstamped.

The reason it exists as a tracked file rather than a chat message: the operator has re-grounded that
topic by hand three times, each re-grounding produced its findings in a message that scrolled away,
and the next re-grounding re-derived them. Round 1 was itself published only as a rendered view —
committing the same error it documents.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
