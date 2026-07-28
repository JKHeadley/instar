---
title: Multi-Machine Lease Self-Heal & Preferred-Awake
status: draft
author: echo
created: 2026-06-20
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
approved: true
approved-by: "Justin (operator, telegram topic 27515)"
approved-at: "2026-06-20"
related:
  - docs/specs/multi-machine-lease-robustness.eli16.md
  - docs/specs/silent-standby-lease.md
  - docs/specs/standby-lease-holder-sync.md
eli16-overview: multi-machine-lease-self-heal.eli16.md
review-convergence: "2026-06-20T02:22:47.758Z"
review-iterations: 3
review-completed-at: "2026-06-20T02:22:47.758Z"
review-report: "docs/specs/reports/multi-machine-lease-self-heal-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "codex-not-installed"
---

# Multi-Machine Lease Self-Heal & Preferred-Awake

## Problem (found LIVE on the Echo Mini+Laptop pair, 2026-06-19/20)

The existing lease-robustness foundation (leapfrog tie-break, silent-standby observe-only,
standby-lease-holder-sync) is built and working. A live incident exposed four gaps that leave the mesh
stuck with **no awake machine** (`awakeMachineCount=0`, scheduler dark, StateManager read-only) and **no
self-recovery**:

1. **The lease tick can stop with nothing to recover it.** `MultiMachineCoordinator.startHeartbeatMonitor()`
   arms ONE boot-time `setInterval(checkHeartbeatAndAct, 2min)`; that callback (`→ tickLease`) is the ONLY
   path that calls `acquireIfEligible()`/`renew()`. On the live Mini the server log shows lease activity
   until exactly **00:15:00Z**, then **91 minutes of silence** while `/health` stayed 200 (event loop alive).
   The most consistent explanation (see "Root-cause of the stall" below) is a **never-settling `await` inside
   a tick leaving the `leaseTicking` reentrancy guard stuck `true`**, so every later tick early-returns.
   A lost/cleared timer is the other subcase. Nothing detects or recovers either.

2. **A standby cannot take over a non-renewing holder until presumed-dead (~15 min).**
   `FencedLease.canAcquire()` permits acquisition only when the lease is wall-clock EXPIRED or the holder is
   `presumedDead` (registry `lastSeen > 15min`). A holder whose `renew()` silently stopped but whose
   `lastSeen` is recent (heartbeat-write is a SEPARATE timer) returns `held-by-live-peer` and blocks takeover.

3. **A machine muted to silent-standby while holding a lease leaves a zombie.** `telegramPolling:false ⇒
   isLeaseObserveOnly ⇒ tickLease only reconciles role; never acquires, renews, OR relinquishes`. The muted
   ex-holder neither renews nor releases — it leaves a frozen `leaseHolder=self epoch=N` record in the
   durable store / effectiveView that peers defer to. (Live: the Laptop sat "holding" epoch 12747 as a
   silent standby; it reports `holdsLease:false` yet remains the named `leaseHolder`.)

4. **No preferred-awake policy.** Contested ties resolve by `winner = lower machineId`; nothing lets an
   operator say "the stationary Mini should be awake; the traveling Laptop defers."

### Root-cause of the stall (F1 must target the proven mechanism, not a guess)

`setInterval` does not stop on its own (it re-fires regardless of callback throw). A 91-min silence with a
LIVE event loop (`/health` 200) has exactly three causes: (1) a **never-settling `await`** in a tick
(`renew`/`pullFromPeers`/`broadcast`) so the `finally` that clears `leaseTicking`/`leasePulling` never runs →
every subsequent tick early-returns on the stuck guard; (2) the timer was **`clearInterval`'d** without
re-arm; (3) a **true event-loop stall** (sync block / GC). The incident's signature — loop alive, tick
silent, and the stall *survived a `launchctl kickstart`* of the lifeline (which is NOT the server process) —
rules toward (1)/(2). F1 therefore targets (1) and (2) directly and **explicitly delegates (3) to the
existing out-of-process fleet/launchd watchdog** (a same-loop timer cannot catch a stalled loop — we do not
pretend otherwise).

