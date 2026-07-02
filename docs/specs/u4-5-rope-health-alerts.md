---
title: "U4.5 — Rope-Health Alerts (productized monitor + honest partition semantics + sleep-aware urgency)"
slug: "u4-5-rope-health-alerts"
author: "echo"
status: "draft"
parent-principle: "The Agent Is Always Reachable — A Guaranteed Reachability Floor"
sibling-principles: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Bounded Notification Surface; Observability — you can't tune what you can't see; Scrape/Parser Fixture Realness; Migration Parity"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "U4.3 rope-health snapshot (HARD dependency — the authed GET /health ropeHealth per-(peer,kind) state; build order U4.3 → U4.5; there is NO usable interim source: /health today carries advertised kinds only and the resolver map is process-private); SleepWakeDetector + machine-registry online/last-seen (the expected-online gate); WS4.2 emptyState semantics (offline-since vs unreachable); PendingRelayStore (alert delivery retry); guardManifest (G3)"
---

# U4.5 — Rope-Health Alerts

## 1. Problem — corrected by round-1 review

Mesh transport degradation is silent today: a Tailscale key expiry drops a rope with
no warning; a persistently-down rope (the Cloudflare flap behind the 2026-07-01 lease
instability) is visible only to someone who goes looking; an all-transports-down
partition — the precondition for silent message loss — has no prompt alert at all.

**Round-1 grounding corrections baked into this rewrite:**
- Round 0 rode the G1 coherence-audit job for everything. Verified: G1 is a
  **hand-deployed agent-home script** (zero hits in the instar repo) running **once
  daily at 09:20, stateless**. It cannot detect "~2 consecutive all-down probes,"
  cannot debounce across runs, and a partition beginning at 10:00 would first be
  *evaluated* ~23 hours later. The urgent tier had no evaluation vehicle, the
  `monitoring.coherenceAudit.ropeHealth` flag gated nothing shipped (Migration
  Parity violation), and "no new store" contradicted the state the debounce needs.
- Round 0's classification conflated a **sleeping laptop** with a partition — on the
  motivating asymmetric setup that is one HIGH false alarm per lid-close, forever
  (the exact 2026-05-22 flood class).
- Round 0's "P17 pool-coalescing prevents double-alert" was wrong three ways: P17 is
  a read-time view merge (never creation-dedup), HIGH items are exempt from
  coalescing, and the fan-out needs the very mesh that is down.
- Round 0's data-source fallback ("current best-effort reachability") names nothing
  that exists.

## 2. Design — an in-server monitor (product code); the digest stays one line

**Component (productized — this ships in instar, not as an agent-home script):**
`RopeHealthMonitor` (`src/monitoring/RopeHealthMonitor.ts`), constructed by the real
server boot, evaluating on the existing mesh heartbeat/lease-tick cadence (~every
30s; no new loop — it subscribes to the tick the coordinator already runs).

- **Data source (HARD dependency):** the U4.3 `PeerEndpointResolver.snapshot()` seam
  (the same data the authed `/health` serves) — in-process, zero cost. U4.3 builds
  first; there is no interim fallback (round 0's fallback named nothing real — this
  is now honest).
- **State (durable, small):** `state/rope-health.json` — per (peer, kind): condition,
  firstObservedAt, consecutiveObservations, episodeKey, lastAlertAt. Survives
  restarts (the debounce/episode memory a daily stateless job could never hold).
  Bounded: peers × kinds.
