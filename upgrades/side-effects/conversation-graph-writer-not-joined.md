# Side effects: say which machine a change waits on when the lease holder has not joined

## What changed

Tier 1, 4 source files plus one dashboard file, about 15 lines (CMT-1437 item 2).

The graph writer role follows the fleet's native lease. When a paired machine that is not a signed graph member holds that lease, a member cannot promote an owner change (it does not hold the lease) and does not forward it (the holder is not a member), so the change stays `recorded-local` with nothing saying why.

Options considered:

- Stop a non-member from taking the lease: the lease is fleet-wide (messaging, jobs, everything else), so this would change unrelated behaviour on every agent. Not minimal and not safe.
- Route changes to a member: graph records are fenced to the native lease epoch and signed lease bridge, so a member without the lease cannot write. That needs a separate graph-writer lease, which is a design change.
- Surface the reason (chosen): the change keeps waiting exactly as before, and the owner sees which machine it waits on.

What this adds:

- `ConversationGraphReplicationRuntime.writerOutsideMembership()`: the lease holder when it is paired, not this machine, and not in the installed membership.
- `ConversationGraphDefault.writerOutsideGraph()`: the same against the roster (signed members, or the genesis choice before a graph exists), for the pre-genesis local queue.
- `blockedBy:{reason:'writer-not-joined',machine:{machineId,name}}` on every `recorded-local` change reply: change status, the pending list, the create reply, and the pre-genesis local queue.
- The forwarding step reports `graph-writer-not-member` through the existing internal degradation report instead of returning silently.
- Dashboard wording for a recorded-local change with that reason: "Mac Mini is in charge of your machines right now and has not joined Conversations, so this change waits until a joined machine (M5) is in charge again."

## Decision point

No new decision. The change still waits where it waited; only a reason is added. Signal only.

## Review

1. **Over-block:** none; nothing new refuses.
2. **Under-block:** the lease can sit on a non-member indefinitely; this names it but does not move it. The mitigation is the existing preferred-awake-machine lease setting (`multiMachine.leaseSelfHeal.preferredAwakeMachineId`), which ships dark or dry-run. Joining that machine is the later join work.
3. **Level of abstraction:** the reason comes from the runtime that makes the forwarding decision, so the reply and the decision use the same membership.
4. **Signal vs authority:** a signal on an existing reply (`docs/signal-vs-authority.md`). No authority.
5. **Interactions:** `blockedBy` is a new optional reply field. The dashboard model only reads it for the wording; older dashboards ignore it. `reason` (refusal code) is untouched.
6. **External surfaces:** one new optional field on owner-only change replies; new wording on the owner's Conversations page.
7. **Multi-machine posture:** proxied-on-read: each machine reads the live lease holder from its own lease coordinator when answering.
8. **Rollback cost:** revert the commit. No state.

## 6b. Operator-surface quality

1. **Primary action first:** the status line names the machine it waits on, in the same sentence that says the change is not yet saved.
2. **No raw internals:** machine names only; no reason codes shown.
3. **Destructive action de-emphasized:** no new action.
4. **Plain language at phone width:** one sentence added to an existing status line; not checked in a real browser in this change.

## Evidence

- `tests/integration/graph-default-nonmember-paired.test.ts`: two signed members plus a paired outsider, real HTTP. A change commits with no `blockedBy`; with the lease reported on the outsider, a new change is `recorded-local` (202) with `blockedBy` naming the outsider on create, status and pending; with the lease back on a member the field is gone.
- `tests/unit/console-conversations-v2.test.ts`: wording names the machine and the joined machines; an unknown reason adds nothing.

## Second-pass review

One fresh Claude reviewer, read-only, from the diff: concur. Surfacing is the right minimal choice; re-routing around the lease fence or restricting the lease would give a membership signal authority. Lower notes: the report repeats on every reconcile pass while the outsider holds the lease (same as the existing forwarding-pending report); before genesis, `writerOutsideGraph()` uses the roster, so a signed member later unpaired would read as "not joined" there, while change replies after genesis use the installed membership.
