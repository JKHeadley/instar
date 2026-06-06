---
bump: patch
---

## What Changed

Audit fix #6 under "No Unbounded Loops" (P19): the SessionRouter's per-peer
breaker hook (`markOwnerSuspect`) — which fires on delivery-retry exhaustion —
was never wired in production, and `isMachineAlive` reads only capacity
heartbeats, so every session owned by a slow-but-heartbeating machine re-paid
the full ~4.5s retry tax per message. Now `OwnerSuspectBreaker` (pure core
class, per-peer half-open windows with ABSOLUTE per-episode TTL, composing
`FailureEpisodeLatch` for one-log/one-signal episode accounting) is wired into
`markOwnerSuspect` + composed into `isMachineAlive` + filtered into placement
candidates (with an all-suspect unfiltered fallback). A new router dep
`onOwnerResponsive` closes the window on ANY delivery ack. Also fixed: the
router's per-session `chains` map leaked one settled entry per session-ever-
routed (now bounded by in-flight sessions). The adversarial reviewer
reproduced and fixed a forever-suspect bug in the first draft (re-marks
extended the TTL → a recovered busy peer stayed written off indefinitely —
the absolute TTL is their fix, regression-tested). Suspect-window message
POLICY (re-place fast vs hold-for-stability) is deliberately unchanged —
operator decision, options sent separately.

## What to Tell Your User

If you run me on more than one machine: when one machine starts failing to
receive its conversations' messages, the router now learns it once (instead of
re-discovering it ~4.5 seconds at a time, per conversation, per message),
routes around it, re-checks every 30 seconds, and picks the machine back up
the moment it answers again. Pinned conversations stay put through brief
blips. If a machine stays unreachable for 10+ minutes you get one note in the
health log.

## Summary of New Capabilities

- Per-machine delivery circuit breaker (30s half-open windows, instant
  recovery on any successful delivery, sustained-failure health-log signal).
  No configuration needed.

## Evidence

CMT-1109 audit, grounded to three concrete findings (unwired hook;
heartbeat-only aliveness; no-op queue dep). Adversarial second-pass: probe-1
OBJECT confirmed by reproduction (forever-suspect under steady traffic) and
fixed in-review with a regression test; probes 2–5 (swap-count invariance,
pin behavior through suspect windows, all-suspect fallback can't wedge,
stale-ack semantics, chains-cleanup serialization race) traced clean. Tests:
40 green across the breaker unit suite (incl. the P19 sustained-suspicion
bound and the end-to-end zero-retry-tax short-circuit), SessionRouter (23),
dispatch integration (3), and the session-pool deliverMessage e2e (4); tsc
clean.
