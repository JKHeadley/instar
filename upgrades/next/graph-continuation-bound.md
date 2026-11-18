# A backlog of unconfirmed graph changes no longer locks out the other machine

<!-- bump: patch -->

## What Changed

`ConversationGraphReplicationRuntime.reconcilePending` (the background pass that finishes changes still waiting for confirmation) walked every uncertified record each pass, re-validating it and submitting it to the peers, while holding the graph's mutation lane. Peer requests (including the other machine's `observe` calls) wait behind that lane. On the accept-all rig, a backlog of 50 uncertified source-observation records made every pass long enough that every observe from the M5 timed out on both addresses, so the observations that would have certified those records never landed: a self-feeding stall. Uncertified continuations are now bounded the same way resumed deliveries already were: after one continuation does not finish (held, or not committed/canceled), no other is tried in that pass, and a record that keeps not finishing is tried less and less often (doubling, capped at 40 passes), never dropped. Both this bound and the existing delivery bound now take records least-recently-tried first, so a backlog larger than the cap still cycles through every record.

## What to Tell Your User

- **Machines stay in touch under a backlog**: "If a lot of changes are waiting for my other machine to confirm, I now retry them a few at a time instead of all at once, so the other machine can still get through to me and the backlog clears."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded background retries for unconfirmed graph changes | Automatic |

## Evidence

Rig diagnosis (accept-all-2b, 2026-11-18 03:54-04:00Z, by the accept-all session): 50 uncertified source-observation records; from 03:58 every M5 observe timed out (5 s + 5 s) while the Studio ran at 47% CPU. CPU profile: revalidation under `validatedContinuation` was 26-37% of busy time. Tests: `tests/unit/conversation-graph-continuation-bound.test.ts` (stops after the first non-finishing continuation; continues while they finish; held rows stop the pass and backoff lets later rows through; finishing clears the backoff) — 4 passed.
