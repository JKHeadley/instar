## What Changed

Fixed a boot-ordering bug that left the cross-machine `OwnershipApplier` permanently
un-wired: a topic moved between machines was reported moved but the destination never took
ownership, so the conversation went silent on arrival. The applier's on-switch now depends on
the durable ownership store alone (extracted into a testable `wireOwnershipApplier` factory),
and the machine id it uses for logging is late-bound, so the wiring can't be broken by code
reordering. Caught by applying the Live-User-Channel Proof gold standard to a real
Laptop→Mini transfer (the second, deeper bug after the dev-gate-darkness fix in v1.3.590).

## What to Tell Your User

If you move a conversation between your machines, the destination now genuinely takes over and
answers there. Before this, a moved conversation could report success but then go quiet on the
new machine, because the new machine never realized it owned the conversation. Single-machine
setups are unaffected.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Moving a conversation between machines actually lands it on the destination | Move a topic to another machine as usual; the destination now takes ownership and serves it |

## Evidence

- 6 new unit/wiring tests (`tests/unit/ownershipApplierWiring.test.ts`) + 7 existing applier
  tests stay green; tsc clean.
- Release gate: a live two-machine re-run asserts the destination materializes the seat and a
  reply serves from it (Telegram + Slack).
