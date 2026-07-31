<!-- bump: patch -->

## What Changed

The correction-learning analyzer can now recognize recurring paraphrases
without changing the exact stored identity of any correction. It groups only
same-kind records at a measured normalized-token similarity floor of 0.65, then
applies the existing support and day requirements across the cluster.

Preference promotion now requires distinct sessions instead of distinct topics.
The occurrence ledger records session ids for new events and safely adds the
nullable field to existing databases. Unknown historical session provenance
cannot count toward promotion.

The analyzer job remains off by default.

## What to Tell Your User

Instar can now connect strongly similar corrections that were phrased
differently, while still requiring the pattern to recur on different days and
in different sessions before learning it as a standing preference.

## Summary of New Capabilities

- Same-kind analyzer-time correction clustering with immutable ledger keys.
- Session-diversity recurrence evidence, including exact-wording repeats.
- Atomic pre-effect cluster lifecycle and cluster-scoped recurrence verification.
- A read-only corpus replay tool that reports cluster and gate outcomes without
  printing learning text.

## Evidence

- Focused analyzer, ledger, driver, wiring, and route suite: 79 tests passed.
- TypeScript build completed successfully.
- Read-only replay of the live 37-row corpus produced three compact same-kind
  groups (3, 2, and 3 records) at 0.65 and zero promotions because each lacks
  support, day, and session evidence. This is the correct conservative result.
- Boundary tests cover at/below similarity 0.65 and at/below session diversity;
  bridge, sibling-recurrence, and OCC-conflict regressions pin the safety edges;
  a migration test proves an exact key can accumulate distinct sessions without
  changing its identity.
