# Side effects: choosing which machines a new graph signs

## What changed

- `multiMachine.conversationGraph.genesisMembers`: an optional list of machine ids to sign when the graph is first created. Absent means every paired machine, as before. It has no effect once a graph exists.
- A machine left off the list will not start a graph, and reports the existing "not joined" state.
- Before a graph exists, every paired machine is still asked whether one already exists, so a machine with a different list cannot start a second graph. A left-out machine that is simply unreachable does not hold up the chosen ones.
- `OwnedGraphCustody`: genesis may name fewer machines than are paired. Each one it names must still be installed under its signed keys.
- `GraphCustodyJoinIntent.graphJoinAddition`: the rule for what counts as adding one machine. Tested, not yet used.

## Decision point

Yes: who becomes a member. It is a local configuration choice, read only at creation. The signed publication and the owner's key remain the authority, so the list grants nothing by itself.

## Review

1. **Over-block:** a chosen list naming a machine that is not paired refuses to start. A listed machine that is asleep holds up genesis, as today.
2. **Under-block:** two machines with different lists fail closed but need one corrected by hand. If another machine with a different list is unreachable at creation, it cannot be asked, so a second graph is possible once it comes back with its own list and the lease. This needs a misconfigured list on that machine.
3. **Level of abstraction:** in the Default's roster, the single place that decides membership before a graph exists.
4. **Signal vs authority:** no brittle check gains authority. Refusals are structural and fail closed.
5. **Interactions:** the guard runs only where a graph would be started, so a left-out machine can still boot cleanly.
6. **External surfaces:** one new optional config field. No default changes, so no migration is needed.
7. **Multi-machine posture:** per-machine config, not replicated. The list must be set on each chosen machine. This is the main operational cost.
8. **Rollback cost:** revert. A graph already created with a chosen list keeps its signed membership, which is independent of this code.

## Known limits

If the lease moves to a left-out machine, members keep their data and changes wait as recorded-local, but nothing commits until a member holds it again. The owner sees no reason today. This is the same limit as a machine paired later, but a left-out machine can hold the lease from day one.

## Evidence

Real two-machine fixture over real HTTP: left-out machine refuses, unknown machine refuses, chosen pair commits with a third machine paired and asleep, the choice stops mattering after genesis, and disagreeing lists do not produce a second graph. 33 tests pass with neighbours, run as unit copies on the Studio.

## Not established

Real machines. Journal and `ReplicatedStoreReader` effects with a left-out machine. Tail closure after the lease returns from a left-out machine. The full suite on this code.

## Second-pass review

One fresh Claude reviewer, read-only, nothing run. One high finding: discovery asked only listed machines, so a machine with a different list could start a second graph. Fixed. One high availability finding, the lease limit above, is recorded rather than fixed. Boot refusal, the empty-list path, dead code and weak join-field comparison were fixed. The fixes have not had a further read.