## Goals

- The mesh **self-heals** from a stuck/lost lease tick with no human intervention, **for the proven
  mechanism** (hung-await / stuck-guard / lost-timer); a true loop stall is covered by the out-of-process
  layer-2 watchdog.
- A standby **takes over a demonstrably non-renewing holder** quickly and safely (fenced), using a
  **locally-clocked, skew-immune** signal — never a remote wall-clock subtraction.
- A machine that becomes a silent standby **relinquishes** any lease it holds (level-triggered) instead of
  leaving a zombie.
- An operator can declare a **preferred-awake machine**; the preferred machine wins ties **only while
  healthy**, the preference is **agreed across machines**, and the non-preferred never strands coverage.
- Every change that alters live authority is **flag-gated**, **range-validated**, and **live-verified on the
  real Mini+Laptop pair with a deterministic injected fault** (synthetic symmetric-state tests give false
  confidence — prior incidents).

## Non-goals

- Re-deriving the existing leapfrog tie-break / silent-standby / standby-sync work (this builds ON them).
- Telegram conversation-HISTORY migration across machines (a separate gap). <!-- tracked: topic-13481 (cross-machine conversation-history stranding; distinct workstream) -->

## Design

All four features live under ONE consolidated namespace `multiMachine.leaseSelfHeal` (M4) and a first-class
**lease-participation mode** replaces the overloaded `telegramPolling` flag (M3):

```jsonc
"multiMachine": {
  "leaseSelfHeal": {
    "tickWatchdog":       { "enabled": true,  "staleFactorMissedTicks": 5, "awaitTimeoutMs": 20000, "maxReArmsPerHour": 6 },
    "staleHolderTakeover":{ "enabled": false, "nonRenewalMissedObservations": 6 },
    "silentStandbyRelinquish": { "enabled": false },
    "preferredAwakeMachineId": null,
    "leaseRole": null,  // null ⇒ derived: telegramPolling===false ⇒ 'observe-only', else 'active' (back-compat)
    "churnDetector":     { "maxFlipsPerWindow": 4, "windowMs": 600000 }   // shared by F2 epoch-churn + F4 preferred-flapping
  }
}
```

`leaseRole ∈ { 'active' | 'observe-only' | 'deferential' }`. `isLeaseObserveOnly` is redefined as
`resolvedLeaseRole() !== 'active'`, where `resolvedLeaseRole()` = explicit `leaseRole` if set, else the
back-compat derivation from `telegramPolling`. F4 SETS the non-preferred machine's effective role to
`'deferential'` deterministically (closing the dropped diagnosis item E) — no human hand-edit of
`telegramPolling` required.

### F1 — Lease-tick self-heal (CRITICAL). Primary = bounded await; secondary = watchdog. Ships ENABLED.

**F1a — Bounded await (the actual cure for the proven hung-await stall).** ALL tick-path network calls —
`renew()`, `acquireIfEligible()`, `pullFromPeers()`, and the underlying `tunnel.broadcast()` — route through a
SINGLE `withTickTimeout(fn, awaitTimeoutMs)` helper (`AbortController` / `Promise.race`, default 20s). A call
that exceeds the budget rejects (logged), the tick's `finally` runs, and the guard clears. **Routing through
one helper makes the invariant STRUCTURAL and grep-auditable (N2): no tick-path `await` may exist outside
`withTickTimeout`** — enforced by a unit/lint test that fails if `tickLease`/`tickLeasePull` reach an
un-wrapped network method. This is what makes "the reentrancy guard structurally unable to stick" true by
construction rather than by remembering; the watchdog (F1b) is the backstop.

