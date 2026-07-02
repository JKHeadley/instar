---
title: "U4.5 — Rope-Health Alerts (productized monitor + honest partition semantics + sleep-aware urgency)"
slug: "u4-5-rope-health-alerts"
author: "echo"
status: "draft"
parent-principle: "The Agent Is Always Reachable — A Guaranteed Reachability Floor"
sibling-principles: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Bounded Notification Surface; Observability — you can't tune what you can't see; Scrape/Parser Fixture Realness; Migration Parity"
parent-spec: "docs/specs/U4-mesh-self-healing-index.md; multi-transport-mesh-comms.md; MULTI-MACHINE-SESSION-POOL-SPEC.md"
project: "self-healing-mesh (topic 29836)"
depends-on: "U4.3 rope-health snapshot (HARD dependency — the authed GET /health ropeHealth per-(peer,kind) state; build order U4.3 → U4.5; there is NO usable interim source: /health today carries advertised kinds only and the resolver map is process-private); git-synced coarse MachineHeartbeat (the mesh-INDEPENDENT liveness discriminator for the urgent tier — R-r2-1); SleepWakeDetector wake event (OWN-machine, retrospective — feeds only the self-wake grace window, never a peer-sleep signal); machine-registry online/last-seen (staleness only — failoverThresholdMs default 15 min); WS4.2 emptyState semantics (offline-since vs unreachable); tailscale status --json via bounded exec (the key-expiry source — R-r2-3); guardManifest (G3)"
review-convergence: "2026-07-02T07:40:47.478Z"
review-iterations: 5
review-completed-at: "2026-07-02T07:40:47.478Z"
review-report: "docs/specs/reports/u4-5-rope-health-alerts-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 2
approved: true
approved-basis: "Operator preapproval for spec approvals in this session (topic 29836, 2026-07-02): 'Full preapproval granted … spec approvals, server restarts, deployment, and all in-scope reversible decisions.' Recorded transparently, not silently self-granted."
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
server boot, running **its OWN bounded evaluation loop** — a 30s `setInterval`
owned by the monitor, constructed and torn down at boot/shutdown (R-r2-2). Round
1's "subscribes to the ~30s coordinator tick" named a carrier that doesn't exist:
the coordinator's real timers are the ~5s lease pull, the ~2 min heartbeat, and a
30s `refreshPool` `setInterval` closure — none is a subscribable evaluation tick.
Owning the loop keeps the cadence pinned in TIME, which the urgent debounce
depends on (below).

