---
title: "Lease flap fix: judge peer liveness from live evidence, and stop using a git medium for a git-ignored registry"
slug: "lease-unconfirmed-candidate-flap"
author: "luna (sagemind)"
created: 2026-10-03
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "lease-unconfirmed-candidate-flap.eli16.md"
status: "approved"
approved: true
approved-basis: "Justin (verified operator, uid 7812716706, topic 47547) replied 'Approved' on 2026-10-04 01:55 PDT after reading the plain-language overview of v40, which asks for the fix plus two sign-offs. v41-v45 changed no behaviour the overview describes: a coordinator getter, corrected claims about forged receipts, wording, and the maturation plan. He is told of these with the build notice."
principal-deferral-approval:
  - item: "never-accepted lease detector (Out of scope)"
    status: "approved"
    by: "Justin Headley (operator), Telegram topic 47547"
    at: "2026-10-03T14:46:00-07:00"
    owner: "Echo (instar maintainer)"
    eta: "with deferred item (i): reported back within 14 days of merge"
  - item: "boot pull: learn the lease before contending at boot (Out of scope)"
    status: "approved"
    by: "Justin Headley (operator), Telegram topic 47547"
    at: "2026-10-03T15:41:00-07:00"
    owner: "Echo (instar maintainer)"
    eta: "reported back within 14 days of merge"
  - item: "restart nonce watermark (window (c), Out of scope)"
    status: "approved"
    by: "Justin Headley (operator), Telegram topic 47547"
    at: "2026-10-03T15:41:00-07:00"
    owner: "Echo (instar maintainer)"
    eta: "reported back within 14 days of merge"
  - item: "reliable holding with the only peer unreachable (window (d), Out of scope)"
    status: "approved as a separate change, before the Roblox topic moves"
    by: "Justin Headley (operator), Telegram topic 47547"
    at: "2026-10-03T16:05:00-07:00"
    owner: "Luna (sagemind), with Echo reviewing"
    eta: "specified and reviewed after this fix merges"
  - item: "GitLeaseStore deferred items (i), (ii), (v)"
    status: "approved"
    by: "Justin Headley (operator), Telegram topic 47547"
    at: "2026-10-04T01:55:00-07:00"
    owner: "Echo (instar maintainer)"
    eta: "reported back within 14 days of merge"
principal-ratification:
  - item: "reachability over strict single-holder, and the windows in the Safety posture"
    status: "ratified"
    by: "Justin Headley (operator), Telegram topic 47547, after reading the ELI16 snapshot of v40"
    at: "2026-10-04T01:55:00-07:00"
lessons-engaged:
  - "P2 Signal vs Authority: every change is a deterministic input to the existing FencedLease authority; no new authority is added."
  - "No Silent Degradation: a git medium that cannot carry the registry, an unbroken streak of unconfirmed acquisition writes (not a lease the medium never accepted that only renews), and a liveness feeder that never observes a registered peer each raise one DegradationReporter event."
  - "P10 / Phase 4.5 no-deferrals: the incident's trigger and amplifier are removed; each deferred item is classified individually and carries a principal-deferral-approval entry."
  - "P19 bounded loops: the git-ignored-registry path no longer runs synchronous git pulls every lease tick."
  - "P20 Verify the State, Not Its Symbol: lastSeen and coarse git heartbeats are demoted to symbols; the router's own live pull receipt and the holder's verified, nonce-advancing signed renewals are the corroborating state."
  - "P20 (an uninitialized liveness state cannot authorize recovery): applied without exception. A peer neither liveness source has ever observed is never dead and never gone, for every callback."
  - "B4 multimachine-lease-poll-robustness (skew-immune liveness): reused and extended."
  - "Live-User-Channel Proof Before Done: to be proven on throwaway agents over a demo Telegram group and a demo Slack channel before merge; the artifact names the tested revision, configuration and measured outcomes."
review-convergence: "2026-10-04T09:11:35.529Z"
review-iterations: 5
review-completed-at: "2026-10-04T09:11:35.529Z"
review-report: "docs/specs/reports/lease-unconfirmed-candidate-flap-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Lease flap fix

## Incident (2026-10-03, agent sagemind, instar 1.3.1318)

A laptop (A, awake holder) and a freshly joined Mac Studio (B, standby) were
paired, and they reached each other over Tailscale HTTP throughout.

**The two machines used different lease media.** A has `gitBackup.enabled:false`.
No git-sync manager is built, so A boots `LocalLeaseStore` (log: `Lease store:
LocalLeaseStore (no git medium …)`, `[local-lease] lease epoch N committed
locally`). B's `config.json` was scaffolded fresh by `instar join` without that
setting, so B boots `GitLeaseStore` over `.instar/machines/registry.json`. In this
agent repo that file has been untracked and git-ignored since commit a59b25c17
(2026-08-31), because lease commits were flooding history. Every git write B
attempts therefore goes nowhere.

On its first boot B logged `CAS lost to epoch 1 (our candidate 1)` →
`Lease reconcile → awake (lease-init)`, then settled as standby with
`acquire skipped: held-by-live-peer (A)` for about 20 minutes. Then, every tick:

```
[git-lease] push rejected/no-op; observed epoch now 44569
[lease] CAS lost to epoch 44569 (our candidate 44569) — yielding
[MultiMachine] Lease reconcile → awake (lease-tick)
[MultiMachine] Lease reconcile → standby (lease-pull)
```

A flapped in step (`acquired lease at epoch 44638/44640/44642`). `/health` showed
`awakeMachineCount: 2, splitBrainState: contested`. Every Telegram send was held
as `destination-not-authorized` until B was stopped.

## Root cause

The sustained flap had a trigger and an amplifier:

1. **Trigger: frozen `lastSeen` liveness.** `presumedDeadHolders` and
   `allPeersPresumedGone` judge a peer by the `lastSeen` in this machine's copy of
   the registry (`server.ts:5599-5662`). The only exception is the dev-gated
   skew-immune path (`multiMachine.leaseSelfHeal.skewImmuneLiveness`, B4), which
   is off on sagemind. A peer's `lastSeen` advances only on that peer's own
   git-carried heartbeat, or locally on any edit to that peer's registry entry:
   endpoints, handoff role or nickname (`MachineIdentity.ts:597-598`, `:668`,
   `:696`, `PeerEndpointRecorder.ts:87`, `machineRoutes.ts:938`). Neither proves the peer
   is live, and in the incident neither fired, so it was frozen on both sides. After
   `failoverThresholdMs` (15 min) each machine presumed the other dead
   (`holder-presumed-dead`, `FencedLease.ts:317`). Both were in fact pulling the
   other's status and receiving its signed renewals over HTTP the whole time.
