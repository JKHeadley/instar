---
title: "Speaker-Election Owner-Liveness — a dark owner must not silently hold a topic's voice"
slug: "speaker-election-owner-liveness"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "speaker-election-owner-liveness.eli16.md"
lessons-engaged: "Cross-Machine Seamlessness (one-voice invariant), Judgment Within Floors (deterministic election floor), the existing rule-4 dark-holder precedent in SpeakerElection.decideInner"
review-convergence: "2026-07-11T22:38:22.917Z"
review-iterations: 3
review-completed-at: "2026-07-11T22:38:22.917Z"
review-report: "docs/specs/reports/speaker-election-owner-liveness-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "ran rounds 1-3, non-material throughout"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true  # operator standing session-wide preapproval, topic 11960, 2026-07-11
---

# Speaker-Election Owner-Liveness

> CMT-1956 / ACT-1190. `SpeakerElection.decideInner` decides, on a multi-machine
> pool, which single machine speaks for a topic (the one-voice invariant: exactly
> ≥1 machine speaks, never two). Rule 1 ("live placement owner wins") and rule 2
> ("durable stamp fallback") defer to a resolved owner **without checking that
> owner is ONLINE** — so a DARK owner (offline / not in the online pool) makes
> this machine return `owner-other` (silent), and the dead owner "holds" the
> topic's voice with NOBODY speaking. This is the ladder's declared election
> exception; this spec retires it.

## Glossary (local terms)

- **voice** — the right to emit for a topic on a multi-machine pool; the election grants it to exactly one machine (the one-voice invariant).
- **dark** — a machine that is not in the ONLINE set (`poolMachineIds()`): offline, unreachable, or not heartbeat-fresh. It cannot actually speak.
- **placement owner** — the machine `resolveTopicOwner(topicId)` currently resolves the topic to (rule 1).
- **stamp owner** — a durable recorded owner (e.g. a commitment's stamped owner), the rule-2 fallback when no live placement owner resolves.
- **lease holder** — the machine holding the serving lease (`leaseHolderId()`), the rule-4 fallback.

## Problem statement

`decideInner` (`src/monitoring/SpeakerElection.ts`) resolves an owner and, if
present, defers to it: `owner-self` → speak, `owner-other` → silent. Rule 4 (the
lease-holder fallback) ALREADY guards liveness — a "stable lease pointing at a
machine that can't speak (holder dark)" falls through to the deterministic
lowest-online-id tiebreak so ≥1 machine keeps speaking (lines 152-164). Rules 1
(placement owner) and 2 (stamp owner) do NOT apply that same guard: a resolved
owner that is DARK still wins, and this machine stays silent for a voice nobody
can use. On a two-machine pool where the placement/stamp owner has gone dark, the
result is **pool-wide silence for that topic** — the exact failure the one-voice
invariant's "≥1" half exists to prevent.

`pool` in `decideInner` is `poolMachineIds()` = the ONLINE machines (rule 4 uses
`pool.includes(holder)` as its liveness test, line 156). The fix is to apply the
same `pool.includes(owner)` liveness test to rules 1 and 2.

The naive form of this change — "defer to the owner only when `pool.includes(owner)`"
— is UNSAFE, and adversarial review proved it against the code. `poolMachineIds()`
is each machine's LOCAL liveness view, not a consensus. Two consequences:

- **The ≤1 (never-double-speak) trade (adversarial-R1 F1).** If machine B falsely
  reads a genuinely-live owner O as dark (a stale heartbeat / brief partition), B
  falls through and can `speak` via the tiebreak WHILE O returns `owner-self:speak`
  — two speakers. Pre-change, B's liveness-blind `owner-other` (silent) kept ≤1
  under exactly this asymmetry. Trading the paramount ≤1 guarantee (the constitution's
  "I never double-reply") for ≥1 is the WRONG direction — a transient silence (the
  user resends) is strictly less bad than a double reply.
- **The self edge (adversarial-R1 F2).** `pool.includes(owner)` also gates
  `owner === self`; if self's own row is momentarily stale in its pool view, the
  LIVE owner self-silences → pool-wide silence.

There is also a LOAD-BEARING prerequisite: the liveness SIGNAL itself is polluted,
so a naive guard would silently NO-OP in its exact target scenario. This ships in
THREE layers.

### Layer 0 — fix the polluted liveness signal (the prerequisite; without it the feature no-ops)

`pool` membership uses `online = now − routerReceivedAtMs < 15min`
(`MachinePoolRegistry`), where `routerReceivedAtMs` is the LOCAL receipt time. But
the coarse pool-refresh loop (`server.ts` ~15414) iterates `hbApi.listAll()` and
calls `recordHeartbeat({ selfReportedLastSeen: r.lastHeartbeatAt })` for EVERY
heartbeat record every ~30s — including a DEAD peer's git-synced heartbeat file —
and `recordHeartbeat` stamps a FRESH `routerReceivedAtMs` unconditionally. So a
dead peer with a lingering synced file stays `online:true` FOREVER locally
(integration-R1). A guard keyed on `pool.includes(owner)` therefore passes for a
dead owner and the whole feature silently no-ops. **Fix:** gate that coarse
re-record on the record's SELF-REPORTED freshness — skip `recordHeartbeat` when
`r.lastHeartbeatAt` is stale, so a dead peer's `online` correctly expires.
**Threshold calibration (adversarial-R2, load-bearing):** the staleness cutoff is
**≥2× the heartbeat WRITE cadence** (heartbeats write every ~30 min —
`DEFAULT_HEARTBEAT_INTERVAL_MS`, `MachineHeartbeat.ts` — so the cutoff is ~60 min),
NOT the 15-min online window. Keying it to the 15-min window would flap a
genuinely-LIVE-but-mesh-unreachable peer (git sync working, PeerPresencePuller
down) dark for ~half of every 30-min cycle — the exact "never mark a live peer
dark" violation, and Layer 0 lands LIVE. At ≥2× cadence a live peer (writing every
30 min) is always fresh; only a peer silent for >2 cadences (genuinely dead)
expires. This is a real, standalone bug affecting EVERY liveness read.

