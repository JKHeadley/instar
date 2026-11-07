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

Owners keep the agreed view after pairing a machine. A new machine refused by a reachable peer now says it has not joined and that changes stay on it. That wording has unit coverage only; no real third machine has shown it.

## 6b. Operator-surface quality

One status line changes wording on the local-only screen.

1. Leads with the primary action: yes, unchanged; Create effort stays available.
2. Zero raw internals as primary content: yes. The line is a plain sentence.
3. Destructive actions de-emphasized: yes, unchanged.
4. Plain language and phone width: yes in wording; the line wraps as the old one did. Not rendered at phone width with this wording.

## 7. Multi-machine posture

This is the multi-machine change. Until join exists, a machine paired later holds no Conversations history. That is an open owner decision, asked in topic 137342.

## 8. Rollback cost

Revert. No stored data changes.

## Evidence

New integration test failed before the fix (`graph-runtime-stopped`) and passes after: pair a third machine, commit a change, read it, restore. Regression: peer tests 9, plus owned peer custody, peer frontier and member-loss owned role, as temporary unit copies. One member-loss test had a stale expected message, already failing before this change on the pre-merge copy: a tampered activation is still refused, by the authority check that runs first. The test now expects that message.

## Second-pass review

Fresh Claude reviewer, read-only: withheld on the first version. Fixed: the restart check in `OwnedGraphCustody` (the test now does a real fresh start, and failed with the old check); member key compared as well as id, so a re-paired machine with a new key is not treated as a member; `roster()` and `awaitingJoin` cannot throw on unreadable evidence. The fixed version has not had a second independent read.

Known limits, tracked as CMT-1437 (this note first said ACT-607, an id that was never registered): a machine paired later blocked member-loss planning until unpaired, since fixed; if it wins the native lease, member writes stay recorded-local with no reason shown (inferred, untested); a crash between pin and publication marker while a new machine is paired leaves `publication()` throwing.