2. **Amplifier: a git medium that cannot carry the registry, used silently, which
   reads back its own unconfirmed candidate.** `GitLeaseStore` is built whenever a
   git-sync manager exists; nothing checks that the registry is tracked.
   `GitLeaseStore.casWrite` saves the candidate before it pushes. After a failed
   push it reloads the working tree, which still holds B's own candidate, and
   reports that as the observed lease (`GitLeaseStore.ts:77-101`).
   `acquireIfEligible` then sees a self-held, unexpired lease and renews it, so B
   goes awake on a lease no medium accepted.

A third behaviour is visible in the log but did not cause the sustained flap: a
standby contends before it learns the current lease (`initializeLease` calls
`acquireIfEligible` before the pull loop starts, `MultiMachineCoordinator.ts:1201`
against `:1209`). That gives the first-boot blip above, which healed itself on
the first pull. Closing it is deferred (Out of scope).

## Design

Change 1 removes the trigger. Change 3 removes the amplifier. Change 4 makes two
remaining failure modes visible (an unconfirmed acquisition-write streak and a
blind liveness feeder); a never-accepted lease that only renews is not detected
(Out of scope). Each has a live-read switch (absent ⇒ on) under
`multiMachine.leaseFlapFix`; `mediumCheck` acts at boot, so a flip takes effect on
the next restart. Each flip is logged once when detected (Frontloaded 3).

| Switch | Off restores | Also governs |
|---|---|---|
| `liveness` | today's liveness rule (`isPeerPresumedDead`) | `sample()`, the unobserved-peer report, and where `acquireIfEligible` reads liveness |
| `mediumCheck` | today's store choice (git whenever a git-sync manager exists), the debouncer, and `gitSyncRef` for every consumer | the medium degradations; `/health` → `leaseMedium` reads `unchecked` where a git-sync manager exists |
| `unconfirmedWriteAlert` | no unconfirmed-write report | the `failoverThresholdMs <= leaseTtlMs` ordering check |

With all three off, every lease decision is today's and no new degradation event
is raised; the passive `/health` fields remain.

### Change 1 — peer liveness from live evidence, on every medium

Extract both `server.ts` closures (`presumedDeadHolders`, `allPeersPresumedGone`,
`server.ts:5599-5662`) into one builder in the existing
`src/core/leaseLiveness.ts`, beside today's `isPeerPresumedDead` (which
`liveness:false` keeps using):

```
buildLeaseLivenessCallbacks({ loadDiskRegistry, getRouter, getFreshness,
                              getLeaseFlapFixConfig, getSkewImmune,
                              failoverThresholdMs, bootMonoMs, monoNow, wallNow })
```

- `loadDiskRegistry` is today's `idMgr.loadRegistry()` (registered machines,
  `revokedAt`, `lastSeen`); `getRouter` returns the `MachinePoolRegistry`
  (receipts). They are separate inputs, as in today's closures.
- `getLeaseFlapFixConfig` reads the switches live, so `liveness:false` is
  decided inside the builder. `getSkewImmune` returns today's B4 gate
  (`resolveDevAgentGate(skewImmuneLiveness.enabled, config)`) and `wallNow`
  today's wall clock: with `liveness:false` the builder calls today's
  `isPeerPresumedDead` with exactly those inputs (`server.ts:5599-5620`,
  `:5643-5662`). Harnesses pass their injected clocks as `monoNow` and
  `wallNow`, give `MachinePoolRegistry` the same `wallNow` as its `now` and the
  same `failoverThresholdMs` (`server.ts:21218`), so the switches-off baseline reproduces today's decisions
  deterministically.