**F1b — Monotonic-clocked tick watchdog.** A second `setInterval` (independent, shorter cadence 60s so
detection latency isn't gated by the 2-min main cadence):
- Stamp `lastTickRunMonoMs = monotonicNow()` at the TOP of `checkHeartbeatAndAct()`, **before any
  early-return** (so a single-machine / no-leaseCoordinator agent stamps a healthy advancing value and the
  watchdog NEVER re-arms there — F1 is a genuine no-op on solo agents).
- Stamp `tickStartMonoMs` when `leaseTicking`/`leasePulling` is taken; clear on release.
- Each watchdog fire (wrapped in try/catch — **never throws out of the interval callback, never crashes the
  process**): if `monotonicNow() - lastTickRunMonoMs > 2min * staleFactorMissedTicks` (default 5 ⇒ 10 min,
  comfortably above a GC/sync stall, below the 15-min presumed-dead window), the main loop is stalled →
  `startHeartbeatMonitor()` (clears+re-arms). The reentrancy guards are reset **only if** their
  `tickStartMonoMs` is ALSO older than the same ceiling (so a legitimately-slow in-flight tick is never
  preempted — closes the double-tick race H4). Re-arm and guard-reset NEVER touch `lastRenewOkMonoMs`,
  `suspended`, `selfIssued`, or epoch state — recovery flows through the next normal `acquireIfEligible` tick.
- **Self-disarm:** if the watchdog re-arms more than `maxReArmsPerHour` (default 6), it stops re-arming and
  raises ONE deduped Attention item ("lease tick watchdog re-arming repeatedly — investigate") — a watchdog
  that fires constantly is itself the incident (guard-posture philosophy).
- Emit `tickStallRecovered` → an audit line in `logs/lease-selfheal.jsonl` (count + monotonic age).
- The watchdog reads `tickWatchdog.enabled` **live each fire**, so disabling it is immediate (no restart).

**Scope honesty (in the spec, per reviewers):** F1 recovers hung-await / stuck-guard / lost-timer (the
diagnosed subclass). A true event-loop stall freezes BOTH timers; that case is covered by the out-of-process
fleet/launchd watchdog (CLAUDE.md §Version-Skew Self-Recovery), cross-referenced here as layer 2.

**Why ENABLED is safe:** F1a only bounds calls that already tolerate failure (`broadcast` swallows errors;
`renew`/`acquire` retry next tick). F1b only re-arms a timer and (conditionally) resets booleans, never
touching authority/epoch/sign state; the ceiling-gated guard-reset cannot preempt a live tick; the callback
can't crash; it self-disarms if misbehaving. Worst case it re-arms a healthy timer (idempotent).

### F2 — Non-renewing-holder takeover, via a LOCALLY-OBSERVED MONOTONIC signal (DARK).

**Corrected mechanism (C1/C2/F-2):** do NOT key on `acquiredAt` (never refreshed on renew) or any remote
wall-clock stamp. Instead the standby tracks, per observed holder, `freshObservedMonoMs[holder]` on ITS OWN
monotonic clock — stamped **exactly when the holder's signed nonce watermark `lastNonceByHolder[holder]`
strictly advances**, and **only on the VERIFIED fold-in path** (after `acceptTunnelLease` passes the Ed25519
signature + epoch-floor + nonce-watermark checks), NEVER on the raw unverified `recordObserved` stream
(security round-2 LOW: a registered-but-compromised peer must not be able to advance a third holder's freshness
with an unsigned blob). A renewing holder re-signs with a strictly-greater `nextNonce()` each renew (`renew()`
DOES bump `nonce` + `expiresAt`), so a healthy holder's watermark — and thus `freshObservedMonoMs` — advances;
a non-renewing holder's does not. (Note: read the watermark `lastNonceByHolder[holder]`, NOT `observed().lease`,
which keeps only the highest *epoch* and would miss a same-epoch renewal.) Non-renewing:

```
// holder is someone else, lease not wall-clock-expired, holder not presumed-dead, flag on:
const lastAdvanceMono = freshObservedMonoMs.get(holder)   // monotonic, observer-clocked, set on VERIFIED fold-in
if (lastAdvanceMono != null && monotonicNow() - lastAdvanceMono > ttlMs * nonRenewalMissedObservations)
  return { can: true, reason: 'holder-not-renewing (nonce watermark stalled N observations)' }
```

