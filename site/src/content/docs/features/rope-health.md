---
title: Mesh Rope Health
description: A traffic-independent recovery probe re-dials dead mesh transports, and an in-server monitor turns silent mesh degradation into honest, sleep-aware alerts.
---

When an agent runs on more than one machine, the machines talk over multiple transport
"ropes" — Tailscale, LAN, and the Cloudflare tunnel. Two gaps made rope failures silent:

1. **A healed rope stayed presumed-dead.** The hedged dialer always races the healthiest
   rope first and cancels the losers, so a rope marked dead was never re-dialed — and a
   cancelled recovering dial was even recorded as a *failure*, resetting its recovery
   streak. A healed Tailscale rope once stayed presumed-dead for a week.
2. **Degradation had no alert.** A Tailscale key expiry dropped a rope with no warning,
   and an all-ropes-down partition — the precondition for silent message loss — had no
   prompt alert at all.

Both features ship **dev-gated**: live on a development agent from day one, dark on the
fleet (`multiMachine.meshTransport.recoveryProbeEnabled` and `monitoring.ropeHealth.enabled`
are omitted from config so the gate decides). Single-machine installs are a strict no-op.

## Recovery probe (U4.3)

The `RopeRecoveryProber` rides the existing ~5s lease-pull tick (no new loop) and re-dials
dead ropes with a **pinned, signed canary probe** — a deliberately-unresolvable
`deliverMessage` the peer answers with a *typed refusal*. Only that exact typed contract
counts as success (a captive portal's `200 OK` never closes a rope). Results feed
`PeerEndpointResolver.recordResult` — the ONE health authority the transport itself uses —
so a healed rope closes in minutes.

- **Episode-scoped**: probing opens when a rope dies and closes when the rope reclaims
  preferred status, so a slow-but-alive rope is never probed hot forever.
- **Bounded (P19)**: after 20 consecutive failures the cadence caps at a 15-minute floor
  and escalates ONCE per episode — probing never hard-stops (a healed rope must always be
  rediscoverable) and never spins silently.
- **Hedge-abort neutrality**: a dial cancelled because a sibling rope won the hedge no
  longer records as a failure — the transport fix that stops the winner from perpetually
  re-poisoning the loser's recovery streak.
- **Dry-run first**: `recoveryProbeDryRun: true` sends real probes (harmless by contract)
  and logs would-close verdicts without mutating health — real soak signal, zero risk.
- Read the per-(peer, kind) state on the authed `GET /health` →
  `multiMachine.syncStatus.ropeHealth`.

## Rope-health alerts (U4.5)

The `RopeHealthMonitor` runs its own bounded 30s evaluation loop over the same snapshot
seam and classifies each peer deterministically:

| Condition | Meaning | Surface |
| --- | --- | --- |
| `ok` | every rope healthy | silence |
| `degraded` | a rope down while another carries traffic, or a Tailscale key expiring within 14 days | daily digest only |
| `peer-offline` | ALL ropes down and the peer's heartbeat **stopped** (asleep/off — expected) | daily digest only |
| `urgent` | ALL ropes down while the peer's git-synced heartbeat still **advances** — alive but partitioned | ONE HIGH attention item per episode |

The urgent discriminator is **advancement-since-onset**: a heartbeat newer than the
all-down onset, observed after the onset. A just-closed laptop lid's last beat still looks
fresh for up to an hour, so freshness windows are rejected — a lid-close is *never* a HIGH
alarm. Honest latency: a genuine partition is confirmed in roughly 30–90 minutes (bounded
by the heartbeat interval plus git-sync cadence). A self-wake grace window suppresses
urgent over stale post-wake snapshots — bounded to five minutes, because the sleep
detector is known to emit false wake events under event-loop stalls.

- **`GET /mesh/rope-health`** — the monitor's classification, episode state, key-expiry
  status, and a server-composed digest. Returns `503` when dark.
- **The `rope-health-digest` job** — a built-in daily `supervision: tier1` job that reads
  the route and emits at most one consolidated section (≤3 sentences) when anything is
  non-ok. It ships `enabled: true` with a 503-silent body — the feature flag is the real
  gate, so the job costs nothing on the fleet. Delivery honors
  `monitoring.ropeHealth.digestTopicId` (unset = log-only).
- **Content scrub**: alert and digest text carries rope kind + machine nickname +
  relative times only — never IPs, tunnel hostnames, tailnet names, or account emails.
- **Episode honesty**: during a true two-sided partition each side raises at most one
  item (two total — coordination during the event is structurally impossible); a shared
  deterministic episode key groups them after heal, and an already-open split-brain item
  suppresses the monitor's own.

Specs: `docs/specs/u4-3-breaker-recovery-probe.md`, `docs/specs/u4-5-rope-health-alerts.md`.
