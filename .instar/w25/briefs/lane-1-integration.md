# W25 LANE 1 — THE INTEGRATION CANDIDATE (critical path)

## Your job

Build ONE integration candidate from Window 24's named RELEASE refs, prove it compiles, and run
the FULL test suite against it to zero failures. You are building the thing that will actually be
deployed. Nothing ships without your tree.

## The release contents — exactly these five, no cherry-picking

All live in the live agent home's git repo as local refs. Verified resolving at 21:30Z:

    refs/w24-preserve/lane-a-fix-1          ba83191dd   decision-grading ingress fix (#19)
    refs/w24-preserve/lane-b2               06da09aca   authorship join (Justin's named ask)
    refs/w24-preserve/lane-e-sessions-read  31c971836   /sessions discrepancy probe
    refs/w24-preserve/lane-f-reap-outcome   fb0531785   reap-row exitCode/midWork/outcome
    refs/w24-preserve/lane-a-fix-3          42288487c   lying-instruments repair (#4, #26)

THEN ASSESS TWO MORE, and include each only if it composes cleanly:
    refs/w24-preserve/lane-c                6da049107
    refs/w24-preserve/lane-k                6b7f17a05
If either does not compose cleanly, DEFER IT WITH A WRITTEN REASON. Do not force it.

## EXCLUDED ON PURPOSE — do not merge this, and do not "fix" the tests it breaks

    refs/w24-preserve/lane-b1-repo          1f1dafee4

This is the consumed-only delivery rule. Justin ruled on 2026-08-23 ~18:45Z that current delivery
behaviour STAYS. b1 reverses that ruling, so it is REJECTED for this release — recorded, not
silently dropped. This matters to you concretely: see the next section.

## WHAT W24's INTEGRATION ALREADY LEARNED — do not rediscover it

A W24 worker merged SEVEN branches (the five above plus `c` and `b1`) into a scratch tree and
measured, at 2026-08-23T06:44Z:

- They COMPILE together: `node_modules/.bin/tsc --noEmit` → exit 0, no diagnostics.
- They do NOT agree: **2 tests failed, 163 passed**. Both failures were in
  `tests/unit/TopicLinkageHandler.test.ts`, and both were caused by `b1`'s consumed-only rule
  contradicting two older tests about whether a Telegram fallback counts as delivered.

**So here is your hypothesis, and it is a hypothesis, not a fact:** with `b1` excluded, that
contradiction should be gone and the tree should be clean. PROVE IT OR DISPROVE IT. If those two
`TopicLinkageHandler` tests still fail without `b1` in the tree, that is a DIFFERENT and more
interesting problem — stop and report it rather than adjusting the tests.

**The branches do not share a base — there are four.** Merge order used in W24, which worked:
`fix1 → c → b2 → fix3 → e → f` (b1 removed from that sequence). `fix1`, `c` and `b2` share the
`462e09701` standards lineage, so merging them first introduces that foundation once. You may
choose a different order; if you do, SAY WHAT ORDER AND WHY.

**Two files are touched by more than one branch. These are your real conflicts:**

    src/server/routes.ts       ← fix1, fix3, e   (THREE independent branches)
    src/commands/server.ts     ← f               (b1 was the other; it is excluded now)

Everything else is disjoint. In W24 both files merged additively. One textual conflict occurred
in `tests/unit/standards-coverage-ratchet.test.ts` over `protectedBase: 88 vs 89`; the incoming
comment stated 88/89/89 was its pre-merge state and predicted 89/89/89 after merge, and 89/89/89
was correctly retained. Expect it again and resolve it the same way — but verify the reasoning
still holds rather than copying the answer.

## Where to work

    git -C /Users/dabombstudio/.instar/agents/echo worktree list        # orient first
    Scratch clone: /Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration

Create it by cloning the live repo LOCALLY (`git clone /Users/dabombstudio/.instar/agents/echo
<dest>`) so the preserved refs come with it — VERIFY they did:
    git for-each-ref refs/w24-preserve/ | wc -l     # expect 13
If a local clone does not carry them (they are non-standard refs), fetch them explicitly:
    git fetch /Users/dabombstudio/.instar/agents/echo 'refs/w24-preserve/*:refs/w24-preserve/*'
`node_modules` will not exist in a fresh clone. Symlink the live one rather than installing:
    ln -s /Users/dabombstudio/.instar/agents/echo/node_modules <dest>/node_modules

Base your candidate branch on the same base W24 used (`8e5b0d2c1`) unless you can show a better
one, and say which you chose.

## The bar — all four, in order

1. `exists`: every one of the included tips is an ancestor of your HEAD.
   Control: `git merge-base --is-ancestor <tip> HEAD` exits nonzero for a tip that is NOT in.
2. `wired`: `node_modules/.bin/tsc --noEmit` → exit 0.
3. `effective`: **the FULL test suite, zero failures.** Not just the changed files — W24 ran only
   the 22 changed test files and the charter requires the full suite on the deployed candidate.
   Run it, and report the real number. If the full suite has failures that also exist on the base
   branch, SAY SO and separate them: a pre-existing failure and a failure you introduced are
   different facts, and you must measure the base to tell them apart.
4. Record every conflict and exactly how you resolved it, quoted.

## What you must NOT do

No push, no merge to main, no PR, no deploy, no live-config change, no server restart.
Do not modify any test to make it pass. If a test is wrong, report it; changing it is a decision
above your authority this window.

## Report to

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-1-integration.md` — write as you go.
Include: merge order and why; every conflict and its resolution quoted; the base-branch suite
comparison; the disposition of `c` and `k` with reasons; and an explicit statement of what you
left undone.
