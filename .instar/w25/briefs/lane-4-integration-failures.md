# W25 LANE 4 — THE TWO INTEGRATION-INTRODUCED FAILURES

## What is already established — do not re-derive it, build on it

The integration candidate is at `/Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration`,
branch `w25-lane-1-integration-candidate`, HEAD `70e896ab4`. It merges seven preserved refs in this
order: `fix1 → c → b2 → fix3 → e → f → k`. It compiles clean.

The orchestrator ran the FULL suite on it (1862s, 49,882 tests) and measured:

    Test Files  2 failed | 3161 passed | 4 skipped
    Tests       2 failed | 49847 passed | 30 skipped | 3 todo     EXIT=1

Both failures were then compared against the base worktree at
`/Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/base-8e5b0d2c1` (`8e5b0d2c1`), IN THE
SAME ENVIRONMENT as the candidate run:

**Failure 1 — `tests/unit/no-silent-fallbacks.test.ts`**
    candidate: AssertionError: expected 498 to be less than or equal to 496   (line 434)
    base:      5 passed. PASSES.
This is a RATCHET. The merge introduced 2 silent fallbacks beyond the tracked baseline of 496.

**Failure 2 — `tests/e2e/session-management-e2e.test.ts`**
    "should handle sessions that crash during startup"
    candidate: waitFor timed out after 5000ms — reproduced TWICE in isolation, 5125ms each
    base:      PASSES in 365ms
Not a flake. Not environmental. Reproducible.

So both are genuinely introduced by composing branches that were each green alone. This is the
exact thing integration exists to catch, and it is now your job to find which merge did it.

## Your job

For EACH failure, determine WHICH of the seven merged refs introduces it, then fix it properly.

Bisect by rebuilding the candidate incrementally in a SEPARATE scratch tree — do not mutate the
existing candidate while you are bisecting. Start at `8e5b0d2c1`, merge the refs in the recorded
order, and run the relevant test after each merge. Seven steps. The unit test takes under a second;
the e2e test takes about 90 seconds when run alone with `-t`, so this is cheap.

    git switch -c <your-branch> 8e5b0d2c1
    git merge --no-edit refs/w24-preserve/lane-a-fix-1     # then test
    ...

Refs, in candidate merge order:
    lane-a-fix-1, lane-c, lane-b2, lane-a-fix-3, lane-e-sessions-read, lane-f-reap-outcome, lane-k

A hypothesis to test rather than assume: `lane-f-reap-outcome` changes how a session's self-exit is
recorded, and failure 2 is about a session that crashes during startup. That is suggestive, not a
finding. Two refs may also interact so that neither alone causes it — if the failure only appears
after a specific PAIR, say so, because that is a more interesting result than a single culprit.

## HOW YOU MAY NOT FIX THEM

- Do NOT raise `BASELINE` in `no-silent-fallbacks.test.ts` to 498. That test exists to stop exactly
  that move. If after real investigation you believe the two new fallbacks are correct and the
  baseline genuinely should rise, STOP AND REPORT with the two specific fallbacks named and the
  argument for each. That is a decision above your authority, not an edit.
- Do NOT raise the 5000ms timeout to make failure 2 pass. A test that passes because it waited
  longer has measured nothing. Find out WHY the wait is no longer satisfied.
- Do NOT skip, mark todo, or delete either test.
- Do NOT modify the excluded `lane-b1-repo`, and do not merge it.

The honest fix is to the code that changed the behaviour. If the behaviour change is correct and the
test encodes a stale expectation, that is a report, not an edit.

## Identify the two new fallbacks concretely

For failure 1, the test enumerates silent fallbacks. Get the actual LIST on base and on candidate
and diff them, so you name the two additions rather than reasoning about the count. A count told us
something is wrong; the diff tells us what.

## The bar

Every verdict cites its measurement (command, salient output, hostname, ISO-8601 UTC timestamp),
and names a control that could have shown otherwise. When you believe you have a fix:
- the specific failing test passes on your branch
- it still FAILS with your fix reverted (the must-fail control — prove it)
- the FULL suite is re-run and you report the real aggregate, read from the vitest summary line
  and the process exit code, not from a wrapper's exit code

That last point is not pedantry: the orchestrator's own background wrapper reported exit 0 while
vitest had exited 1, because the wrapper's status came from the last command in the chain. Read
`EXIT=` and the `Test Files` line, and quote both.

## What you must NOT do

No push, no merge to `main`, no PR, no deploy, no live-config change, no server restart.

## Report to

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-4-integration-failures.md` — write as you
go. Include: the bisect table (ref → test result after merging it), the named culprit for each
failure, the two silent fallbacks by name, your fix and its must-fail control, and the full-suite
aggregate with its exit code.
