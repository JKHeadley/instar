---
title: "Multi-Machine Lease & Poll-Ownership Robustness"
slug: "multimachine-lease-poll-robustness"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "multimachine-lease-poll-robustness.eli16.md"
lessons-engaged:
  - "P14 Distrust Temporary Success: B3 fixes a symptom over a no-shared-CAS foundation — surfaced honestly as a bounded mitigation, not a substrate fix."
  - "P2 Signal vs Authority: B4/B5 observe-only; B1's only authority (start/stop ingress) fails toward keep-current, never surprise-silence."
  - "P17 Bounded Notification Surface: every Attention item has a stable dedupKey + burst-invariant test, routed through the budgeted funnel."
  - "P19 No Unbounded Loops: B1 poll churn + B2 latch both carry caps + loud terminal states."
  - "ship-dark = live-on-dev: every flag OMITS enabled (dev-gate resolves) + dryRun:true — never literal default-off."
review-convergence: "2026-06-20T19:29:03.068Z"
review-iterations: 2
review-completed-at: "2026-06-20T19:29:03.068Z"
review-report: "docs/specs/reports/multimachine-lease-poll-robustness-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex-not-installed; gemini-license-invalid"
single-run-completable: true
approved: true
approved-by: "operator-preapproval (24h autonomous run, 2026-06-20)"
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 2
---

# Spec: Multi-Machine Lease & Poll-Ownership Robustness

**Status:** draft (convergence round 2)
**Tracks:** CMT-1710 · the 2026-06-20 multi-machine audit
**Base:** JKHeadley/main @ v1.3.632

## Problem (grounded in real incidents)

The agent runs as ONE logical agent across ≥2 machines. On 2026-06-20 it suffered recurring failures tracing to a few structural seams: **double-handling** (a topic served on BOTH machines), **total silence** (ZERO machines polling for ~3.5h), **lease flap** (awake/standby flipping every ~2 min; epoch climbing), and a **broken cross-machine handshake** (`stale-timestamp` 403s from a transient post-reboot clock skew). Phase 0 stabilized this operationally (preferred-captain + restored mesh + clock re-sync). This spec closes the structural gaps permanently, fleet-wide.

## Current state (v1.3.632, code-grounded — corrected facts)

