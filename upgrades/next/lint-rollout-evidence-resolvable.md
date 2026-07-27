## What Changed

Adds a CI ratchet that fails the build when a spec declares `rollout-disposition: active` with
`rollout-evidence-type: endpoint` and names a `rollout-evidence-ref` whose route does not exist in
`src/`. Wired into the `npm run lint` chain.

A sweep of all 5 rollout-active specs on 2026-07-27 found **2 whose evidence endpoint did not
exist — 40%**:

- `claim-verification-sentinel` → `/completion-claim-verification/stats`, a prefix that never
  existed, while `CompletionClaimVerifier.stats()` sat implemented and called by no route. Fixed in
  #1682.
- `mutual-ssh-autobootstrap` → `/multi-machine/mutual-ssh`. Feature PR #1539 merged 2026-07-21; the
  endpoint never landed with it. Still open (ACT-1398).

Identical effect in both cases: rollout marked active, graduation criterion unevaluable, feature
parked indefinitely — with no error, no alarm, and nothing distinguishing "stuck" from "being
careful".

Ships with an accepted-findings baseline so it passes today. **The baseline can only shrink**: an
entry whose ref starts resolving is an error, forcing deletion, so a stale exemption cannot mask a
later regression at the same path.

**That property was exercised for real before this even landed.** The baseline started with two
entries. #1682 merged an hour later; rebasing onto that main made the lint fail *itself*, naming the
now-resolving `claim-verification-sentinel` entry and refusing to pass until it was deleted. It was
deleted. One entry remains (`mutual-ssh-autobootstrap`), 4 of 5 rollout-active specs resolving. The
self-destruct is not a claim about the future — it has already fired once, on its own author.

## Evidence

The guard was verified by reverting its conditions and watching it fail, because a passing guard
proves nothing:

| case | result |
|---|---|
| drop the mutual-ssh baseline entry | **FAIL**, names spec + ref + remedies, **exit 1** |
| allowlist a slug that DOES resolve | **FAIL**, "now RESOLVES … delete that entry", **exit 1** |
| clean repo | `5 rollout-active endpoint spec(s), 4 resolving, 1 accepted`, **exit 0** |

Exit codes checked directly rather than through a pipe — a lint that prints FAIL and exits 0 is one
CI ignores.

6 tests pass. The load-bearing one asserts the lint **is wired into the lint chain**; another
asserts it reports a non-zero denominator, so a scan of nothing cannot read as a pass.

## What to Tell Your User

Some features are released cautiously — switched on in watch-only mode, meant to start doing
something real once they've proved themselves. Each one's plan names a progress readout to check
before graduating it.

Two of the five features currently in that state pointed at readouts that don't exist. They could
never prove themselves, so they'd have sat in watch-only mode forever. One had been like that since
July 21: the code shipped, the readout didn't come with it.

Nobody noticed because a feature stuck in watch-only mode looks exactly like a feature being
careful — no error, no alarm, just quiet.

Now the build fails if a feature claims to be rolling out and names a readout that isn't there.
Nothing changes for you day to day; it means a feature can no longer ship into a state where
nobody can tell whether it's working.

## Summary of New Capabilities

- The build refuses a rollout-active spec whose evidence endpoint does not exist, so a feature can
  no longer park indefinitely with an unreadable graduation criterion.
- The accepted-findings baseline shrinks only — a fixed instance must be removed from it, so a
  stale exemption cannot hide a regression at the same path.
- The check reports its denominator, so a scan that examined nothing is distinguishable from a pass.
