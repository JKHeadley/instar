---
title: "U4.5 — Rope-Health Alerts (honest, deduped mesh-transport degradation heads-up)"
slug: "u4-5-rope-health-alerts"
author: "echo"
status: "draft"
parent-principle: "The Agent Is Always Reachable — a mesh partition must be seen before it silences the operator"
sibling-principles: "Bounded Notification Surface; A Refusal Stays a Refusal (a dark rope is a refusal-in-waiting); Runtime End-to-End Proof"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "G1 coherence-audit digest (already deployed both machines this session — .instar/scripts/coherence-audit.mjs); multiMachine.meshTransport (shipped)"
---

# U4.5 — Rope-Health Alerts

## 1. Problem

The mesh now runs over multiple transports ("ropes": Tailscale, LAN, Cloudflare
tunnel — `multiMachine.meshTransport`). Transport degradation is today visible ONLY
if someone goes looking: `GET /health → multiMachine.syncStatus.meshEndpoints`,
`GET /guards`, or the tailscale CLI. Three degradations matter and are all currently
silent:

1. A Tailscale key nearing expiry (the Laptop key expires 2026-12-29, the Mini's
   2026-12-11 — verified this session). When a key expires, that rope drops with no
   warning.
2. A rope persistently down to a peer (e.g. the Cloudflare flap that was the root
   cause of the 2026-07-01 lease instability).
3. ALL transports down to a peer — an imminent partition, the precondition for the
   silent-message-loss class this whole project exists to eliminate.

The operator should be told about (1) and (2) ONCE, calmly, BEFORE they become a
lease instability — and (3) promptly. But per the operator's standing
conservative-notification directive ("almost all messages should be assumed to be
messages the agent acts on, not that the user should know about; one hub topic for
user alerts; never per-event topics"), this must NOT become a stream of per-check
alerts. The failure mode to avoid is exactly the 2026-05-22 sentinel-flood and the
2026-06-05 worktree-detector flood: one topic per event.

## 2. Design

**Ride the existing G1 coherence-audit digest — add NO new notification surface.**
The G1 audit already runs daily on both machines, already checks Tailscale login
state + a 14-day key-expiry warning, and already emits exactly ONE digest line to the
hub topic (7848) — never per-item, never a new topic. U4.5 EXTENDS that one digest
with a rope-health section, rather than building a second notifier.

- **Data source (read-only, local):** `GET /health → multiMachine.syncStatus.meshEndpoints`
  for the advertised rope kinds; the per-transport circuit-breaker state (from U4.3
  once it lands, else the current best-effort reachability); `tailscale status --json`
  for key expiry (already parsed by the G1 tailscale check). Everything is a local
  read — no egress beyond the mesh the agent already uses.
- **Classification (deterministic):**
  - `ok` — every advertised rope to every known peer is healthy; key expiry > 14 days.
    → NO line in the digest (silence is the default; the digest only speaks on drift,
    consistent with G1 today).
  - `degraded` — a rope is down to a peer BUT ≥1 other rope is healthy (the mesh is
    still connected), OR a key expires within 14 days. → ONE line in the daily G1
    digest: "Rope health: Tailscale to <mini> down (LAN still up); Laptop key expires
    in 9d." Informational, rides the existing digest cadence.
  - `urgent` — ALL transports to a peer are down (imminent/actual partition). → this
    is the ONLY case that escalates beyond the daily digest: ONE deduped Attention
    item (`source` keyed on the partition episode, HIGH), coalesced per episode so a
    flapping rope can't flood (the same episode-dedup the split-brain attention item
    uses). Never one-per-check.
- **Flap-proofing (reuse U1's shape):** a `degraded`→`ok` recovery must be SUSTAINED
  (a short blip does not clear-then-re-alert). Track time-since-first-observed per
  (peer, rope); a `degraded` line only appears after the condition holds past a
  debounce, and the `urgent` attention item only escalates after ALL-down holds past
  a (shorter) debounce. This is the identical anti-flap decay the silent-loss notice
  uses (§2.C of the U1 spec) — reuse it, do not reinvent.

## 3. Multi-machine posture (mandatory)

Each machine runs its OWN G1 audit and reports its OWN rope view (a rope's health is
inherently per-machine-pair — the Laptop's view of the Mini is authoritative for that
direction). So this is **machine-local BY DESIGN**: no replication. The digest each
machine emits names the machine it is reporting FROM. The `urgent` partition attention
item is pool-coalesced (both machines observing the same all-down partition raise ONE
item, via the existing P17 attention coalescing), so a two-sided partition does not
double-alert.

## 4. Tests

- `degraded-rope-emits-exactly-one-digest-line` (not per-rope, not per-peer).
- `all-transports-down-escalates-one-deduped-attention-item` (+ a flapping all-down
  raises ONE item per episode, never per-check).
- `key-expiry-within-14d-appears-in-digest`, `>14d-is-silent`.
- `sustained-clear-required-before-re-alert` (a blip does not clear-then-re-fire).
- `healthy-mesh-emits-no-rope-line` (silence is the default).
- Multi-machine: `two-sided-partition-coalesces-to-one-item`.

## 5. Rollback / rollout

Rides the G1 job that already ships. New behavior is gated by
`monitoring.coherenceAudit.ropeHealth` (default on once soaked — but the digest is
already opt-in per-machine via the job's own enablement, so the blast radius is one
extra line in an existing daily message). Disable = drop the config flag; the G1
digest reverts to its pre-U4.5 content. No new store, no new topic, no new endpoint.

## Frontloaded Decisions

1. **Ride G1, do not build a new notifier** — the conservative-notification directive
   makes a second surface the wrong call; the daily digest already exists and already
   honors "one hub topic, drift-only."
2. **Machine-local, not replicated** — rope health is per-machine-pair; each machine
   reports its own view. (Contested-cheap: N/A — no durable external side-effect.)
3. **Only ALL-down escalates beyond the digest** — a single degraded rope with a
   healthy alternative is NOT urgent (the mesh is still connected); escalating it
   would be noise. Imminent partition is the bar for an attention item.
4. **Reuse U1's flap-proof decay** — do not invent a second anti-flap mechanism.

## Open questions

None.

> The debounce windows (degraded vs urgent) are config knobs with sensible defaults
> (degraded: appears in the next daily digest; urgent: ~2 consecutive all-down probes)
> — tunable without a spec change, so they are frontloaded config, not open questions.