| Area | Exists today | Gap |
|---|---|---|
| 1. Poll↔lease | Lifeline (separate process) polls iff static `multiMachine.telegramPolling !== false` (`telegramPollOwnership.ts:28`), decided ONCE at boot. The "(lease detected)" log is the INTRA-machine server↔lifeline file lease (`server.ts:5493`), unrelated to the fenced `LeaseCoordinator`. | The fenced-lease role never drives polling. Runtime promotion → no poll start (silence); lease loss → keeps polling (dual-poll). |
| 2. churnDetector | DEAD CONFIG: `{maxFlipsPerWindow:4, windowMs:600000}` (`ConfigDefaults.ts:794`), **zero consumers**. | The flap circuit-breaker does not exist. |
| 3. Renew vs re-acquire | `tickLease` renews iff `holdsLease()` else re-acquires epoch+1. The renew tick is the **hardcoded** `HEARTBEAT_CHECK_INTERVAL_MS = 120s` (`MultiMachineCoordinator.ts:63`), NOT config. **Default `leaseTtlMs = 2×ingressHeartbeatMs = 60s`** → lease ALWAYS lapses before the next renew → epoch climbs every tick. This is the SHIPPED DEFAULT (not the 90s override). | The renew cadence is a constant > TTL. `validateSeamlessnessInvariants` has no renew/TTL invariant. |
| 4. Clock-skew | MeshRpc binary-rejects `|now−env.timestamp|>30s` (`MeshRpc.ts:281`) against the SIGNED envelope ts; NO measurement/surfacing. A separate 5-min placement-skew FSM (`MachinePoolRegistry.ts`) exists. Crucially: lease `presumedDeadHolders`/`allPeersPresumedGone` key on the **skew-contaminated** `lastSeen` (writer's wall clock), while registry liveness uses the **skew-immune** `routerReceivedAt`. | The 30s-mesh vs 5min-placement gap silently breaks the lease handshake under skew. No offset measured/surfaced. The lease layer's skew-contaminated liveness is the flap's root trigger. |
| 5. Exactly-one-listener | None. Only reactive 409 backoff (`TelegramLifeline.ts:997`) + intra-machine file lease. | No pool-wide poller-count; 0 (silence) and ≥2 (dual-poll) both silent. The 409 conflict is the one partition-immune dual-poll signal, used only for local backoff today. |

## Frontloaded Decisions (all resolved — no live user-decisions remain)

1. **Flag posture (ALL items):** each new flag OMITS `enabled` so `resolveDevAgentGate` yields live-on-dev / dark-on-fleet, with `dryRun: true` first. NOT literal `enabled:false` (that starves dev dogfooding — the named anti-pattern).
2. **B3 renew mechanism:** introduce a dedicated **renew timer** decoupled from `HEARTBEAT_CHECK_INTERVAL_MS`, sized `renewIntervalMs = clamp(leaseTtlMs × 0.5, [5s, 60s])`. It NEVER throws — it only ever shortens an internal interval (auto-correct + one log line). No startup-reject invariant is added (default TTL 60s already "violates" the naive check; a reject would refuse fleet startup). The shared heartbeat-check loop is untouched.
3. **B3 resilient-renew predicate (split-brain-safe):** on a tick where `holdsLease()` is false, renew SAME-epoch ONLY when ALL hold: (a) `selfIssued.holder === self`, (b) the self-lapse is recent (`monotonicNow − lastRenewOkMonoMs < leaseTtlMs × 2`), AND (c) **the renew is CONFIRMED over a genuine shared medium this cycle** (tunnel broadcast acked OR git CAS accepted). `LocalLeaseStore.refresh()` is explicitly EXCLUDED as confirmation (it is a local tautology). If the medium is down → fall through to the existing self-suspend / soloCaptainHold (already gated on `allPeersPresumedGone`). This NEVER relaxes the monotonic self-fence.
4. **B1 poll-start gate:** START polling only when (poll-intent says awake) AND (no peer is observed advertising `pollingActive`) AND (no recent Telegram 409 from another poller). START debounce = `pollStartDebounceMs` default 20s, **skipped (immediate start)** when no other poller is observed (a genuine failover, not a flap). STOP is immediate on lease loss. Under uncertainty (stale/corrupt intent, can't confirm peer state) → **hold current state** (never a surprise stop; never start blind).
5. **B1 intent-file integrity:** `state/telegram-poll-intent.json` carries `{shouldPoll, leaseEpoch, role, serverPid, bootId, ts}`, written atomically (tmp+rename). Lifeline IGNORES it (treats as "no current opinion" → hold current) if `ts` is stale (> `pollStartDebounceMs × 3`) or `serverPid` is not alive. Server writes `{shouldPoll:false}` at boot before role is known, and on graceful shutdown. Threat model stated: local same-uid IPC (parity with `TelegramPollOwnerLease`); no expansion of the existing trust boundary; never network-reachable.
6. **B1 actual-poll truth:** the lifeline (not the server) owns whether `getUpdates` is running. The lifeline writes `state/lifeline-poll-active.json` when it actually has an in-flight poll; B5 reads THAT, not the server's intent.
7. **B1 Phase-0 pin migration:** existing agents carry Phase-0 `multiMachine.telegramPolling` pins. When `pollFollowsLease` is active, a pre-existing `telegramPolling:false` is honored as `force-mute`; `telegramPolling:true`/absent is NOT treated as force-poll (it defers to the lease) — so two Phase-0-pinned machines do NOT become a permanent dual-poll. `force-poll` requires the NEW explicit `multiMachine.pollOverride: 'force-poll'` (local config only, never a peer/RPC).
8. **B2 latch target (deterministic):** on `>maxFlipsPerWindow` flips in `windowMs` (defaults 4 / 600000, cited), latch to a DETERMINISTIC role: the `preferredAwakeMachineId` machine latches AWAKE, others latch STANDBY → exactly-one-awake resting state (never an uncorrelated snapshot). Self-only (never writes a peer's role). Hard cap: if it re-latches > `maxLatchesPerHour` (default 3), stop auto-resetting and raise ONE HIGH Attention item (a machine that can never settle is an incident). Calm-window auto-reset = `windowMs`.
9. **B4 attribution:** offset measured via round-trip (NTP-style `((t1−t0)+(t2−t3))/2`) on the 5s pull RPC, from the SIGNED `env.timestamp`, read BEFORE the 30s reject gate (observe-only doesn't need replay protection to record). Each machine ALSO checks its OWN NTP sync (`sntp`/`timedatectl`) and alarms about ITSELF when unsynced — never a confident finger-point at the peer. Track `max(ewma, lastSample)` (a step-skew, the real incident, must alarm immediately, not lag behind an EWMA). Alarm threshold `meshClockAlarmMs = 20000` (⅔ of 30s), hysteresis clear at 12s, dedupKey `mesh-clock:<peerFp>`.
10. **B4 headline fix:** migrate lease `presumedDeadHolders`/`allPeersPresumedGone` to derive liveness from the skew-immune `routerReceivedAt` registry view (PRIMARY mechanism — the in-process `MachinePoolRegistry.observed` map). FALLBACK for a peer known-on-disk-but-not-yet-observed-in-process (no `routerReceivedAt` yet): subtract measured `observedOffsetMs` from `lastSeen`, preserving the current "not presumed dead until positively aged out" semantics. This removes the dual-source disagreement that is the flap's root trigger. Flag-gated.
11. **B5 three-valued + 409:** the poller-count guard is `ok` (exactly 1 FRESH poller) / `dual` (≥2 fresh — actionable) / `indeterminate` (a peer is dark → suppress 0/≥2 alarm, surface "can't confirm ingress"). It cross-checks the Telegram 409 signal (partition-immune evidence of a 2nd poller even when heartbeats are dark). `pollingActive` is added to the capacity heartbeat fail-OPEN; a missing field from an older peer (mid-rollout) = `unknown`, fails toward NOT false-alarming.
12. **Rollout ORDER (enforced):** B3 + B4 (substrate correctness) ship/graduate FIRST; then B2 (flap breaker); then B5 (observe-only poller-count); B1 LAST and gated — B1 going live REQUIRES B2 + B5 live (B1 no-ops with a logged warning if poll-churn exceeds a floor and no breaker is active). This prevents B1-without-B2 reintroducing the silence/dual-poll incident.

## Design — the 5 build items

(Each item: behavior, coherence posture, fail direction, flag. All reuse existing 1.3.632 machinery. All single-machine no-ops.)

### B1 — Poll-ownership follows the fenced lease (runtime, gated, fail-safe)
Per Decisions 4–7,12. Server writes the integrity-stamped poll-intent file on `reconcileRoleToLease` (promotion writes from the 5s pull path too, not just the 2-min tick, so failover isn't delayed). Lifeline `reconcilePolling()` on its existing 15s loop. **Coherence:** the intent file + `lifeline-poll-active.json` are machine-local-by-design (each machine's own server↔lifeline). **Fail:** stale/corrupt/missing intent → hold current (never surprise-stop, never start blind). **Flag:** `multiMachine.pollFollowsLease` (omit enabled; dryRun first). Inert single-machine (no leaseCoordinator → no intent writes).

### B2 — churnDetector consumer (deterministic flap breaker)
Per Decision 8. Flip-counter over `reconcileRoleToLease` transitions; deterministic latch to `preferredAwakeMachineId`; hard cap + HIGH Attention on repeated latching; self-only. **Coherence:** churn audit log machine-local; Attention dedupKey `lease-churn:<machineId>:<episode>` (a 2-machine flap → bounded items). Surfaced on `/guards` (+ `?scope=pool` free via the manifest). **Flag:** the existing `leaseSelfHeal.churnDetector` config block (omit `enabled` so the dev-gate resolves; dryRun first).

### B3 — Stop the epoch climb (decoupled renew timer + confirmed same-epoch renew)
Per Decisions 2–3. Dedicated renew timer < TTL (never throws); confirmed-medium same-epoch renew on transient self-lapse, LocalLeaseStore.refresh excluded as confirmation, monotonic self-fence preserved, staleness-bounded. Add `renewIntervalMs` to the resolved config + `validateSeamlessnessInvariants` as a CLAMP (log, never reject). **Coherence:** machine-local timer. **Flag:** `leaseSelfHeal.resilientRenew` (omit enabled). The timer-decouple/clamp is gated by the same flag (NOT default-on — contested-and-rejected as a fleet-wide uncaged lease-timing change). **Foundation honesty:** this is a bounded mitigation over the no-shared-CAS `LocalLeaseStore` substrate, NOT a substrate fix (the shared-CAS redesign remains a tracked non-goal); B3 makes the 2-machine case behave correctly *when the medium is up*, and self-suspends safely when it's down.

### B4 — Measure/surface/alarm clock-skew + skew-immune lease liveness
Per Decisions 9–10. Round-trip offset on the 5s pull from the signed envelope ts (pre-verification read); own-NTP self-check; `max(ewma,last)`; surfaced in `getSyncStatus()`/`/guards` (coarse `clockSkewStatus` only on unauth `/health`; raw per-peer offsets + machine IDs ONLY on Bearer-authed `/guards`). The `presumedDead` liveness migration to `routerReceivedAt`. **Coherence:** offset is machine-local measurement, surfaced per-machine, not replicated; `mesh-clock` guard dark-peer-tolerant. **Flag:** `multiMachine.clockSkewGuard` (omit enabled); never changes the reject decision.

### B5 — Exactly-one-listener pool guard (three-valued + 409 cross-check)
Per Decision 11. Pool-scoped via the existing `?scope=pool` fan-out; reads `lifeline-poll-active.json`-sourced `pollingActive` from heartbeats; three-valued; 409 cross-check; dark-peer-tolerant (`indeterminate`, no false alarm). Guard `telegram-poll-ownership` in `GUARD_MANIFEST` (lint-satisfied). Attention dedupKey `poll-ownership:<state>`. **Coherence:** pool-scoped read, dark-peer-tolerant. **Flag:** `multiMachine.pollOwnershipGuard` (omit enabled); observe-only, never gates a send. Single-machine → `ok` (self is the one poller).

## Testing (three tiers + partition fault-injection + burst-invariants)
- **Unit:** B1 `(leaseRole × pollIntent × override × peerPolling × 409)` truth table incl. the degenerate zero-poller / forced-dual / stale-intent / prior-boot-PID cells; B2 deterministic-latch-to-preferred + hard-cap terminal; B3 sole-holder with TTL<tick asserts NO epoch climb over 50 ticks (RED today) + confirmed-only same-epoch + LocalLeaseStore-excluded + staleness-bound + clamp-never-throws (incl. default 60s TTL); B4 round-trip attribution + step-skew immediate alarm + own-NTP self-blame + hysteresis dedup; B5 three-valued + 409 cross-check + missing-field=unknown.
- **Integration (two in-proc servers + a TRANSPORT-PARTITION fault injector — drop mesh RPC both directions while both servers stay alive):** B1 lease move A→B flips intent + (simulated) lifeline start-on-B/stop-on-A; **partition → both-awake → assert no dual-poll survives (409-gate + poller-count catches it)**; B3 two servers, no epoch climb over 5 min, AND partition → old-awake self-suspends (no same-epoch blind renew); B4 inject skew → alarm fires before 30s + `routerReceivedAt` liveness unaffected; B5 `/guards` poller-count incl. dark-peer=indeterminate.
- **Burst-invariant (P17):** persistent fault for K ticks → exactly ONE Attention item per source (B2/B4/B5), updated not re-created; recovered → resolved.
- **E2E:** production-init boot with all flags on → `/guards` 200 with the 3 new guards. The LIVE two-host harness (separate Phase-4 spec) is the named completion gate: B1/B5 are NOT fleet-eligible until it proves exactly-one-listener end-to-end (the bug-fix evidence bar forbids graduating on simulated-only evidence).
- **Migration parity:** flags via `ConfigDefaults.ts` under existing `multiMachine`/`leaseSelfHeal` keys (`applyDefaults` add-missing deep-merge backfills existing agents — no bespoke migrateConfig block). Guard-manifest entries are code constants (reach agents via code update; lint-enforced). CLAUDE.md via `generateClaudeMd()` + content-sniffed `migrateClaudeMd` (the 3 guards + the clock-drift early-warning + the poll-follows-lease behavior, with proactive "why did it go silent / why did the role flip?" triggers). Poll-intent + lifeline-poll-active files are server/lifeline-created lazily (no migrator).

## Rollout
Graduated dark→dev(dryRun)→dev(live)→fleet, in the ENFORCED ORDER of Decision 12 (B3,B4 → B2 → B5 → B1-gated-on-B2+B5). Every item a single-machine no-op and a clean kill-switch returning exact current behavior.

## Non-goals (tracked)
- A shared-CAS lease substrate replacing per-machine `LocalLeaseStore` — larger redesign; B3 is the bounded mitigation, not the substrate fix.
- Phase-2 seam work (registry tmux-reconciliation, OwnershipReconciler live, startup config validation) — separate spec.
- The Phase-4 live two-host harness — separate spec (named here as B1/B5's completion gate).

## Open questions
*(none)*