- `nonRenewalMissedObservations` default **6** (6 missed renew-broadcasts ≈ 6× the renew cadence) — well clear
  of jitter and **strictly greater than** the holder's own 60s monotonic self-suspend, so a holder that would
  self-suspend does so BEFORE a peer takes over (no live-holder steal). Single-clock throughout: each machine
  measures elapsed time on its OWN monotonic clock and never subtracts a remote stamp ⇒ clock-skew immune.
- If no observation has ever been recorded for the holder (we just booted), fall through to the existing
  expired/presumed-dead gates (fail-closed; never grant takeover on absent data).
- Acquisition stays **fenced**: take at `max(seenEpoch)+1` via the existing CAS; contention + leapfrog
  tie-break resolve a real race. F2 widens *eligibility* only.
- **Anti-oscillation dwell (F-4 / M-R2-1):** a machine that just lost/relinquished the lease may not re-take
  via the F2 path for `dwell = ttl * nonRenewalMissedObservations` (≈6 TTLs). This is intentionally a DERIVED
  quantity (one knob — `nonRenewalMissedObservations` — governs both detection and re-take dwell, preventing an
  incoherent combination; not independently configurable). The dwell is necessarily `>> ESCALATE_AFTER_CYCLES
  (5) × leasePullIntervalMs (5s) = 25s`, so the dwell and the contested-resolver escalation can never race
  (the resolver escalates long before the dwell would permit a re-take). An epoch-churn detector — the same two
  holders alternating more than `churnDetector.maxFlipsPerWindow` (default 4) within `churnDetector.windowMs`
  (default 10 min) — fires the existing `splitBrainEscalation` instead of silently flapping.
- Reconciliation with the 15-min presumed-dead window (M1): when F2 takes over a `lastSeen`-fresh holder, the
  new holder drives a registry reconcile and `getSyncStatus` reports `takenOverWhilePeerLastSeenFresh:true` so
  the dashboard/escalation surfaces don't silently disagree about who is awake.
- Dark default; `enabled:false` ⇒ `canAcquire` byte-for-byte unchanged.

### F3 — Silent-standby relinquish, LEVEL-TRIGGERED (DARK).

**Corrected (H3/F-5):** there is no mid-run config-flip event (config needs a restart), and the live zombie is
a PERSISTED record from a prior process — so F3 is **level-triggered inside the observe-only tick branch**,
not edge-triggered:

- In `tickLease()`'s observe-only branch: if `resolvedLeaseRole() !== 'active'` AND the DURABLE effectiveView
  names self as `leaseHolder` AND not-already-relinquished-this-incarnation → call a NEW
  `leaseCoordinator.relinquishAndBroadcast()` once. (`relinquish()` today forces local expiry but does NOT
  broadcast and `forceLocalExpiry` is git-less-only; `relinquishAndBroadcast()` adds the signed broadcast so
  peers stop deferring even when the muted machine's only loop is reconcile-only.)
- Idempotent + safe at boot: works even with no local `selfIssued` (the *broadcast*, not local-state clearing,
  is what unblocks peers). Catches both the boot-silent and restart-applied-mute cases.
- **Tombstone wire representation (M-R2-3) — the `released` bit MUST be SIGNED (round-3 HIGH).** Add an optional
  `released?: boolean` field to `LeaseRecord` AND extend `FencedLease.canonicalize()` (and therefore
  `signLease`/`verifyLease`) to COVER it — so the signed canonical tuple becomes
  `[holder, epoch, acquiredAt, expiresAt, nonce, released]`. Without this the `released` bit would ride OUTSIDE
  the Ed25519 signature and a malicious relay could STRIP it (resurrecting the zombie) or INJECT it onto a
  healthy holder's renewal (forging a phantom release → unwarranted takeover). `acceptTunnelLease` MUST reject
  any record whose `released` presence/value doesn't match the signed payload. **Back-compat:** an absent
  `released` field canonicalizes identically to today (treat `undefined` as `false` in the canonical form) so
  existing signed leases from un-upgraded peers still verify byte-for-byte. **Implementation invariant (load-
  bearing):** the canonical form is a POSITIONAL array; canonicalize MUST OMIT the `released` element when it
  is absent/false (`if (released===true) arr.push(true)`), NOT always emit a 6th `false` slot — only the
  omit-when-false form keeps a legacy 5-element lease byte-identical AND keeps an upgraded signer's normal
  (`released:false`) renewal verifiable on an un-upgraded verifier. Lock it with a test:
  `canonicalize(legacy) === canonicalize({...legacy, released:false}) === canonicalize({...legacy, released:undefined})`. The tombstone is
  `released:true, holder=self, epoch=N`, carrying a fresh nonce **strictly greater than the relinquishing
  machine's own last renewal nonce** (so a concurrent in-flight genuine renewal cannot out-nonce it and
  resurrect deference). `acceptTunnelLease`/`effectiveView` MUST treat a verified `released` record as
  "epoch N released, not held" — it advances the nonce watermark but yields `currentHolder()=null` for that
  epoch, and is NEVER folded as an authoritative current-holder (closing the re-zombie path where a self-naming
  broadcast was folded back as a holder claim). Unit test: a tombstone with a tampered/stripped `released` bit
  FAILS signature verification.
