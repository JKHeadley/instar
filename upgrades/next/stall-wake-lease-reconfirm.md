# A machine back from a stall re-asks before it takes the lead (dark)

<!-- bump: patch -->

## What Changed

A machine whose server has just come back from a long stall (a sleep, or a heavy build starving it for minutes) could take the multi-machine lead from a healthy machine within a second of waking, because its own copy of the holder's lease had aged past the lease lifetime while it processed nothing (fb-fdb55c1c-a79). A new switch, `multiMachine.takeoverReadyPool.stallReconfirm`, makes the lease coordinator keep its own awake clock: when it has lost more than 30% of a lease lifetime of running time within one lifetime (one long gap or a burst of shorter ones), a claim on a lease another machine holds is held until fresh evidence exists. It first pulls every peer over every route, so a live holder's renewal lands and the claim is refused; it claims only after a full lease lifetime has passed awake and a pull round started after the stall has completed (a machine that keeps stalling is capped at ten lifetimes). Each step is logged as `stall-reconfirm: ...` and recorded on the takeover-ready-pool feature evidence, including a suspected-overlap error if the machine taken over signs a newer renewal soon after. Off by default everywhere; off is exactly today's behaviour.

## What to Tell Your User

- **Fewer wrong lead changes after a computer freezes (when switched on)**: "If one of my computers freezes for a few minutes, for example during a big app build, it will no longer grab the lead from a healthy computer the moment it wakes up. It checks with the others first. This is switched off until we turn it on for your computers."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stall-safe lead takeover | Set `multiMachine.takeoverReadyPool.stallReconfirm.enabled: true` (read live, no restart); watch `stall-reconfirm:` lines in the server log |

## Evidence

Live: on 2026-11-21 the Laptop's log shows its last normal line at 16:05:46Z, a 226 s drift at 16:09:47Z, and `acquired lease at epoch 23761` at 16:09:48Z while the Studio was renewing epoch 23760. The new unit, real-HTTP integration and real-boot-path e2e tests reproduce that claim with the switch off and show no claim with it on (the holder is re-confirmed by one fresh pull), a dead holder still taken over one lease lifetime (60 s) after the stall, and identical behaviour on and off when there is no stall.
