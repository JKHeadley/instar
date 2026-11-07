# Side-effects review: a machine paired after genesis no longer stops the members

Tier 2. About 5 source files, under 40 lines, plus one integration test. One commit attempt so far. Conversations stays off by default.

## Summary

Pairing a new machine after a graph existed sent the working machines to "Working locally" with no reason, because several checks compared the signed membership with every paired machine. Pairing is transport trust, not membership. Now the signed members keep working and saving, and do not wait on the new machine. The new machine holds no place in the graph until an owner-signed join exists, which is not built yet.

## 1. Over-block

No new refusal for members. A new machine stays refused by the members, because it has no signed place.

## 2. Under-block

A signed member that was removed or revoked still fails these checks, unchanged. Not established: what happens if the unjoined machine wins the native lease. Writes need a lease holder that is a member, so this should fail closed, but no test covers it.

## 3. Level-of-abstraction fit

`ConversationGraphDefault.roster` separates paired machines from signed members. The runtime and frontier checks now ask whether every signed member is still installed under its signed key.

## 4. Signal vs authority compliance

No new authority. This narrows an over-broad check. Sealed records are encrypted to signed members only, so an extra registry entry grants no access. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

Member-loss planning still compares its own roster and is not changed. Machines listed as waiting no longer include an unjoined machine.

## 6. External surfaces

Owners keep the agreed view after pairing a machine. The new machine still says "Working locally. The agreed view is unavailable." with no reason given; a plainer message is still to be added.

## 6b. Operator-surface quality

No dashboard markup changed.

1. Leads with the primary action: unchanged.
2. Zero raw internals as primary content: unchanged.
3. Destructive actions de-emphasized: unchanged.
4. Plain language and phone width: unchanged.

## 7. Multi-machine posture

This is the multi-machine change. Until join exists, a machine paired later holds no Conversations history. That is an open owner decision, asked in topic 137342.

## 8. Rollback cost

Revert. No stored data changes.

## Evidence

New integration test failed before the fix (`graph-runtime-stopped`) and passes after: pair a third machine, commit a change, read it, restore. Regression: peer tests 9, plus owned peer custody, peer frontier and member-loss owned role, as temporary unit copies. One member-loss test had a stale expected message, already failing before this change on the pre-merge copy: a tampered activation is still refused, by the authority check that runs first. The test now expects that message.

## Second-pass review

Not yet reviewed independently.