- **Tombstone safety (F-8):** the relinquish artifact must NEVER compete at or below the epoch floor; it only
  declares "epoch N is released." A higher-epoch F2/normal takeover ALWAYS strictly dominates. Integration
  test: holder muted (F3) + peer takeover (F2) concurrently ⇒ exactly ONE holder at the higher epoch, never
  zero, never two; plus a test that the tombstone nonce strictly exceeds the relinquisher's last renewal nonce.
- Dark default.

### F4 — Preferred-awake policy, AGREED + HEALTH-GATED (opt-in, DARK).

**Corrected (H1/H2/F-7/F-10):**
- `preferredAwakeMachineId` is **machine-local config** (operator intent per box — NOT replicated state), but
  the *effective* preference is **gossiped read-only** so each machine can read the peer's declared preference.
  **Integrity (security M-R2-2):** the gossiped preference is carried on, and read ONLY from, the
  **machine-auth-verified, holder-pinned heartbeat/lease request** (the `authMiddleware` + `signRequest` path
  that already binds a heartbeat to its authenticated sender) — NEVER from an unverified observed-lease field.
  It is advisory, not folded into the canonical signed lease tuple. **A self-declared preference can ONLY
  WITHDRAW the declaring machine from contention (make itself deferential); it can NEVER force a peer awake** —
  so a compromised/misconfigured peer can at most suppress the preferred-awake feature (forcing the safe
  deterministic fallback), never redirect authority. F4 behavior applies **only on agreement**; on
  disagreement, absence, or an id that fails validation against the SAS-verified registry, fall back to the
  deterministic lower-machineId rule and raise ONE deduped Attention ("preferred-awake disagreement — using
  deterministic tie-break").
- **One shared `preferredIsHealthy(machineId)` predicate** (locally-clocked, same monotonic-observation signal
  as F2) gates BOTH effects:
  1. **Tie-break override:** in `resolveContestedSplitBrain`, the preferred contestant wins **only if
     `preferredIsHealthy(preferred)`**; a frozen/non-renewing preferred falls back to lower-machineId (so F4
     never selects a dead machine).
  2. **Deferential standby:** a non-preferred machine sets its effective `leaseRole='deferential'` and does
     not contend **only while it has observed a FRESH (within `ttl`) healthy preferred lease**; if the
     preferred is absent/expired/non-renewing it acquires normally. **Coverage guard (F-7/M6):** once it
     acquires because the preferred was down, it HOLDS for a minimum dwell (`ttl * nonRenewalMissedObservations`)
     before yielding back; a "preferred is flapping" detector (preferred lost > M times/window) pins the stable
     machine awake and raises Attention. The flapping detector uses the SAME `churnDetector` thresholds
     (`maxFlipsPerWindow=4`, `windowMs=10min`) as F2's epoch-churn detector. Invariant tested live:
     `awakeMachineCount` never sits at 0 for more than one TTL under a bouncing preferred.
- Opt-in (`null` ⇒ today's behavior exactly); dark + live-verified before any fleet default.

## Frontloaded Decisions

| # | Decision | Value | Justification | Reversibility |
|---|----------|-------|---------------|---------------|
| D1 | F1 ships enabled | yes | F1a bounds already-failure-tolerant calls; F1b is authority-neutral, ceiling-gated, can't crash, self-disarms. Directly fixes the live incident. | Live off-switch (`tickWatchdog.enabled:false`, read each fire — no restart). |
| D2 | `staleFactorMissedTicks` | 5 (10 min) | Above a GC/heavy-sync stall, below the 15-min presumed-dead window; the live silence was 91 min so any 5–30 min catches it. | Config; range-validated ≥2. |
| D3 | `awaitTimeoutMs` | 20000 | A lease broadcast/CAS that takes >20s is wedged, not slow. | Config. |
| D4 | F2 non-renewal signal | locally-observed monotonic, NOT `acquiredAt`/remote stamp | `acquiredAt` is never refreshed on renew; remote-stamp subtraction is clock-skew-unsafe (the design forbids it). | F2 dark; flag off ⇒ unchanged. |
| D5 | `nonRenewalMissedObservations` | 6 | 6 missed renew-broadcasts; strictly > the 60s self-suspend so no live-holder steal; clear of jitter. | Config; range-validated ≥1; dark. |
| D6 | F3 trigger | level-triggered in observe-only tick | No mid-run config event; the zombie is a persisted prior-process record. | Dark. |
| D7 | F4 config placement | machine-local, effective-preference gossiped, applied on agreement | Intent per box; replicating it creates partition write-conflicts; agreement avoids divergence flap. | Opt-in null=off; dark. |
| D8 | F4 set on which machines | the SAME value on ALL pool machines | A preference only works if contestants agree; divergence falls back to lower-machineId + Attention. | Opt-in. |
| D9 | Flags' machine placement | set ALL leaseSelfHeal flags on BOTH machines | either machine can be holder or standby; symmetric self-heal needs both to carry both behaviors. | Config. |
| D10 | Live-verify enable order | F3 on holder-capable machine first (clean relinquish), verify; then F2 on standby (induce a non-relinquishing stall), verify; then F4. | Isolates each recovery path. | n/a |
| D11 | churn/flapping threshold | `maxFlipsPerWindow=4`, `windowMs=600000` (10 min); SHARED by F2 epoch-churn and F4 preferred-flapping | 4 alternations in 10 min is unambiguous flapping, well above a single legitimate failover; window matches the staleFactor ceiling | Config; dark with parent feature; validated `maxFlipsPerWindow≥2`, `windowMs≥60000`. |
| D12 | anti-oscillation/coverage dwell | derived = `ttl × nonRenewalMissedObservations` (NOT independently configurable, BY DESIGN) | one knob governs both detection and re-take dwell, preventing an incoherent combination; necessarily `>> ESCALATE_AFTER_CYCLES×leasePullIntervalMs` so it can't race the resolver | n/a — derived. |
| D13 | `maxReArmsPerHour` | 6 | A healthy watchdog re-arms ~never; >6/hr means the watchdog itself is the incident → self-disarm + Attention. 6 tolerates a brief flap-then-settle without a false alarm. | Config; validated ≥2 (a floor of 1 could disarm self-heal after a single recoverable flap and strand the mesh). |
| D14 | F4 vs operator-explicit `leaseRole` precedence | explicit operator `leaseRole` WINS; F4 sets the *derived* role only when `leaseRole` is null; a non-null operator role that contradicts F4's preference raises the disagreement Attention (never silently overridden) | operator intent is authoritative over an inferred preference; consistent with F4's existing disagreement handling | Opt-in; dark. |

## Configuration validation

`staleFactorMissedTicks ≥ 2`, `awaitTimeoutMs ≥ 1000`, `nonRenewalMissedObservations ≥ 1`,
`maxReArmsPerHour ≥ 2`, `churnDetector.maxFlipsPerWindow ≥ 2`, `churnDetector.windowMs ≥ 60000`,
`preferredAwakeMachineId` is null or a string matching a SAS-verified registry machineId,
`leaseRole ∈ {null,'active','observe-only','deferential'}`. A nonsensical combination is rejected at startup
(joining the existing `multiMachine.*` validation) with a clear message — never a silent degrade.

## Cross-machine posture (mandatory declaration)

- **F1a/F1b state (`lastTickRunMonoMs`, `tickStartMonoMs`, re-arm counters):** machine-local BY DESIGN — about
  this process's timer/await health. No replication.
- **F2 observation freshness:** machine-local observer state, derived from the EXISTING replicated lease pull
  (proxied-on-read). The takeover CAS is the existing replicated path.
- **F3 relinquish:** machine-local trigger, replicated consequence via the signed lease broadcast.
- **F4 `preferredAwakeMachineId`:** config machine-local; effective preference **gossiped read-only** in the
  lease/heartbeat payload (advisory observability, never authority over our own acquisition). NOT a single
  replicated value (would have partition write-conflicts).

## Rollout

1. One PR: F1 enabled, F2/F3/F4 dark, `leaseRole` back-compat-derived.
2. Deploy to the Echo Mini+Laptop pair (the deploy restarts the Mini server, which also un-wedges the live
   stall as a side effect). Then **deterministic live-verify** (next section).
3. After soak: flip F2/F3 fleet-default; set the Echo pair's `preferredAwakeMachineId` to the Mini on BOTH
   machines.

## Testing (all tiers — Testing Integrity Standard)

- **Unit:**
  - F1b re-arms on a simulated stale `lastTickRunMonoMs`; resets a guard ONLY when `tickStartMonoMs` exceeds
    the ceiling and NOT when the in-flight tick is younger (both sides of the boundary); never mutates
    `lastRenewOkMonoMs`/`suspended`/`selfIssued`/epoch; callback swallows a thrown error (no process crash);
    self-disarms after `maxReArmsPerHour`.
  - F1a: an awaited call exceeding `awaitTimeoutMs` rejects and the guard clears.
  - **F2 regression guard (the round-1 bug): a holder that renews the SAME epoch every 30s for 10 min is NEVER
    `holder-not-renewing`.** F2 fires exactly when the monotonic observation is stale > `ttl*factor` AND flag
    on; unchanged when off; NaN/absent observation ⇒ fail-closed.
  - F3 relinquishes iff observe-only AND durable-holder-is-self; idempotent; tombstone never dominates a
    higher epoch.
  - F4 tie-break picks the preferred contestant ONLY when healthy, falls back on unhealthy/disagreement/unknown
    id; deferential standby acquires within bound when preferred down.
- **Integration:** `/health` syncStatus reflects a recovered tick + `leaseTickWatchdog`/`preferredAwakeMachineId`
  fields; flags gate behavior end-to-end; F3+F2 concurrent ⇒ exactly one holder at the higher epoch; **exceeding
  `maxReArmsPerHour` produces exactly ONE deduped Attention item AND a `disarmed:true` audit line** (a
  silently-disarmed watchdog would be a silent guard-failure — assert it surfaces).
- **E2E:** boot a coordinator, inject a stall via the test seam, assert `awakeMachineCount` recovers to 1
  (feature alive, not 503).
- **Wiring-integrity:** the watchdog timer is armed in `start()`, `unref()`'d, deps non-null; `lastTickRunMonoMs`
  stamped before any early-return.
- **Live (NON-NEGOTIABLE, deterministic):** on the REAL Mini+Laptop pair, using an **injectable stall seam**
  (force `leaseTicking=true` / stop calling `checkHeartbeatAndAct`) to FORCE the fault — not "wait for the bug".
  F2's skew test runs with a **deliberately injected clock offset** on one machine. F3 verification reads the
  RELINQUISHING machine's own `security.jsonl` role_transition (`reason: lease:silent-standby-relinquish`) —
  the holder's view alone cannot distinguish relinquish from unreachable. Evidence = timestamped `/health`
  syncStatus from BOTH machines across a controllable disconnect; assert Mini holds awake stably ≥30 min, no
  409 poll-war, no epoch flap.

## Migration parity (corrected — M2)

Add `leaseSelfHeal` (with the table defaults) to the `multiMachine` block in **`src/config/ConfigDefaults.ts`**.
`applyDefaults`/`deepMerge` (add-missing recursion) deep-merges it onto existing agents on update WITHOUT
clobbering an operator-set `preferredAwakeMachineId` — NOT a hand-written `migrateConfig()` block. **The
migration SEEDS `leaseRole` to the concrete resolved value (`telegramPolling===false ? 'observe-only' :
'active'`), NOT `null` (N1)** — so the `telegramPolling`-overload derivation path is RETIRED for every migrated
agent (the overload genuinely dies rather than lingering as the live default; the back-compat derivation
remains only for a hypothetical un-migrated config). Add a migration-parity test: an agent config lacking these
keys gains them (with defaults + a concretely-seeded `leaseRole`) after a migration pass, and an agent that
already set `preferredAwakeMachineId`/`leaseRole` is NOT overwritten.

## Agent Awareness (M7)

- `generateClaudeMd()`: a short note under the cross-machine section — `preferredAwakeMachineId` (what it does,
  set the same value on all machines to the stationary one), and that the lease-tick watchdog self-heals a
  frozen tick. Proactive trigger: operator asks "why does the laptop keep taking over?" → recommend
  `preferredAwakeMachineId`.
- `/health` syncStatus gains `leaseTickWatchdog: { lastTickAgeMs, reArmCount, disarmed }` and
  `preferredAwakeMachineId` + `takenOverWhilePeerLastSeenFresh` so the agent can answer "did the watchdog
  fire?" / "which machine is preferred?".

## Version-skew posture

F1/F2/F3 live entirely in the server process and are CAS-fenced, so a mixed-version pair (one machine updated,
one not) is safe — the new machine's widened eligibility is still resolved by the epoch CAS the old machine
honors. `lastTickRunMonoMs` is boot-reset, so a coordinated-restart can't trip the watchdog into a false stall.

## Risks & mitigations

- *F1 induces a concurrent double-tick* → ceiling-gated guard-reset + bounded await make the guard never stick;
  CAS tolerates any residual race.
- *F1 same-loop watchdog can't catch a true loop stall* → explicitly scoped out; layer-2 fleet/launchd watchdog
  covers it.
- *F2 over-eager / skew steal* → locally-clocked monotonic signal (no remote subtraction); strictly > self-
  suspend; dwell + churn-escalation; dark + injected-skew live test.
- *F3 relinquishes a needed lease / drops to zero holders* → only an observe-only machine (cannot serve)
  relinquishes; tombstone never dominates a higher epoch; concurrent-takeover integration test asserts exactly
  one holder.
- *F4 wrong machine silenced / divergent config* → agreement-gated + health-gated + lower-machineId fallback +
  Attention on disagreement; coverage dwell prevents a flapping-preferred gap.
- *F4 hostile-peer degradation-of-preference* → a compromised registered peer can perpetually declare a
  divergent preference, forcing the pool onto the deterministic lower-machineId fallback + a steady (deduped)
  Attention item. This is a bounded, safe-direction DENIAL of the preferred-awake feature — never a
  REDIRECTION of authority (a self-declared preference can only withdraw-from-contention, never force a peer
  awake). Accepted; the dedup bounds the noise.
