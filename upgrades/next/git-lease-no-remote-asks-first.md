# A machine on a git folder with no remote asks before taking charge

## What Changed
The restart-loop fix from #2912 made a restarted machine ask the other machine before taking charge, when their lease copies are not kept in a shared place. It applied only to the plain lease file. An agent folder that is a git repository with no remote shares nothing either, but it did not get the rule, so after a restart such a machine could take charge without asking while the other was still in charge, and one of them restarted. A git lease store now reports that it shares nothing when it has no remote, and the same rules apply. With a remote, nothing changes.

## What to Tell Your User
If your agent runs on two machines and one keeps its agent folder in git without a remote, the machines could still restart each other now and then. This update stops that.

## Summary of New Capabilities
- None. This fixes a lease bug.

## Evidence
Found live on the test pair nimbus (plain lease file) and proof-2 (git folder, no remote), both on the #2912 build (fb-c51067c6-148 follow-up). After a restart, proof-2 claimed epoch 817 while nimbus held it live. nimbus lost the tie and restarted. Four forced restarts gave two extra restarts. Unit tests in tests/unit/lease-restart-no-tie.test.ts: with no remote it asks, and a live peer lease stops the claim (at a higher number and at its own); nobody answering still claims; with a remote it does not ask; and the remote check is cached. Forcing the new answer off fails five of them. The lease unit, integration and e2e tests pass unchanged, including the flap harness rows.
