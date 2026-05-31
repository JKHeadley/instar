# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Multi-machine: fixes the next bug blocking cross-machine session transfer.**
When two machines talk, each message carries an ever-increasing number so the
receiver can reject replayed old messages. A machine has several lines of
communication to its peer (the in-charge lease, the heartbeat, handoffs, the live
tail), and each kept its own number seeded from the clock — so they drifted apart.
The receiver only tracks one highest-number-seen per machine, so the fast
heartbeat pushed that number high and the quieter lease line's messages then
looked out-of-order and were dropped as replays. The standby machine therefore
never received the lease announcement and refused to take over a conversation.
This change makes every line on a machine share ONE ever-increasing number from a
single chokepoint, so legitimate messages are never mistaken for replays. The
receiver's replay protection (unique tokens + a 30-second freshness window + the
per-machine number) is unchanged. Single-machine agents are unaffected.

## What to Tell Your User

If you run on one machine, nothing changes. If you run one agent across two
machines, this fixes a hidden issue where the second machine was silently dropping
the messages that tell it which machine is in charge — a step toward moving a
conversation between machines working end to end. Nothing to configure.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shared machine-auth sequence | Automatic. All of a machine's signed peer requests now share one monotonic sequence, so the lease/heartbeat/handoff/live-tail channels no longer collide on the receiver's per-machine replay watermark. No configuration. |

## Evidence

- `tests/unit/machine-auth.test.ts` (21) updated to the new chokepoint contract,
  plus a regression: two channels signing via signRequest stay strictly monotonic
  (no cross-transport collision), and a direct NonceStore stale-sequence-rejection
  test (receiver behavior preserved).
- `tests/integration/machine-routes.test.ts` (23) green — no sequence regression.
- `tsc --noEmit` + repo lint clean.
- Live evidence that motivated it: the standby's security log showed
  "Sequence …053 <= last seen …744" rejecting every lease broadcast.
- Side-effects: `upgrades/side-effects/machineauth-shared-sequence.md`.