- **Primary data source (HARD dependency):** the U4.3
  `PeerEndpointResolver.snapshot()` seam (the same data the authed `/health`
  serves) — in-process, zero cost. U4.3 builds first; there is no interim fallback
  (round 0's fallback named nothing real — this is now honest). **Absent-record
  semantics (R-r2-minor):** a (peer, kind) with NO snapshot record (never dialed,
  or evicted) is UNKNOWN, not down — the classifier fails toward **NOT-urgent**
  (at most `degraded`/digest visibility). (U4.4 states the mirror-image rule:
  absent ⇒ not-healthy ⇒ defer.)
- **Second declared source — Tailscale key expiry (R-r2-3).** Key expiry is NOT in
  the U4.3 snapshot (the resolver never sees it) — round 1's "single data source"
  framing was wrong. The expiry tier reads a **bounded exec of `tailscale status
  --json`**: hard timeout, cadence once per hour, output parsed by the registered
  fixture-backed parser (§6). Absent CLI ⇒ the expiry tier is **silently absent**
  (one debug log line, no alert, no error state) — the rest of the monitor is
  unaffected.
- **State (durable, small):** `state/rope-health.json` — per (peer, kind): condition,
  firstObservedAt, consecutiveObservations, episodeKey, lastAlertAt. Survives
  restarts (the debounce/episode memory a daily stateless job could never hold).
  Bounded: peers × kinds. **Write discipline (R-r2-4):** transition-only writes
  (a steady-state evaluation never touches disk) plus a short write debounce for
  transition bursts; intra-episode counters lost to a restart are ACCEPTED
  (declared — the safe direction: a restart re-debounces, it never fabricates an
  episode).
- **Classification (deterministic, sleep-aware) — REDEFINED on signals that exist
  (R-r2-1):** Round 1's urgent gate relied on a "graceful sleep/shutdown
  announcement" that exists NOWHERE: `SleepWakeDetector` detects only OWN-machine
  sleep, retrospectively (a wake event after the fact — it cannot see a peer's
  lid-close); the registry online flag is pure staleness (`failoverThresholdMs`
  default **15 minutes**); and registry freshness itself rides the very mesh
  being classified. As written, a lid-close would have matched urgent for up to
  ~15 min — one HIGH false alarm per lid-close, the exact flood class this spec
  exists to kill. The discriminator is now **mesh-INDEPENDENT liveness
  evidence**: the git-synced coarse `MachineHeartbeat`.
  - `ok` — silence (no digest line, nothing).
  - `degraded` — a rope down to a peer while ≥1 other rope is healthy, OR a Tailscale
    key expiring within 14 days. Digest-only.
  - `peer-offline` — ALL ropes down AND the peer's git-synced coarse heartbeat has
    STOPPED advancing (peer likely asleep/off), or the registry already marks it
    offline (WS4.2 `offline since <t>` semantics). Digest-only ("<nickname>
    offline since <t> — expected"). **A lid-close is never urgent** — a sleeping
    machine stops writing heartbeats.
  - `urgent` — ALL ropes down to a peer whose git-synced coarse heartbeat **is
    still advancing**, with "advancing" DEFINED (R-r3-1 — round 3 caught that
    both naive constructions break a claim): **advancement-since-onset
    semantics** — a heartbeat row whose `lastHeartbeatAt` is NEWER than the
    all-down condition's onset, OBSERVED after the onset. Freshness-window
    semantics ("beat age < threshold") are explicitly REJECTED: the heartbeat
    writes every ~30 min and propagates via ~30-min git-sync, so a
    just-lid-closed peer's last beat looks fresh for up to an hour — the exact
    false HIGH alarm this tier must never raise. Consequence, stated honestly:
    **the urgent tier's real detection latency is bounded by the heartbeat
    interval plus up to two sync cadences (~30-90 min)** — a genuine partition
    is confirmed the first time a post-onset beat lands while all ropes stay
    dead. The `urgentDebounceMs` (default 60000) on the monitor's own 30s loop
    (R-r2-2) is the SHORT-TERM flap filter on the all-down condition itself,
    NOT the binding urgent latency — the binding bound is the post-onset-beat
    confirmation, and the graduation criteria judge against THAT bound. ONE
    HIGH attention item per episode. **Self-wake grace window:** after OUR OWN
    machine wakes (SleepWakeDetector's wake event — the one thing it CAN tell
    us), all snapshots are stale; urgent is suppressed until each (peer, kind)
    has been re-observed post-wake.
  - **Residual, stated honestly:** a peer that dies BETWEEN coarse heartbeats
    classifies `peer-offline` (no post-onset beat ever lands) — late-but-honest;
    and a just-lid-closed peer whose LAST pre-sleep beat is still sync-propagating
    classifies `peer-offline`, never urgent (the beat predates the onset). The
    failure mode in every ambiguous case is a delayed or withheld upgrade to
    urgent — never a false HIGH alarm.
- **Episode semantics (honest about partitions):** episodeKey =
  `sorted(machineA,machineB) + ':' + coarse window start (condition onset, quantized
  15 min)` — deterministically computable on BOTH sides without coordination.
  **Boundary skew (R-r2-5):** the two sides detect at different instants, so an
  onset straddling a quantization boundary yields adjacent window keys; post-heal
  grouping therefore matches episodes across **ADJACENT quantization windows**
  (same machine pair, window start ±1 quantum), and grouping is declared
  **best-effort** — a skew beyond one quantum shows two groups, which is honest
  display degradation, never lost or duplicated alerts. During
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
  monitor state (`detected-not-notified`) and **the monitor's own next-evaluation
  retry re-raises it** — that retry, not any store attribution, is the mechanism
  (round 1's PendingRelayStore citation dropped: attention-item creation does not
  ride that queue; R-r2-minor). Detected-but-silent is impossible to lose
  silently.
- **Content scrub (frontloaded rule):** alert/digest text carries rope KIND +
  machine NICKNAME + relative expiry ONLY — never raw IPs, URLs, tunnel hostnames,
  tailnet names, or account emails (the tailscale JSON carries all of these; they
  never leave the parser).
- **The daily digest line:** `GET /mesh/rope-health` (Bearer) serves the monitor's
  current classification + episode state. A **built-in daily job template**
  (`rope-health-digest`) ships via the standard built-in-jobs path. **Precedent
  stated honestly (R-r2-7, corrected by R-r3-2 — round 2's claim was factually
  wrong):** the real `feedback-factory-process` template ships **`enabled:
  false`** (installed + scheduled + 503-silent body + operator opt-in enable —
  its e2e test asserts `enabled === false`). This spec DIVERGES from that
  precedent deliberately, and says so: `rope-health-digest` ships **`enabled:
  true` with the 503-silent body** — because the digest's whole gating already
  lives in the `monitoring.ropeHealth` dev-agent gate (dark fleet → the route
  503s → the enabled job runs and exits silently at zero cost; live dev agent →
  the digest actually flows from day one, the Maturation-Path posture this spec
  commits to). An `enabled: false` template would silently defeat the day-one
  dev-agent digest with no compensating safety (the feature flag is the real
  gate). Full frontmatter, frontloaded: name `rope-health-digest`,
  schedule `"0 9 * * *"`, model `haiku`, supervision `tier1`, priority `low`. The
  job emits at most ONE consolidated section (≤ 3 sentences, clamped,
  machine-named) when anything is non-ok — delivered to
  **`monitoring.ropeHealth.digestTopicId` (R-r2-8)**: round 1's "alerts hub topic"
  is not a real construct; the real surface is this config key, mirroring the
  `burnDetection.alertTopicId` precedent — default UNSET, in which case the digest
  job LOGS only (no Telegram send); the operator sets their hub topic id to get
  the digest delivered. Migration parity for the key via `migrateConfig`.
  **G1-script note (R-r2-minor):** the operator's existing agent-home G1
  coherence script is a CONSUMER, never the mechanism — and since it is
  agent-home (no repo artifact to patch), the one-line "also read
  `GET /mesh/rope-health`" change is documented as an **operator note in the
  digest job template body and in this spec**, not as a code deliverable.
  Migration parity: the monitor + route + job template + config key all ship in
  instar with config defaults via `migrateConfig`; the CLAUDE.md template gains
  the proactive trigger ("is the mesh healthy? / why did I get a partition
  alert?" → `GET /mesh/rope-health`).

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
  one, dark fleet), urgentEnabled: true, urgentDebounceMs: 60000 (time-pinned —
  R-r2-2; replaces round 1's tick-counted urgentDebounceChecks), clearSustainMs:
  600000, keyExpiryWarnDays: 14, digestTopicId (default unset — R-r2-8) }`.
  (Round 1's `digestJobEnabled` dropped — the job ships enabled with a
  503-silent body, a stated DIVERGENCE from the feedback-factory precedent, which
  ships enabled:false; justification in §2 — R-r2-7/R-r3-2.)
- **Action-bearing discipline for the urgent tier, argued explicitly (R-r2-6):**
  the urgent tier auto-posts HIGH attention items, which normally pushes a
  feature into `DARK_GATE_EXCLUSIONS`' action-bearing category. This spec takes
  the OTHER branch — a `DEV_GATED_FEATURES` entry whose written justification
  is: the only egress is **episode-deduped** (ONE HIGH item per (pair, episode),
  split-brain-item suppressed), **sleep-gated** (the mesh-independent heartbeat
  discriminator kills the lid-close false-alarm class by construction), and it is
  **operator-mandated partition alerting** — the silent-partition gap is the
  incident class the operator directed this project to close, the same
  bounded-escalation posture as the `degradationLadderNeverSilent` precedent
  already in that registry. `urgentEnabled: true` therefore rides the same
  dev-agent gate as the monitor (no separate flag ramp); the justification text
  above ships in the registry entry (an explicit build deliverable).
- Graduation criteria (named): 7 days on the dev pair with zero false urgent items
  (every urgent episode manually confirmed real) and ≥1 real sleep event correctly
  classified `peer-offline` → fleet default-on for the monitor (the digest job
  emits only where `digestTopicId` is set).
- Rollback: `enabled:false` → monitor inert, route 503s, job emits nothing. The
  state file is inert data.
- **Build order:** U4.3 merges first (the snapshot seam is this spec's data source).
  The two may share a PR per the shared-seam convention; U4.5's tests must not be
  skipped when combined.

## 6. Tests (tiers declared)

Unit: classifier per class incl. the heartbeat discriminator with the R-r3-1
semantics PINNED (post-onset beat + all-down ⇒ urgent; a FRESH-LOOKING but
pre-onset beat immediately after a lid-close ⇒ `peer-offline`, NEVER urgent —
the load-bearing false-alarm arm; heartbeat-stopped ⇒ `peer-offline`;
between-heartbeats death ⇒ `peer-offline` then late upgrade — both sides of
every boundary, R-r2-1);
self-wake grace window (post-own-wake, urgent suppressed until re-observation);
absent snapshot record ⇒ NOT-urgent (R-r2-minor); episodeKey determinism (both
sides compute the same key) + **adjacent-window grouping** (skew straddling a
quantization boundary still groups; beyond one quantum degrades to two groups —
R-r2-5); time-pinned debounce (a second evaluation inside `urgentDebounceMs` does
not fire — R-r2-2); sustained-clear (blip does not re-fire); split-brain-item
suppression; **transition-only state writes** (steady-state evaluations write
nothing; restart loses only intra-episode counters — R-r2-4); content scrub
(fixture rows containing IPs/emails/tailnet never reach output); **tailscale
`status --json` parser REGISTERED with captured byte-for-byte fixtures** (real
output incl. KeyExpiry — Scrape/Parser Fixture Realness) + bounded-exec behavior
(timeout kills; absent CLI ⇒ expiry tier silently absent + one debug log —
R-r2-3); state-file round-trip across restart. Integration: `GET
/mesh/rope-health` through the real HTTP pipeline (authed); attention item raised
via the real queue with episode dedup; digest send honors unset `digestTopicId`
(logs only — R-r2-8); metrics rows. E2E lifecycle (feature-alive): production
init with the flag dev-resolved → monitor constructed, its own 30s loop ticking,
`lastEvaluatedAt` advancing; dark → 503 + zero presence + no timer. Wiring-
integrity: the monitor owns its own loop (constructed + torn down by real server
boot/shutdown — R-r2-2) and reads the REAL resolver snapshot (not a copy). Live
two-machine drive (before fleet): tailscale logout on the dev pair → degraded
line appears; peer sleep → `peer-offline`, NO urgent item (the load-bearing
false-alarm test, live — the heartbeat stops); full network cut to a
heartbeat-advancing peer (simulated) → ONE urgent item per side, episode-grouped
post-heal.

## Frontloaded Decisions

1. **Productized in-server monitor** — the detector is instar source running its
   OWN bounded 30s evaluation loop (round 1's "subscribable coordinator tick"
   doesn't exist — R-r2-2) with a small durable, transition-only-written state
   file (R-r2-4); the G1 agent-home script becomes a consumer of
   `GET /mesh/rope-health`, never the mechanism (documented as an operator note
   in the digest job body + this spec — no repo artifact exists to patch).
   (Resolves the Migration-Parity violation and gives the urgent tier a real
   evaluation vehicle.)
2. **U4.3 is a HARD dependency for rope state** — no fallback data source exists;
   build order declared; absent snapshot records fail toward NOT-urgent. Tailscale
   key expiry has its OWN declared source (hourly bounded exec of `tailscale
   status --json`; absent CLI ⇒ tier silently absent — R-r2-3).
3. **Sleep-aware urgency on signals that EXIST (R-r2-1)** — urgent requires
   all-down + the peer's git-synced coarse heartbeat still advancing
   (mesh-independent proof of a live-but-partitioned peer) + the time-pinned
   debounce; a lid-close classifies `peer-offline` because the heartbeat stops
   (round 1's "graceful sleep announcement" gate named a signal that exists
   nowhere). A self-wake grace window suppresses urgent over stale post-wake
   snapshots. Residual declared: death between coarse heartbeats reads
   `peer-offline` first — late-but-honest. The suppressed-false-alarm count is a
   metric, so the gate's value is measurable.
4. **Honest partition semantics** — at most one item per SIDE per episode; two-sided
   duplication during a true partition is accepted and declared (coalescing during
   the event is structurally impossible); deterministic shared episodeKey groups them
   post-heal across ADJACENT quantization windows (best-effort declared — R-r2-5);
   the split-brain item wins if already open.
5. **Only all-down-with-advancing-heartbeat escalates** — a degraded rope with a
   healthy alternative is digest-only; key expiry warns at 14 days in the digest,
   delivered to `monitoring.ropeHealth.digestTopicId` (default unset ⇒ log-only —
   R-r2-8) via the enabled-but-503-silent `rope-health-digest` job (a deliberate,
   argued divergence from the feedback-factory precedent, which ships
   enabled:false; frontmatter frontloaded — R-r2-7/R-r3-2).
6. **Content scrub is a hard rule** — kind + nickname + relative expiry only.
7. **Maturation Path compliance** — live-on-dev day one via the dev gate, with the
   urgent tier's action-bearing question answered by an explicit
   `DEV_GATED_FEATURES` justification (episode-deduped, sleep-gated,
   operator-mandated partition alerting; `degradationLadderNeverSilent`
   precedent — R-r2-6); named graduation criteria; G3 loadBearing registration.

## Open questions

None.
