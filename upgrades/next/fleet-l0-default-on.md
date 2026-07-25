# Fleet default-ON: zombie-message age guard

## What Changed
The L0 delivery age-guard (merged dark in #1603, soaked on test+dev 2026-07-24) is now ON by
default fleet-wide: queued outbound messages older than their queue's shelf life (24h for
delivery-recovery) are retired to dead-letter with a named reason at the moment of delivery,
instead of being replayed to users. An explicit `outboundQueueExpiry.enabled: false` keeps an
install dark; `maxAgeHours: 0` disables expiry per queue.

## Evidence
- Test rung: retired a real 35-day stale row at first dequeue (audited reason), zero false
  retirements all day. Dev rung: armed + boot-confirmed across restarts, zero retirements
  (clean queue). Six deploys crossed with no misfire. Operator approval: "go fleet"
  (2026-07-24 ~22:30 PDT, topic 29723) after the evidence proposal.
- New wiring test pins the default-ON gate semantics (absence arms; only explicit false darkens).

## What to Tell Your User
Your agent will no longer replay days-old queued messages as if they were new. If a message
could not be delivered for more than a day, it is set aside with a written reason instead of
being sent late; nothing fresh is affected. If you ever want the old behavior back, one setting
turns this off for your install.

## Summary of New Capabilities
Stale-message replay protection is now on for every agent by default.
