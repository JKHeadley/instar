# Side effects: forwarded reply settles when the holder's own send is outcome-unknown

## Change
`recoverForwardedHold` gains a branch for a new receipt answer, `outcome-unknown`, which calls a new store transaction `recordForwardedOutcomeUnknown` and returns `settled`. `server.ts` maps the holder's receipt state `outcome-unknown` to that answer and wires the store call; `settled` also clears the topic's held attention item when nothing else is held.

1. **Over-block** — none. The change only moves rows out of `held`; it never stops a send.
2. **Under-block** — rows whose holder is genuinely unreachable still wait for the deadline (unchanged, correct). The 6-hour deadline expiry of an `outcome-unknown` forward whose holder stays dark still reads as "not delivered" in the outcome lookup; that pre-existing gap is narrower now because a reachable holder settles first.
3. **Level-of-abstraction fit** — the decision stays in the forward-recovery state machine; the store transaction mirrors `recordForwardedAcceptance`.
4. **Signal vs authority** — no new gate. The holder's receipt is the authority on what happened; the standby now records that verdict instead of ignoring it.
5. **Interactions** — `runForwardLadder` counts `settled` as processed, not recovered, and refreshes the held summary. The settle transaction refuses when any child is not queued or an entry is claimed, so it cannot race a concurrent recovery or acceptance. The existing `owned-by-holder` path (holder still delivering) is unchanged.
6. **External surfaces** — no new messages. Fewer "held reply expired" HIGH attention items, since settled rows never reach expiry.
7. **Multi-machine posture** — this is the cross-machine path itself. A standby on the new code talking to an older holder still works: the old holder returns the same `outcome-unknown` receipt state. An older standby keeps today's behaviour.
8. **Rollback cost** — revert the release. Rows already settled stay `outcome-unknown` (truthful); no data repair needed.

Second pass: not required (no block/allow decision added; recovery state only).