- `LeaseCoordinatorDeps` gains two optional live getters, for
  `unconfirmedWriteAlert` and `liveness`; an absent getter counts as on (the
  switches' own default). `acquireIfEligible` resolves `liveness` once at the
  start of each call and passes the resolved value to
  `presumedDeadHolders({ liveness })`, so every `presumedDeadHolders` read in that
  call uses one rule; other callers pass nothing and the builder reads the switch
  itself. The solo-hold path reached through `renew()` reads the switch live (it
  is dark by default). A flip takes effect from the next call. The E2E harnesses
  wire both getters.

- `getRouter` and `getFreshness` are getters read on every call: the router is
  constructed later in boot than the lease, and the freshness reads live on the
  `LeaseCoordinator` the callbacks are passed into (`server.ts:5596-5664`).
  `getFreshness` exposes `freshRenewalWithin(id, ms)` and
  `lastRenewalObservedMono(id)`.
- The builder is invoked once, at wiring. Each callback parses the registry once
  per invocation (it may cache per tick).
- It also returns `sample()`, which stamps per-peer `firstDialableMonoMs` and
  `firstRegisteredMonoMs` and evaluates the Change 4 unobserved-peer report. It
  reaches the coordinator through a new optional
  `LeaseCoordinatorDeps.sampleLiveness`. `MultiMachineCoordinator.tickLease`
  (`:1258`) calls it on every tick that runs (a tick returns early while the
  previous one is still running, `:1259`), on every branch, before any renew or
  acquire, and `initializeLease` calls it once at its start. No liveness verdict
  depends on what it stamps.
- One monotonic clock (`process.hrtime` by default, `LeaseCoordinator.ts:240-242`)
  is used for every stamp and comparison: `MachinePoolRegistry` gains an optional
  `monoNow` dependency, and the server passes the same function to it, to
  `LeaseCoordinatorDeps.monotonicNow` and to the builder.

**Sources.**

- (a) **Live receipt.** `MachinePoolRegistry` gains a separate per-peer map of
  `liveReceivedMonoMs` (not a field of the `observed` entry, which every beat,
  coarse ones included, replaces whole, `MachinePoolRegistry.ts:299`), stamped
  on non-coarse beats only (the only non-coarse
  peer writer is `PeerPresencePuller`, `PeerPresencePuller.ts:287`; coarse
  re-records from the git-synced heartbeat file, `server.ts:21483`, do not
  count) and exposed as `lastLiveReceiptMono(id)`. A receipt is fresh within
  `failoverThresholdMs`.
- (b) **Fresh renewal.** `freshRenewalWithin(id, failoverThresholdMs)` reads the
  existing `freshObservedMonoMs` map, stamped when a signature-verified holder
  nonce advance is first seen (`LeaseCoordinator.ts:291-297`), which happens
  inside `effectiveView()`. Today `acquireIfEligible` reads `presumedDeadHolders()`
  once before its loop calls `effectiveView()` (`:678`, `:682`). Under the fix
  that order would let a holder whose verified renewal arrives after a gap longer
  than `failoverThresholdMs` be judged dead against its own fresh, unexpired lease,
  and taken over. So, with `liveness` on, `acquireIfEligible` reads inside the loop,
  after `effectiveView()`, on every iteration, and the re-check after a lost write
  (`:717`) uses that iteration's set; with `liveness:false` it keeps
  today's single read before the loop, so a retry after a lost git write still
  uses today's verdict rather than one re-read from the registry that write
  pulled (`GitLeaseStore.ts:64`, `:96`). The other readers (`peerTakeoverEligible`
  `:642-647`, `acquireOnHandbackConsent` `:799-802`, `checkForUnresolvableSplit`
  `:966-967`) already call `effectiveView()` first; `soloCaptainHoldEligible`
  (`:398`) reads before its own `effectiveView()` (`:400`), but its only caller,
  `renew()`, calls `effectiveView()` first (`:843`). A unit test on a `GitLeaseStore`
  whose lost write pulls a fresher peer `lastSeen` asserts that `liveness:false`
  keeps today's verdict on the retry, and flips the switch between two calls.
- **Retention.** The receipt map is never pruned while the process runs (the
  registry has no eviction; it is built once, `server.ts:21221`); a restart is
  the only way it starts empty. While no router is available, or after a
  restart, source (a) reads "none ever": not dead and not gone, the safe
  direction, which a test pins.

**Classification**, for every registered peer other than this machine, with
today's revoked-peer filtering kept: `allPeersPresumedGone` omits peers whose
`revokedAt` is set (`server.ts:5646`), and `presumedDeadHolders` does not
(`:5599-5622`), classifying a revoked peer by its evidence like any other. A
fresh source wins; otherwise receipt history decides. `allPeersPresumedGone`
also keeps today's empty-set guard: with no non-revoked peers it returns false.

| Live receipt (a) | Renewal (b) | `presumedDeadHolders` | `allPeersPresumedGone` |
|---|---|---|---|
| fresh | any | alive | not gone |
| stale or none | fresh | alive | not gone |
| stale | not fresh | dead | gone |
| none ever | not fresh or none | not dead | not gone |

With no router, source (a) reads "none ever" for every peer. The rule never
consults `lastSeen`. Only receipt history can make a peer dead or gone: a
renewal comes only from a holder, and a holder whose renewals stop is taken
over when its lease expires, whatever this table says. So a peer seen only
through renewals stays "not dead" after they stop, the safe direction. A peer neither source has ever observed is never dead and
never gone (P20, no exception); takeover of its lease then rests on expiry,
which `canAcquire` checks before liveness (`FencedLease.ts:313`).

**Known effect on the dark solo-captain hold.** `allPeersPresumedGone` feeds
only `soloCaptainHoldEligible` (`LeaseCoordinator.ts:398`). Under Change 1 an
enabled hold engages later than on today's build in some cases, because it no
longer reads `lastSeen`. The hold is off on sagemind (`config.json:1188`), so
nothing changes in production; designing reliable holding is the separate
window (d) change, and its working notes are in
`docs/specs/notes/lease-existing-behaviour-notes.md`.

### Change 3 — do not build a git lease store over a registry git cannot carry

At the top of the git-sync block in `server.ts`, before the registry-sync
debouncer is wired, run `git ls-files --error-unmatch -- <registryAbsPath>` once,
with `cwd: config.projectDir`, through `SafeGitExecutor.readSync` (`ls-files` is a
read-only verb, `SafeGitExecutor.ts:103`) with a 2 s timeout. `readSync` rethrows
the `execFileSync` error unchanged (`:1236-1238`), so the result is mapped from
the error, never from "did it throw":

- **Exit 0** ⇒ **tracked** ⇒ `GitLeaseStore` plus the debouncer, as today.
- **`err.status === 1`** ⇒ the path is untracked, which is two different cases,
  split by a second read-only query, `git ls-files --others --ignored
  --exclude-standard -- <registryAbsPath>` (same `cwd`, executor and timeout):
  - **non-empty output** ⇒ **ignored** ⇒ `LocalLeaseStore`, debouncer not wired.
    Git will never carry this file (sagemind's case: `.gitignore:144` ignores
    `.instar/machines/`). With other machines registered, one degradation:
    "registry.json is git-ignored, so the lease uses the local store plus the
    network (a supported mode); tracking the file and restarting would move it to
    git." Otherwise one log line.
  - **empty output** ⇒ **untracked, not ignored** ⇒ `GitLeaseStore` plus the
    debouncer, as today: the first lease write stages and commits it
    (`GitSync.ts:587`, `:633-668`), so git will carry it. `reason:
    untracked-addable`.
  - an error from the second query ⇒ **check error**, as below.

  Both queries need the registry file to exist (for a missing file the second
  query prints nothing even when the path is ignored). It exists by then:
  `coordinator.start()` (`server.ts:4495`) writes it if this machine is missing
  from it (`MachineIdentity.ts:514-521`), and otherwise it was already present.
  An existence check runs first anyway; a missing file is a check error.
- **Anything else** ⇒ **check error** ⇒ keep `GitLeaseStore` and the debouncer,
  as today, and report one degradation naming the kind and saying it "will be
  re-checked at the next restart". Kind, in order: the file is missing ⇒
  `registry-missing`; `SafeGitExecutorError` or
  `SourceTreeGuardError` ⇒ `refused`; `err.code === 'ETIMEDOUT'` ⇒ `timeout`; a
  numeric `err.status` other than 1 ⇒ `git-exit-<status>`; a non-null
  `err.signal` ⇒ `signal-<name>`; any other `err.code` ⇒ `spawn-error`.

On `local`, a new `leaseGitRef` (equal to `gitSyncRef` when the medium is `git`
or `unchecked`, null on `local`) replaces `gitSyncRef` for the three lease consumers: the store choice,
`_hasDurableLeaseAuthority` (`server.ts:5711`) and the git branch of
`_staleOwnerSelfProof` (`:5737-5740`). Durable lease authority is then false, so
U4.2 refuses a 2-machine claim as it does on a git-less install. The backup
`gitSync` instance is untouched.

The check runs once per process: a registry that leaves the git index while a
process runs keeps that process on the git store until restart. Any change to
whether the registry is tracked needs a restart, and the awareness text says so.

`/health` → `multiMachine.syncStatus.leaseMedium` (`git` | `local` |
`unchecked`) with `reason` and `store` (the store actually built). `reason`, in
precedence order: `no-git-sync-manager` (always `local`), `switch-off` (with
`unchecked`), `tracked`, `untracked-addable`, `ignored`, `check-error:<kind>`. The field joins
`MultiMachineSyncStatus`, its unit test, and the agent-awareness text (CLAUDE.md
template plus a `PostUpdateMigrator` migration with a content-sniffing guard).

### Change 4 — make sustained unconfirmed writes and a blind liveness feeder visible

All reports are `DegradationReporter` events: internal, never a user notice or
Attention item, none escalating. None feeds `canAcquire`, `holdsLease` or
`_staleOwnerSelfProof`.

- **Unconfirmed acquisition writes.** On every `LeaseCoordinator` call to
  `store.casWrite` (`advanceEpochForContestedWin`, `acquireIfEligible`,
  `acquireOnConsent`, `acquireOnHandbackConsent`; renewals do not call it), a
  result of `ok: false` with an observed lease that is our own candidate, the read-back's signature, adds one. "Our own
  candidate" is the predicate `observed.holder === self && observed.epoch ===
  candidate.epoch && observed.nonce === candidate.nonce`: the same record handed
  back, not merely another record with the same holder and epoch. Any other result
  resets the count to zero: `ok: true` (a local commit or a pushed git write)
  or `ok: false` with a competing winner's lease (a normal lost race), so only
  an unbroken streak counts. At 5 it reports "lease writes remain
  unconfirmed by the medium" once per streak: the report fires when the count
  reaches 5, not again while the streak continues, and again only after a reset
  and a new streak of 5 (a unit test covers two streaks separated by a success).
  While `unconfirmedWriteAlert` is off the counter is not maintained: switching it
  off clears the count and the reported flag, and switching it on starts a fresh
  streak (tested: off at 4, failures while off, on again). Renewals are
  not counted. This does **not** detect a machine holding a lease the medium
  never accepted, which renews without further `casWrite` calls; that detector
  is deferred with item (i).
- **Unobserved peers.** Registered, non-revoked peers that neither source has
  ever observed, after 2 × `failoverThresholdMs` measured from
  `max(bootMonoMs, firstDialableMonoMs)` (dialable peers) or from
  `firstRegisteredMonoMs` (peers never dialable), get one aggregated
  informational report per process incarnation listing each with a tag:
  `currently-dialable`, `previously-dialable` or `never-dialable`, plus
  `not-pulled (status: <s>)` when its status is not `active` (the feeder pulls
  only `active` peers, `MachineIdentity.ts:781-786`). A peer that becomes
  eligible later gets one further event. A dialable peer is one the transport's
  `peers()` returns: `revokedAt` unset and an address known
  (`server.ts:5553-5556`). `sample()` computes this from `loadDiskRegistry` with
  the same predicate, moved into one shared helper that both the transport and the
  builder call, so the two views cannot drift; a test changes a peer's endpoints
  before any receipt and checks both. A peer that first becomes dialable restarts its
  window from that moment, deliberately: it is given a full window to be pulled
  before it is reported. Tests cover never-dialable → dialable → unreachable,
  with one report per eligibility.
- **Ordering check.** One degradation at boot when `failoverThresholdMs <=
  leaseTtlMs`, naming both values. Change 1's liveness rule narrows takeover only
  while the lease expires before the liveness window closes.

## Safety posture (stated, not changed)

This spec ranks *The Agent Is Always Reachable* above Cross-Machine Coherence's
exactly-one-holder ideal where they conflict, and records the tension for the
maintainer. Without further coordination (a third-party arbiter, or a fixed
primary that never fails over), a two-machine pool cannot guarantee both
exclusive holding and automatic failover across arbitrary partitions; this
design keeps automatic failover. Adding either is out of scope for an incident
fix.

The following pre-existing windows are not closed by this spec. Their behaviour
is characterised by the tests (recorded, with convergence asserted afterwards),
not specified here; working notes on each are in
`docs/specs/notes/lease-existing-behaviour-notes.md`.

- **(a) Partition.** Both machines may hold until the partition heals, then the
  higher epoch folds in or the contested tie-break decides.
- **(b) Boot overlaps.** A standby booting without a lease of its own can hold
  for a few seconds before its first pull (the incident's first-boot blip); a
  simultaneous boot is settled by the tie-break. Both machines may send in the
  window.
- **(c) Restart hand-over.** After a holder restarts, the peer can take over,
  because a restarted process restarts its renewal nonce (deferred fix).
- **(d) Intermittent holding.** A holder whose only dialable peer is unreachable
  holds about half the time and replies are held in the gaps (the operator's
  Mac Studio case). This is the separate window (d) change; the Roblox topic
  does not move until it lands.
- **Tracked registries.** On a tracked registry with failing pushes (including
  an untracked-addable one once its first local commit lands), a git-ignored one
  whose Change 3 check errored, or a git-ignored one with `mediumCheck:false`, the
  `GitLeaseStore` read-back can
  still leave a machine holding a lease git never accepted (deferred item (i)),
  unreported by this spec.
- **Clock skew.** Expiry compares wall clocks, so with a fixed offset between
  two connected machines a takeover at expiry can overlap the old holder by up
  to that offset; clock steps are characterised separately (Tests, E2E).

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Peer presumed dead / gone (Change 1) | `invariant` | Fixed precedence over two positive-liveness sources; unknown ⇒ not dead and not gone (P20, no exception). Deterministic, no arbiter. The expiry floor is unchanged. |
| Boot: git vs local lease store (Change 3) | `invariant` | A repo fact (path tracked); a check error keeps today's store and reports. |
| Degradation thresholds (Change 4) | `invariant` | Fixed counters on reporting only. |

## Evidence declarations (Verify the State, Not Its Symbol)

- **Peer liveness.** SYMBOLS: registry `lastSeen` and coarse git-heartbeat
  re-records; neither proves liveness, so the new rule excludes both. STATE: the
  peer process is alive. CORROBORATION: this machine's own live pull receipt,
  and a verified signed renewal with an advancing nonce. The renewal is
  authenticated; the receipt is not (`MeshRpcClient` does not verify who
  answered, `MeshRpcClient.ts:90`). Something able to answer at a peer's address
  can therefore forge a receipt. A forged receipt keeps that peer "alive" for up
  to `failoverThresholdMs`, delaying a takeover. It also gives a never-observed
  peer a history: once that receipt is stale and no renewal is fresh, the peer
  is dead and gone, exactly as a peer genuinely seen once and then silent would
  be. What that changes, by reader:
  - `presumedDeadHolders`, through `canAcquire` (which checks expiry first,
    `FencedLease.ts:313`): a takeover before expiry, possible while an
    unexpired lease of that peer is visible here without a fresh renewal stamp.
    Known ways that happens: a git-carried lease; a restarted holder's
    higher-epoch lease whose nonce is below this machine's high-water for it
    (window (c), `LeaseCoordinator.ts:291-293`, `HttpLeaseTransport.ts:492-498`);
    and a freshness window shorter than the TTL (reported by the ordering check).
    A takeover this way also authorises an enabled solo hold for that epoch,
    independent of `allPeersPresumedGone` (`:397`, `:705`).
  - `allPeersPresumedGone`, through `soloCaptainHoldEligible` (`:398`), which has
    no expiry condition: the peer loses its never-observed protection for the
    rest of the process (thereafter it is gone whenever its receipt is stale and
    no renewal is fresh), so an enabled solo-captain hold can engage on forged evidence, with
    no time bound. The hold is off by default and on sagemind.
  - `checkForUnresolvableSplit` (`:966-967`): its escalation, but it has no
    production caller.
  - `sample()`: the peer is no longer reported as unobserved by Change 4.
  These are not asserted bounds; unit tests record each one (never-observed
  against forged-once-then-stale, with an unexpired store-carried lease, a
  restarted holder's below-watermark lease, the enabled hold including the
  takeover-authorised epoch, and the unobserved-peer report). Authenticating
  the receipt is outside this change; the window (d) change must not rest the
  hold gate on it. UNMEASURABLE (neither observed):
  not dead, not gone; lease expiry remains the takeover path, and Change 4
  reports the blind feeder unless a receipt, genuine or forged, has been seen.
- **Lease medium eligibility.** SYMBOL: a git-sync manager exists. STATE claimed:
  the registry is a file git can carry (tracked, or untracked and not ignored).
  CORROBORATION: `ls-files --error-unmatch`, then `ls-files --others --ignored
  --exclude-standard`; an ignored, untracked registry can never be carried by
  git. UNMEASURABLE (git error): today's store is kept and the error
  is reported. Push reachability is not measured.
- **Single authority during a partition.** Unmeasurable; see Safety posture.

## Frontloaded Decisions

1. **Scope: Changes 1, 3 and 4.** `GitLeaseStore` write semantics are not
   changed. Deferred items, judged against the incident class (an awake machine
   on a lease the medium never accepted):
   - (i) **Unconfirmed-candidate read-back** and (ii) **post-commit push-failure
     leak** can produce it, on a tracked registry with failing pushes or on a
     git-ignored registry whose Change 3 check errored. Neither is reported by
     this spec.
   - (iii) `syncSequence` monotonicity (only via (ii)), (iv) distinct `casWrite`
     failure reasons (diagnostics), (vi) the retry cap regardless of id order
     (bounded by the next tick) and (vii) the same-epoch tunnel fold (speed of
     seeing a renewal) cannot.
   - (v) the `refresh()` leak is unreachable from the server, which always wires
     the tunnel (`LeaseCoordinator.ts:862-871`).

   Changing (i) and (ii) alone was shown in review to risk leaving no holder, so
   they need a maintainer design pass. **Principal deferral approval for (i),
   (ii) and (v), and ratification of the reachability-over-strict ranking and
   the windows listed in the Safety posture, were given by the operator
   with the spec approval on 4 October** (owner: Echo; reported back in topic
   47547 within 14 days of merge), as recorded in the frontmatter.
2. **Unconfirmed-write alert threshold:** 5 (cheap-to-change-after: signal
   only). **Freshness window:** `failoverThresholdMs`.
3. **Switches:** `multiMachine.leaseFlapFix.{liveness, mediumCheck,
   unconfirmedWriteAlert}`, absent ⇒ on, read live (`mediumCheck` at restart).
   `multiMachine` is not in `PATCHABLE_CONFIG_KEYS` (`routes.ts:2040`) and is not
   added, so a Bearer token cannot flip them. A flip is logged once per
   transition with actor `config-file`. They are never seeded into
   `ConfigDefaults` (a persisted `false` would disable the fix).
4. **No migration.** `LocalLeaseStore` reads `state/lease-local.json`, never the
   registry's `lease`, so B's stale self-candidate in `registry.json` is inert. A
   machine moving to the local store starts with whatever `lease-local.json`
   holds (empty on a first move), so it boots as in window (b) once.
5. **Mixed versions.** Expectation, not yet demonstrated: with one machine
   upgraded the pair settles without flapping (an old standby can still make one
   unwarranted takeover from frozen `lastSeen`). The mixed-version test covers
   both orientations (upgraded holder, upgraded standby) with frozen `lastSeen`
   and mixed media, and requires stability for at least 2 × `failoverThresholdMs`
   after convergence. Upgrading every machine is advised.
6. **Live proof before merge.**
   - **Provisioned by the agent:** two BotFather bots (an *agent* bot for the
     throwaway homes, a *demo-user* bot via `liveTest.demo`) and a demo Telegram
     forum group with both bots, created through the operator's dedicated
     Playwright Telegram profile, which the operator has authorised; tokens go
     straight into the throwaway homes' vaults. Luna's own bot is never used. A
     separate demo Slack app (its own bot and Socket Mode tokens, since Socket
     Mode spreads events across all connections of one app), a non-agent sender
     identity for `SlackLiveSender`, and a demo channel registered with its
     `workspaceId`. If workspace admin approval is required, that is the only
     operator input, requested with the spec approval.
   - **Two throwaway homes on one host.** A local bare repo is the git remote.
     Home B: `git clone file:///…/bare.git`, then `instar join
     http://127.0.0.1:<portA> --dir <homeB> --code <code> --port <portB>`. Both
     get `failoverTimeoutMinutes: 3` (above the 60 s default TTL) and Telegram
     config for the demo group. A sets `gitBackup.enabled:false`; B keeps the
     default and adds `.instar/machines/` to its `.gitignore`, so its
     `registry.json` is untracked and ignored as on sagemind (no instar code adds
     that rule; `.gitignore:144` is local to sagemind). The bare repo must not
     carry the registry (otherwise the setup runs `git rm --cached` in B's clone
     before boot; the precondition below catches it either way), and the
     precondition is Change 3's own two queries returning `ignored` before boot.
     This reproduces the incident's mixed
     pair. Both resolve the B3 renew timer on (`MultiMachineCoordinator.ts:951-953`;
     an enabled Telegram adapter enrols the origin writer that does this,
     `server.ts:4499-4500`), recorded in each `/health` snapshot.
   - **Built work: a lease live-proof runner** around the existing user-role
     harness: stop and start homes, start one with an empty `lease-local.json`,
     cut and restore the link, boot both at once, flip switches; read `/health`
     before and after each step; drive demo-user sends and correlate each with
     outbound attempts and delivered replies. Signed artifact mapped to
     `RiskCategory`:
     - **happy-path:** at least 2 × `failoverThresholdMs` steady, one holder,
       flat epoch, each demo message answered exactly once;
     - **regression:** the mixed pair stable past `failoverThresholdMs`, where
       the legacy build flaps; `leaseMedium: local` (`ignored`) on that home, with
       the ignore precondition asserted before boot;
     - **lifecycle:** empty-file standby boot, holder restart with the peer up
       and down, holder stopped and taken over within TTL plus one heartbeat
       tick, held fraction with the peer down (window (d)), recorded;
     - **concurrency:** simultaneous boot, one holder within 2 lease-pull
       intervals plus one request timeout;
     - **failure/rollback:** partition then heal to one holder; switches off
       giving legacy behaviour;
     - **channel-parity:** the steady-state and takeover scenarios over Slack.

     Delivery during windows (b) and (c) may be duplicated or held; the artifact
     records it.
   - **Scope.** Two homes on one host prove the fix at process level (mixed media,
     HTTP faults, channel delivery); they share a clock and do not exercise
     laptop sleep or machine-level network recovery.
   - The run ends at merge and release. Re-pairing the Mac Studio and a 30-minute
     cross-machine watch follow, with the laptop lid closed and reopened once.
     A watch script polls both `/health` once a second and records each
     `holdsLease` change with its time; overlaps and gaps are measured at that
     1 s granularity and stated as such. The coordinator's existing lease log
     lines (acquired, CAS lost and yielding, self-suspended, relinquished,
     `LeaseCoordinator.ts:439-902`) corroborate the transitions; counted from the Studio's first pull
     after re-pairing (window (b) precedes it) and excluding the minute after the
     lid reopens (windows (b) and (c)), pass means one holder whenever both
     machines are up, no epoch churn while both are up, and every message sent
     while both are up answered once; moving the Roblox topic waits for the window (d) change
     (operator decision 3 Oct 16:05 PDT).

## Maturation plan

- **test-agent-live:** live from the first build. The live proof runs on two
  throwaway agents over a demo Telegram group and a demo Slack channel before
  merge (Frontloaded 6).
- **dev-agent-live:** all three switches are on when absent, so the fix is live
  on this agent at release. A dark fix would leave the incident's trigger and
  amplifier in place.
- **fleet:** with the release, same defaults. Each switch is its own rollback,
  with the steps in Rollback.
- **graduation criterion:** after re-pairing the Mac Studio, the 30-minute
  cross-machine watch passes: one holder whenever both machines are up, no
  epoch churn, and every message answered once (Frontloaded 6).
- **dark-window:** none. The changes ship on, and the only dark piece they touch
  is the existing solo-captain hold, which stays off until the window (d) change.

## Open questions

*(none)*

## Tests

- **Unit, builder.** The classification table generated exhaustively over
  (receipt fresh, stale, none) × (renewal fresh or not) × (router present or
  absent), for both callbacks; coarse-only receipts not counted; a wall-clock
  step between receipts has no effect; never-observed peers never dead or gone,
  even with `lastSeen` hours old; revoked-peer filtering as today; callbacks built before
  the router exists see it once constructed; `liveness:false` gives today's rule,
  including with the B4 skew-immune gate on (matching `isPeerPresumedDead`'s
  router branch);
  both routes (A: no git manager; B: git manager, git-ignored registry).
- **Unit, coordinator.** With injected clocks: a holder silent past
  `failoverThresholdMs` (receipt stale, no renewal stamp) whose verified renewal
  is waiting in the tunnel is not taken over by `acquireIfEligible` on that tick.
  The write counter for the sequence own-candidate
  failure, competing winner, own-candidate failure ends at 1; a counted write
  through a non-`acquireIfEligible` path (`acquireOnConsent`); all peers revoked
  ⇒ `allPeersPresumedGone()` false. `sample()` stamps first-dialable and first-registered
  times and reports a never-observed peer after the window, on a holder whose
  renewals confirm through another peer and with no callback invoked; each tag
  and the `not-pulled` qualifier; reports deduplicated by (peer, window), so a
  peer reported as never-dialable that later becomes dialable and stays unobserved
  is reported once more, and no other repeats; the write
  counter reaches 5 and resets on success, and ignores broadcast-only renewal
  failures; the ordering-check degradation at `failoverThresholdMs <=
  leaseTtlMs` and not at the defaults.
- **Unit, real git** (`tests/unit/leaseMediumSelection.test.ts`, temp repo with a
  bare remote): tracked ⇒ git; ignored and untracked ⇒ local, with a degradation
  only when peers are registered; untracked and not ignored ⇒ git
  (`untracked-addable`), and the first lease write makes it tracked; ignored but
  tracked ⇒ git; an error from the second query ⇒ check error; the file deleted between
  self-registration and the check ⇒ `registry-missing`; one test per exit-status
  mapping and error kind (timeout, signal, spawn error and guard refusal via an
  injected executor), each check error keeping the git store; `cwd` from a
  different directory still uses `config.projectDir`; not a repo ⇒ local via
  `no-git-sync-manager`, since the server gates the whole git-sync block on `.git`
  existing (`server.ts:5370`, `:5399`) and the check is never reached; the
  debouncer not wired on local; a registry removed from the index at runtime
  stays on git until restart.
- **Integration (Tier 2):** `/health` → `leaseMedium`, `reason` and `store` for
  `tracked`, `untracked-addable`, `ignored`, `no-git-sync-manager` and
  `switch-off`.
- **Wired:** `server.ts` calls the selection function and the liveness builder;
  on `local` the debouncer is not wired, `_hasDurableLeaseAuthority` is false and
  the git branch of `_staleOwnerSelfProof` returns false, while the backup
  `gitSync` instance is still constructed; `tickLease` and `initializeLease` call
  `sample()` through `sampleLiveness`.
- **E2E** (extend `tests/e2e/multi-machine-lease-split-brain.test.ts` and
  `tests/integration/lease-http-convergence.test.ts`, callbacks from the builder,
  the router fed by a `MachinePoolRegistry` with stub live and coarse beats):
  - **the incident:** a mixed pair, with B's store chosen by the selection
    function (`GitLeaseStore` with the switches off, `LocalLeaseStore` with the
    fix, each asserted), over an
    untracked and git-ignored `registry.json` (B's repo built with the
    `.instar/machines/` ignore rule, asserted before boot), each machine's store
    asserted. With every switch
    off the flap reproduces after `failoverThresholdMs`; with the fix, one holder
    and no epoch churn for at least 2 × `failoverThresholdMs`;
  - two `LocalLeaseStore`s with frozen `lastSeen`: the flap reproduces with
    `liveness:false` and not with the fix;
  - B with an untracked, not ignored `registry.json`: stays on the git store, the
    first lease write commits the registry, and the pair does not flap with the
    fix (the incident needs the ignored case);
  - a peer seen only through renewals, whose renewals then stop: not dead and not
    gone, and its lease is taken over on expiry;
  - the solo-captain hold enabled, with fresh, stale and never-observed peers:
    hold eligibility and no-holder time are recorded (characterisation only;
    reliable holding is the window (d) change);
  - a live beat, then coarse beats only: the receipt is kept and the peer is
    classified stale after `failoverThresholdMs`; with the router absent or
    after a restart: not dead, not gone;
  - a revoked peer: omitted from `allPeersPresumedGone`, classified by its
    evidence in `presumedDeadHolders`;
  - characterisation of windows (a) to (d) and of a `mediumCheck` rollback, the
    upgrade store transition, mixed versions, one-way connectivity and
    broadcast-only failures: behaviour during each fault is recorded and compared
    with the same scenario run in the same harness with all three `leaseFlapFix`
    switches off (today's lease decisions) and the solo-captain hold off (its
    default), driven by the same deterministic event schedule with injected
    clocks. Metrics, over the fault interval: **both-holding time** (`holdsLease()`
    true on both coordinators), **no-holder time** (false on both), and **epoch
    changes**. In these harnesses (both stores `LocalLeaseStore`, every peer lease
    seen through the tunnel) the fix is asserted ≤ the baseline on both-holding
    time. That is an acceptance check measured in this harness, not a property
    proved for every deployment. No-holder time and epoch changes are recorded
    against the baseline; any scenario where the fix is higher on either is
    named in the artifact with its magnitude and an explicit accept or reject by
    the principal; an unresolved or rejected one blocks release. Two scenarios
    are recorded only, because the reasoning behind the check does not cover
    them: a tracked-registry pair with git pushes working and HTTP partitioned
    past `failoverThresholdMs` (a lease that arrives only through `store.read()`
    stamps no renewal freshness, `LeaseCoordinator.ts:271-273`, `:286-297`, so a
    peer can be called dead before its lease expires, bounded to the `leaseTtlMs`
    after the holder's last git-carried acquisition: with the tunnel wired,
    renewals do not write the store, and an unconfirmed holder self-suspends after
    `leaseTtlMs`, `LeaseCoordinator.ts:861-872`, `:894-903`), and a backward wall-clock
    step during acquisition and holding, and a forward step on the non-holder
    (liveness is monotonic, expiry is wall time). The
    upgrade store transition and the `mediumCheck` rollback have no distinct
    switches-off counterpart, so their behaviour is recorded only. (Duplicate
    replies against the real legacy build are the live runner's regression row.)
    Once the fault is removed, one
    holder within 2 lease-pull intervals plus one request timeout and a stable
    epoch for at least one TTL are asserted (except window (d), whose held
    fraction is recorded).
- **Live:** the matrix in Frontloaded 6.

## Multi-machine posture

This is the multi-machine lease itself. No new persisted state; the only new
surfaced field is `/health` → `leaseMedium`. Change 1 is independent of the
medium, so a pool that still mixes media no longer flaps from frozen liveness.
Single-machine agents: Change 3 picks `LocalLeaseStore` for a git-ignored
registry; Changes 1 and 4 see no peers.

## Rollback

Each lease switch, and reverting the release, restores prior behaviour, which
includes the incident: `liveness:false` restores the trigger, `mediumCheck:false`
the amplifier on a git-ignored registry (it has no effect on an
`untracked-addable` one, which stays on git either way).
`unconfirmedWriteAlert:false` has no lease effect. On a paired agent whose
registry is git-ignored, roll back by first
returning to a single machine: stop the standby and keep it stopped, then revoke
it on the remaining machine (`instar machines remove <name-or-id>`,
`src/cli.ts:2138-2148`), then flip the switch
or revert and restart. This is what was done on 3 October. Re-pairing waits for
a fixed build. `liveness` and `unconfirmedWriteAlert` apply live; `mediumCheck`
at the next restart.

## Review provenance

- **Cycle 1 (rounds 1 to 10, v1 to v10)** settled the core (live-evidence
  liveness, exit-status-mapped medium selection with a lease-purpose git
  reference, acquisition-write signals). Rounds 8 to 10 added a detector for a
  lease the medium never accepted; every later finding was in it, and the
  operator deferred it (3 Oct 14:46 PDT).
- **Cycle 2 (v11 to v19)** reviewed a boot-pull change; most findings were in it,
  a code trace showed it addressed only the self-healing first-boot blip, and the
  operator deferred it (3 Oct 15:41 PDT).
- **Cycle 3 (v20 to v29)** reviewed Changes 1, 3 and 4. Round 1 found the
  intermittent-holding window (d), which the operator made its own change before
  the Roblox topic moves (16:05 PDT). From round 2, every DESIGN finding was a
  statement about pre-existing behaviour added to the spec's explanations, not a
  defect in Changes 1, 3 or 4. At the operator's direction (19:34 PDT) those
  explanations moved to `docs/specs/notes/lease-existing-behaviour-notes.md` as
  unreviewed working notes, and the windows are characterised by tests instead.
- **v30** is that trimmed spec. Per-round findings: the sagemind repo,
  `docs/instar/lease-flap-review-rounds-1-6.md`.
- **Cycle 4, round 1 (v31)**: one DESIGN finding (the rollback command is
  `instar machines remove`, plural). Precision: not-a-repo never reaches the
  check, the shared monotonic clock plumbing, a one-line justification of the
  receipt-only staleness rule with a test, the partition limitation restated,
  and ELI16 figures softened to match the spec.
- **Cycle 4, round 2 (v32)**: one DESIGN finding: an untracked registry that is
  not git-ignored is added by the first lease write today, so it stays on the
  git store (`untracked-addable`); only an ignored registry moves to the local
  store. GPT: receipt-history retention is stated (loss falls to the safe
  "none ever"), and the mixed-version claim is an expectation tested in both
  orientations over 2 × the failover threshold. Precision: the revoked-holder
  change and its safety argument, the one-evaluation lag, ticks that run, and
  degradation wording that presents the local store as supported.
- **Cycle 4, round 3 (v33)**: one DESIGN finding: after the round-2 split,
  several places still said "untracked" where they now mean git-ignored,
  including the incident E2E and the live proof, whose throwaway home would not
  have been ignored (instar adds no such rule); B's repo now gets the ignore
  rule, asserted before boot, and an untracked-addable case is tested. GPT: the
  retention statement is reconciled with the no-router row. Precision: the
  registry must exist for the check (it does, after self-registration), the
  second query in the evidence, and the revoked-holder argument limited to HTTP.
- **Cycle 4, round 4 (v34)**: one DESIGN finding: every beat replaces the pool
  entry whole, so the receipt time is now a separate map (and "eviction", which
  the registry does not do, is gone). GPT: revoked-peer filtering now keeps
  today's behaviour rather than arguing a new one; the unconfirmed-write
  predicate is defined on the `casWrite` result; fault characterisation is
  compared with the legacy build and must be no worse. Precision:
  `registry-missing` is a listed kind with an existence check, home B's
  precondition is Change 3's own verdict, and the tracked-registry residual
  names the addable and switch-off cases.
- **Cycle 4, round 5 (v35)**: one DESIGN finding: the "no worse than legacy"
  comparison could not be built in the E2E harnesses; the baseline is now the
  same scenario with the switches off (and the solo hold at its default, off),
  compared exactly, with duplicate replies left to the live regression row.
  GPT: the counter resets on any non-counted result, and the live proof's
  process-level scope and the cross-machine watch's pass criteria are stated.
  Precision: the empty-set guard, every `casWrite` caller, and the setup step
  for B's clone.
- **Cycle 4, round 6 (v36)**: two DESIGN findings, both in the characterisation
  baseline. "≤ on every metric" held only for both-holding time; the other
  metrics are now recorded and reviewed. The builder lacked the inputs to
  reproduce today's rule when switched off (wall clock, B4 gate, switch getter,
  both registries); they are now named. GPT: the own-candidate predicate is
  exact (holder, epoch, nonce), metrics share one event schedule, and an
  enabled-hold scenario is characterised. B's store in the incident test comes
  from the selection function.
- **Cycle 4, round 7 (v37)**: one DESIGN finding (internal and GPT agreeing):
  the ≤ justification was false for leases carried by git (no renewal stamp) and
  under wall-clock steps. ≤ is now a measured check in the local-store harness
  only, and both cases are recorded-only scenarios. GPT: the unobserved-peer
  window restarting on first dialability is now stated as intended and tested.
  Precision: line citations; the router shares the harness wall clock.
- **Cycle 4, round 8 (v38)**: internal zero DESIGN; GPT's ordering point was
  confirmed in code and is DESIGN: `acquireIfEligible` read liveness before
  folding in tunnel renewals, which under the fix could judge a returning holder
  dead against its own fresh lease. The read moves after `effectiveView()`, with a
  unit test. Precision: the review exception covers only no-holder time and epoch
  changes; report deduplication is by (peer, window); the git-carried scenario is
  bounded to one `leaseTtlMs`.
- **Cycle 4, round 9 (v39)**: internal and GPT zero DESIGN. Precision: the
  ordering move is stated as unswitched, with an equivalence test under
  `liveness:false`; `soloCaptainHoldEligible` is listed; dialability comes from
  one shared predicate used by the transport and the builder.
- **Cycle 4, round 10 (v40)**: one DESIGN finding: the unswitched ordering
  move would change today's verdicts on a git store, since a lost write pulls a
  fresher `lastSeen` that a retry would re-read. The move is now switched with
  `liveness`. GPT: `leaseGitRef` covers `unchecked` explicitly (rollback keeps all
  three git consumers), and the write alert fires once per streak. Cycle 4 hit
  its 10-round cap without two consecutive zero-DESIGN rounds:
  `convergence-failed`, retry pending the principal.
- **Cycle 5, round 1 (v41)**: one DESIGN finding (internal and GPT agreeing):
  the coordinator had no input for the `liveness` switch that now picks where
  `acquireIfEligible` reads liveness. It gains a live getter read once per call
  and passed to the callback. GPT: a recorded regression needs an explicit
  accept or reject, and an unresolved one blocks release. The operator's approval
  and ratification are recorded.
- **Cycle 5, round 2 (v42)**: internal zero DESIGN. GPT found a false statement,
  counted as DESIGN: a forged receipt was said to only delay a takeover, but it
  can also give a never-observed peer a history that later reads as dead. The
  evidence declaration now states that and its bound, with a test. Precision:
  the getters are optional and default on; "one rule per call" is scoped to
  `presumedDeadHolders`; the write counter across switch flips is defined.
- **Cycle 5, round 3 (v43)**: two DESIGN findings, both false or over-wide
  safety claims about the forged receipt: it can also engage an enabled solo
  hold, which has no expiry condition, so no lease bound applies; and the
  unstamped-lease case also arises from a restarted holder below its nonce
  watermark. GPT raised the same scope and the clock assumption. The declaration
  now lists the effect per reader, asserts no bound, records each by test, and
  passes the constraint to the window (d) change.
- **Cycle 5, round 4 (v44)**: internal zero DESIGN (36 absolute claims checked
  against code, none wrong); three omissions in the forged-receipt list added
  (the takeover-authorised solo hold, the lasting loss of never-observed
  protection, the unobserved-peer report). GPT: the clock-skew overlap is
  qualified to a fixed offset, and the summaries name the write alert's actual
  scope.
- **Cycle 5, round 5 (v45)**: internal and GPT zero DESIGN; converged (rounds
  4 and 5). Precision: the watch reconstructs holder intervals from lease
  transition logs rather than 30 s samples; a forward clock step is added to
  the recorded scenarios; the live proof is labelled as still to run.
- Cross-model review: GPT (`codex-cli`, gpt-6-astra, verified from the Codex
  session log) from cycle 1 round 2 on. Gemini never produced a review (its CLI
  refuses to start; the signed-in account needs a Google Cloud project); by
  operator direction (3 Oct 14:24 PDT) review proceeds on GPT only. Internal
  review: one all-lens agent per round from cycle 1 round 5.

## Out of scope, tracked

- **Window (d): reliable holding with the only peer unreachable** (operator
  decision 3 Oct 16:05 PDT; its own spec and review, before the Roblox topic
  moves). Starting point: the solo-captain hold with the always-on machine as
  `preferredAwakeMachineId`, and the working notes. Constraint carried from this
  spec: its hold gate must not rest on the unauthenticated live receipt (Evidence
  declarations, Peer liveness). <!-- tracked: sagemind topic 47547 -->
- **Boot pull** (window (b); deferred 3 Oct 15:41 PDT; owner Echo). The v19
  draft and a cheaper alternative (the `/api/lease` ack reporting
  `max(observed, own currentEpoch())`) are the starting points.
  <!-- tracked: sagemind topic 47547 -->
- **Restart nonce watermark** (window (c); owner Echo). `nonceCounter` restarts
  at 0 per process (`LeaseCoordinator.ts:171`, `:255`) while peers keep the old
  watermark (`HttpLeaseTransport.ts:492-494`). <!-- tracked: sagemind topic 47547 -->
- **`GitLeaseStore` write hardening** (items i to vii) and its **never-accepted
  detector** (deferred 3 Oct 14:46 PDT; owner Echo).
  <!-- tracked: sagemind topic 47547; sent to Echo msg-1791058165363-gmjui2 -->
- **`LocalLeaseStore.persist()`** swallows a failed disk write, so `casWrite` can
  report success for a lease held only in memory (pre-existing; owner Echo).
  <!-- tracked: sagemind topic 47547 -->
- **`_staleOwnerSelfProof`'s 2-machine git branch** returns true whenever a
  git-sync manager exists (`GitLeaseStore.read()` always returns an object), so
  it proves neither reach nor acceptance (pre-existing; a U4.2 design change for
  Echo). <!-- tracked: sagemind topic 47547 -->
- **`instar join` / `instar pair`:** `join` scaffolds `config.json` without the
  inviter's `gitBackup`; `join` booted a second machine as the first when the repo
  tracked `.instar/machine/identity.json`; `pair` migrates plaintext secrets that
  agent scripts read directly. <!-- tracked: sagemind topic 47547, msg-1791058165363-gmjui2 -->