### Layer 1 — the self-safe liveness guard, SHIPPED DARK (observe-only)

- The guard is `liveOwner === self || pool.includes(liveOwner)` (F2 fix: self is
  NEVER dropped — self is authoritative about its own liveness).
- Rules 1 & 2 gain the guard, but behind a **dev-gated observe-only flag**
  (`monitoring.speakerElection.ownerLiveness`, omitted ⇒ dev-agent gate; `dryRun`
  default true). While dark/dryRun the verdict is **UNCHANGED** — a dark owner
  still wins (`owner-other`/silent, today's behavior); the guard only RECORDS a
  `would-fall-through` observation (topic, owner, self, online-pool snapshot) to
  a bounded audit so the real-world rate of "owner looked dark" — and how often it
  was a FALSE dark (O re-appeared within the dwell) — is measured before anything
  changes.

### Layer 2 — enforcement, DEFERRED behind a consensus-darkness condition <!-- tracked: ACT-1196 -->

Flipping the guard live (letting a dark owner fall through) is a SEPARATE, later
decision, gated on: (a) the observe-mode soak showing the false-dark rate is low;
and (b) a strengthened darkness signal so a LOCAL pool miss alone never takes the
voice — the owner must be **SUSTAINED-dark** (absent across ≥N consecutive checks
spanning the dwell window, not a single transient miss), which collapses the F1
split-view window. Even then, F1's residual brief double-speak window is
backstopped downstream by the existing per-inbound-event dedup ledger (keyed on
the platform event id — the constitution's "handled exactly once") AND the
duplicate-text suppression (per-topic, 15-min), so a transient election overlap
does not become a user-visible double reply. Enforcement is tracked (ACT-1196),
not built here.

**What lands now:** the mechanism + the F2-correct guard + the observation surface,
DARK. This retires the ladder's declared election exception STRUCTURALLY (the
owner-liveness input now exists and is measured) without the unsafe ≤1 trade — the
honest, safe way to land a change to the one-voice authority.

## Decision points touched

- `SpeakerElection.decideInner` rules 1&2 owner-defer — `invariant` (observe-only at ship): a deterministic liveness test `liveOwner === self || pool.includes(liveOwner)`, identical in kind to rule 4's existing `pool.includes(holder)` guard, behind a dev-gated dryRun flag so it changes NO verdict at ship (records the would-fall-through only); no competing signals, no judgment; the live enforce-flip is deferred (ACT-1196). <!-- tracked: ACT-1196 -->
- Layer-0 heartbeat re-record staleness gate — `invariant`: a deterministic freshness test (`r.lastHeartbeatAt` within ≥2× the heartbeat cadence) at the coarse pool-refresh loop; makes `online` honest, never marks a live peer dark.

## Non-goals

- No change to how ownership is RESOLVED (`resolveTopicOwner` / the stamp store)
  — only to whether a resolved owner that is DARK may hold the voice (and that only
  once the enforce-flip lands; DARK at ship).
- The owner-liveness guard changes NO verdict at ship (dev-gated dryRun); the live
  enforce-flip is deferred (ACT-1196), gated on soak + a sustained-dark signal. <!-- tracked: ACT-1196 -->
- Layer 0 (the heartbeat-staleness gate) DOES land live — it only corrects a
  polluted `online` reading and never marks a genuinely-live peer dark.
- Does not change `owner-self` / self-speak (the guard's `liveOwner === self`
  bypass keeps self authoritative about its own liveness — adversarial/integration F2).
- Does not touch the lease layer, the placement layer, or stale-owner-release
  (that feature MOVES ownership; this only decides the VOICE given current inputs).

## Alternatives considered (codex-R2)

- **Global consensus liveness (a replicated "who is online" agreed across machines)
  before deciding the voice.** Rejected for now: it is a much larger change (a
  consensus protocol over machine liveness) for a decision that already tolerates
  brief disagreement via dwell + downstream dedup; the incremental path is
  honest-local-signal (Layer 0) → measured observe (Layer 1) → sustained-dark
  enforce (Layer 2), each independently safe.
- **Immediate live enforcement of the naive `pool.includes(owner)` guard.**
  Rejected: adversarial review proved it trades the paramount ≤1 (never double-reply)
  for ≥1 and no-ops on the polluted signal — the exact two failures the layered
  approach avoids.
- **Wiring stale-owner-release's death-evidence into the election directly.**
  Deferred (ACT-1196): that IS the intended sustained/consensus darkness signal for <!-- tracked: ACT-1196 -->
  the enforce-flip, but it belongs behind the observe soak, not shipped blind.

## Multi-machine posture

This IS the multi-machine one-voice decision. **Honest correction (integration-R1
F3):** the election's liveness input (`poolMachineIds()`) is each machine's LOCAL
view (local heartbeat-receipt stamps), NOT a replicated consensus — so on ≥3
machines, transiently divergent views CAN yield a bounded double-speak window. The
spec does NOT claim "≤1 preserved by construction." Instead: (a) Layer 0 makes the
LOCAL signal honest (a dead peer expires instead of staying online forever), which
is a strict improvement to every liveness read; (b) the owner-liveness guard ships
DARK/observe-only, so it changes NO verdict and cannot break the invariant while
measured; (c) the enforce-flip (ACT-1196) is gated on a SUSTAINED-dark signal that
collapses the transient-skew window, with the residual overlap backstopped
downstream by the per-inbound-event dedup ledger + duplicate-text suppression so a
brief election overlap never becomes a user-visible double reply. No per-machine
durable state beyond the bounded observe-audit, no user-facing notice, no URL.

## Rollback

Revert the PR. Layer 0 (heartbeat staleness gate) reverts `online` to the prior
(over-permissive) reading; Layer 1 is dev-gated dryRun so reverting it changes
nothing live. No migration, no data. The enforce-flip (ACT-1196) is not in this PR. <!-- tracked: ACT-1196 -->

## Tests

- **Layer 0 (signal honesty), the load-bearing fix:** (0a) a peer whose
  `lastHeartbeatAt` is OLDER than the staleness cutoff (≥2× the 30-min heartbeat
  cadence, ~60 min) is NOT re-recorded by the coarse loop → its `online` expires →
  it leaves the pool (a dead peer stops looking live — the bug this fixes); (0b) a
  peer whose `lastHeartbeatAt` is within one cadence (~30 min, i.e. a live peer
  mid-interval, OR a live-but-mesh-unreachable git-syncing peer) is STILL
  re-recorded → stays online — a genuinely-live peer is NEVER flapped dark
  (adversarial-R2: the cutoff must exceed the write cadence, not the 15-min window).
- **Layer 1 (guard, dryRun/observe-only):** (1) DARK/dryRun (default) → verdict is
  BYTE-UNCHANGED from today for every rule-1/rule-2 case (a dark owner still wins);
  the would-fall-through is only RECORDED. (2) With the guard flipped live in the
  UNIT harness (to prove the LOGIC, not the ship state): rule 1 online owner →
  unchanged; rule 1 dark owner → falls through, exactly one online machine speaks;
  rule 2 dark stamp owner → same. (3) F2 — `owner === self` is NEVER dropped by the
  guard even when self is momentarily absent from its own `pool` view (the
  `liveOwner === self` bypass); self stays speaker, no pool-wide silence. (4)
  two-machine pool, owner dark, guard live in harness, run as BOTH machines →
  exactly one speaks. (5) a dark owner's fall-through verdict is dwell-held (no flap).
- **Wiring:** the observe-only flag defaults dryRun on a dev agent + dark on the
  fleet; the audit-record path is bounded (size cap + retention).

## Open questions

*(none)*