- **Classification (deterministic, sleep-aware):**
  - `ok` — silence (no digest line, nothing).
  - `degraded` — a rope down to a peer while ≥1 other rope is healthy, OR a Tailscale
    key expiring within 14 days. Digest-only.
  - `peer-offline` — ALL ropes down BUT the peer is NOT expected online: registry
    marks it offline / it announced a graceful shutdown or sleep (SleepWakeDetector /
    WS4.2 `offline since <t>` semantics). Digest-only ("<nickname> offline since
    <t> — expected"). **A lid-close is never urgent.**
  - `urgent` — ALL ropes down to a peer that IS expected online (registry-online,
    heartbeat-fresh until it wasn't, no graceful-offline signal) for ≥
    `urgentDebounceChecks` (default 2) consecutive evaluations. ONE HIGH attention
    item per episode.
- **Episode semantics (honest about partitions):** episodeKey =
  `sorted(machineA,machineB) + ':' + coarse window start (condition onset, quantized
  15 min)` — deterministically computable on BOTH sides without coordination. During
  a genuine two-sided partition each side raises at most ONE item (Telegram rides the
  internet, not the mesh, so delivery works) — **two items total for a true
  partition is accepted and declared** (coordination during the event is structurally
  impossible); after heal, the pool attention view groups them by the shared
  episodeKey. If a split-brain attention item is already open for the same episode
  window, the monitor does NOT raise a second item (episode-registry check) — one
  episode, one ask.
  An episode ENDS only after ≥ `clearSustainMs` (default 10 min) of continuous
  health — a blip cannot clear-then-re-fire (the U1 sustained-clear shape, restated
  here concretely rather than by reference).
- **Alert delivery honesty:** the attention item + Telegram delivery ride the
  internet, not the mesh. If delivery itself fails, the failure is recorded in the
  monitor state (`detected-not-notified`) and retried via the existing durable relay
  path — detected-but-silent is impossible to lose silently.
- **Content scrub (frontloaded rule):** alert/digest text carries rope KIND +
  machine NICKNAME + relative expiry ONLY — never raw IPs, URLs, tunnel hostnames,
  tailnet names, or account emails (the tailscale JSON carries all of these; they
  never leave the parser).
- **The daily digest line:** `GET /mesh/rope-health` (Bearer) serves the monitor's
  current classification + episode state. A **built-in daily job template**
  (`rope-health-digest`, shipped via the standard job-template path, off by default
  fleet / on for dev per job convention) emits at most ONE consolidated section
  (≤ 3 sentences, clamped, machine-named) to the alerts hub topic when anything is
  non-ok. The operator's existing agent-home G1 script simply adds one read of the
  same route (documented one-line change) — the G1 script is thereby a CONSUMER,
  never the mechanism. Migration parity: the monitor + route + job template all ship
  in instar with config defaults via `migrateConfig`; the CLAUDE.md template gains
  the proactive trigger ("is the mesh healthy? / why did I get a partition alert?"
  → `GET /mesh/rope-health`).

## 3. Multi-machine posture (mandatory)

Rope health is per-machine-pair and directional — **machine-local BY DESIGN**, no
replication. Each machine's monitor reports its OWN view, named as such. The
episodeKey gives cross-machine read-time grouping without any cross-machine write.
Single-machine install: no peers, monitor idles at zero cost, strict no-op.

## 4. Observability

Feature-metrics key `rope-health` (deterministic — zero LLM cost): evaluations,
transitions by class, urgent episodes, suppressed-by-sleep-gate count (the
false-alarm class we killed, made countable), detected-not-notified retries,
digest emissions. guardManifest entry: `loadBearing: true`, `criticalPath: "mesh
partition alerting"` (this IS the alerting layer for reachability), with soak
window declared per G3.

## 5. Config, rollout, migration

- `monitoring.ropeHealth` = `{ enabled (OMITTED — dev-agent gate: live-on-dev day
  one, dark fleet), urgentEnabled: true, urgentDebounceChecks: 2, clearSustainMs:
  600000, keyExpiryWarnDays: 14, digestJobEnabled (job-template convention) }`.
- Graduation criteria (named): 7 days on the dev pair with zero false urgent items
  (every urgent episode manually confirmed real) and ≥1 real sleep event correctly
  classified `peer-offline` → fleet default-on for the monitor (digest job stays
  per-agent opt-in).
- Rollback: `enabled:false` → monitor inert, route 503s, job emits nothing. The
  state file is inert data.
- **Build order:** U4.3 merges first (the snapshot seam is this spec's data source).
  The two may share a PR per the shared-seam convention; U4.5's tests must not be
  skipped when combined.

## 6. Tests (tiers declared)

Unit: classifier per class incl. the sleep gate (expected-online vs graceful-offline
vs unreachable — both sides of every boundary); episodeKey determinism (both sides
compute the same key); debounce (N-1 checks do not fire); sustained-clear (blip does
not re-fire); split-brain-item suppression; content scrub (fixture rows containing
IPs/emails/tailnet never reach output); **tailscale `status --json` parser REGISTERED
with captured byte-for-byte fixtures** (real output incl. KeyExpiry — Scrape/Parser
Fixture Realness); state-file round-trip across restart. Integration: `GET
/mesh/rope-health` through the real HTTP pipeline (authed); attention item raised
via the real queue with episode dedup; metrics rows. E2E lifecycle (feature-alive):
production init with the flag dev-resolved → monitor constructed, ticking,
`lastEvaluatedAt` advancing; dark → 503 + zero presence. Wiring-integrity: monitor
subscribes to the REAL coordinator tick and reads the REAL resolver snapshot (not a
copy). Live two-machine drive (before fleet): tailscale logout on the dev pair →
degraded line appears; peer sleep → `peer-offline`, NO urgent item (the load-bearing
false-alarm test, live); full network cut to an expected-online peer (simulated) →
ONE urgent item per side, episode-grouped post-heal.

## Frontloaded Decisions

1. **Productized in-server monitor** — the detector is instar source riding the
   existing mesh tick with a small durable state file; the G1 agent-home script
   becomes a consumer of `GET /mesh/rope-health`, never the mechanism. (Resolves the
   Migration-Parity violation and gives the urgent tier a real evaluation vehicle.)
2. **U4.3 is a HARD dependency** — no fallback data source exists; build order
   declared.
3. **Sleep-aware urgency** — urgent requires expected-online + all-down + debounce;
   a lid-close classifies `peer-offline` (digest at most). The suppressed-false-alarm
   count is a metric, so the gate's value is measurable.
4. **Honest partition semantics** — at most one item per SIDE per episode; two-sided
   duplication during a true partition is accepted and declared (coalescing during
   the event is structurally impossible); deterministic shared episodeKey groups them
   post-heal; the split-brain item wins if already open.
5. **Only all-down-expected-online escalates** — a degraded rope with a healthy
   alternative is digest-only; key expiry warns at 14 days in the digest.
6. **Content scrub is a hard rule** — kind + nickname + relative expiry only.
7. **Maturation Path compliance** — live-on-dev day one via the dev gate; named
   graduation criteria; G3 loadBearing registration.

## Open questions

None.
