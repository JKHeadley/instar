# Lease behaviour notes (working notes, not part of the spec)

These notes were the detailed "existing behaviour" analysis in versions 20 to 29 of
`docs/specs/lease-unconfirmed-candidate-flap.md`. They were moved out of the spec on 3 October 2026 at
the operator's direction, because they describe pre-existing Instar behaviour rather than anything the
spec builds, and each review round found a new edge case in them. They are **unreviewed working notes**:
a starting point for the window (d) change (reliable holding with the only peer unreachable) and for the
maintainer's deferred items, to be verified against the code before any of it is relied on.

The text below is version 29 of the spec, unchanged.

---

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

Every change has a live-read switch (absent ⇒ on) under
`multiMachine.leaseFlapFix`. `mediumCheck` acts at boot, so a flip takes effect on
the next restart. Each flip is logged once when detected (Frontloaded Decision 3).

| Switch | Off restores | Also governs |
|---|---|---|
| `liveness` | today's liveness rule (`isPeerPresumedDead`) | `sample()`, the unobserved-peer report and the never-dialable report |
| `mediumCheck` | today's store choice (git whenever a git-sync manager exists), the debouncer, and `gitSyncRef` for every consumer | the medium degradations and `/health` → `leaseMedium` (reported as `unchecked`) |
| `unconfirmedWriteAlert` | no unconfirmed-write report | the `failoverThresholdMs <= leaseTtlMs` ordering check |

With all three off, every lease decision is today's and no new degradation
event is raised. The new passive `/health` fields remain (`leaseMedium`
reads `unchecked` with `reason: switch-off` where a git-sync manager exists).

Change 1 removes the trigger. Change 3 removes the amplifier. Change 4 makes the
remaining failure modes visible.

### Change 1 — peer liveness from live evidence, on every medium

Extract both `server.ts` closures (`presumedDeadHolders`, `allPeersPresumedGone`)
into one exported builder:

```
buildLeaseLivenessCallbacks({ registry, getRouter, getFreshness,
                              failoverThresholdMs, bootMonoMs, monoNow })
```

`getRouter` and `getFreshness` are getters read on every call, not captured
values. `getFreshness` returns an interface with two reads:
`freshRenewalWithin(id, ms)` and `lastRenewalObservedMono(id)` (the
`freshObservedMonoMs` entry, or undefined if no verified advancing renewal has
ever been seen), so the builder can tell "renewal seen, now stale" from "never
observed". They are getters because the router is constructed later in boot than the lease, and
`freshRenewalWithin` lives on the `LeaseCoordinator` the callbacks are passed
into (`server.ts:5596-5664`). The builder goes into the existing
`src/core/leaseLiveness.ts`, beside today's `isPeerPresumedDead`, which
`liveness:false` keeps using. The rule is the same on every medium, so it takes
no store kind.

The builder is invoked once, at wiring. Each returned callback parses the
registry once per invocation (it may cache per tick). The builder's closure
holds a per-peer `firstDialableMonoMs` map for the process lifetime; it is
used only by the Change 4 unobserved-peer report.

The builder also returns a `sample()` entry point, reading the builder's own
clock. It reaches the coordinator through a new optional
`LeaseCoordinatorDeps.sampleLiveness`, which `MultiMachineCoordinator` calls via
the attached `LeaseCoordinator`. The callbacks run only when the coordinator happens to call them (a steady
holder's tick goes straight to `renew()`, `MultiMachineCoordinator.ts:1285-1287`),
so they cannot be what stamps that map. `MultiMachineCoordinator.tickLease`
(`:1258`) calls `sample()` on every heartbeat-driven tick (every 2 minutes,
`:101`) and on the standby pull-loop nudge (`:1465`), on the holder, standby
and observe-only branches alike, before any renew or acquire. `initializeLease`
calls it once at its start. `sample` stamps first-dialable times and evaluates
the Change 4 unobserved-peer report. No liveness verdict depends on that map.

One clock is used for all of it. A single injected `monoNow` stamps
`liveReceivedMonoMs` in `MachinePoolRegistry`, `bootMonoMs` and
`firstDialableMonoMs`, and is used for every comparison in the builder.
`LeaseCoordinator.monotonicNow()` defaults to `process.hrtime`
(`LeaseCoordinator.ts:240-242`).

A **dialable peer** is another machine that is not revoked and has a
`lastKnownUrl` or `endpoints`: the same set the transport's `peers()` returns
(`server.ts:5553-5556`).

**The two sources.**

- (a) **Live receipt.** The router observed a live pull receipt from the peer
  within `failoverThresholdMs`. Coarse re-records from the git-synced heartbeat
  file (`obs.coarseHeartbeat`, `server.ts:21483`) do not count. Coarse beats
  overwrite `routerReceivedAtMs` today, so `MachinePoolRegistry` gains a separate
  per-peer `liveReceivedMonoMs`, stamped only on non-coarse beats (the only
  non-coarse peer writer is `PeerPresencePuller`, `PeerPresencePuller.ts:287`)
  and carried forward otherwise, exposed as `lastLiveReceiptMono(id)`. The
  feeder pulls only peers with `status: 'active'` (`MachineIdentity.ts:781-786`,
  `server.ts:25360-25363`), so a dialable peer in another status (such as
  `pending`) is never observed this way; the unobserved-peer report tags it
  `not-pulled (status)`, and it keeps the solo hold from engaging, the safe
  direction. It uses
  the injected monotonic clock, not `Date.now()`, which `routerReceivedAtMs` and
  the transport's `observedAtMs` use today, so a wall-clock step cannot make a
  stale receipt look fresh or a fresh one stale. A system sleep can: on macOS
  `process.hrtime` (libuv, `mach_absolute_time`) does not advance while asleep,
  so after a laptop wakes, a pre-sleep receipt counts as fresh for up to
  `failoverThresholdMs` of awake time. That errs safe (expiry is checked first,
  `FencedLease.ts:313`) but delays the solo hold and the unobserved-peer
  report. This platform behaviour is unverified: unit tests with an injected
  clock cover the algorithm's response to a paused clock, and a separate,
  recorded suspend-and-resume run on the supported macOS and Node versions
  establishes what the runtime clock actually does.
- (b) **Fresh renewal.** `LeaseCoordinator.freshRenewalWithin(id,
  failoverThresholdMs)` reads the existing `freshObservedMonoMs` map, which is
  stamped at the first `effectiveView()` evaluation that sees the current
  holder's signature-verified nonce advance (`LeaseCoordinator.ts:291-297`), so
  at most one tick after receipt. Only a peer that held the lease within the
  window has source (b); entries are not cleared on hand-over, the safe
  direction. A standby peer's liveness rests on source (a) alone.

**The complete classification**, for every registered, non-revoked peer other
than this machine, whether or not it is dialable now. "Revoked" means
`revokedAt` is set, matching the transport's `peers()`; an entry with
`status: 'revoked'` but no `revokedAt` (for example a hand-written status edit
that bypassed `revokeMachine`) is classified as non-revoked. With no receipt
history it is never gone; with history it becomes gone `failoverThresholdMs`
after its last receipt, because the feeder stops pulling a non-active peer
(`MachineIdentity.ts:784`) and it can no longer renew (`machineAuth.ts:72`). Revoked peers are omitted
from both callbacks (today `presumedDeadHolders` includes them,
`server.ts:5605-5607`, while `allPeersPresumedGone` filters them, `:5647`); a
revoked holder is taken over on lease expiry. A fresh source wins;
otherwise the receipt history decides. Dialability affects only the Change 4
reports: a peer whose address is later removed keeps its receipt history and
is classified by it.

| Live receipt (a) | Renewal (b) | `presumedDeadHolders` | `allPeersPresumedGone` |
|---|---|---|---|
| fresh | any | alive | not gone |
| stale or none | fresh | alive | not gone |
| stale | not fresh | dead | gone |
| none ever | not fresh or none | insufficient fresh evidence (not dead) | not gone |

The rows are disjoint: (a) is fresh, stale, or never seen, and (b) is fresh or
not. A registered peer that is never dialable has no receipts, so it is never
gone either. With no
router at all, source (a) is unavailable, so (a) reads "none ever" for every
peer: a fresh renewal still makes the holder alive (row 2), and otherwise the
last row applies; takeover then rests on lease expiry. The new rule never consults
`lastSeen`.

Only receipt history can establish that a peer is gone. Renewal history
comes only from a holder, and a holder that falls silent is taken over on
lease expiry (`canAcquire` checks expiry first); that takeover sets
`peerTakeoverAuthorizedEpoch`, which engages the solo hold directly
(`LeaseCoordinator.ts:394-399`), so the asymmetry costs nothing in that case.
Its cost is a peer seen only through renewals while this machine holds an
epoch it did not obtain through a fenced takeover (a lease it never took, one
claimed by U4.4 hand-back, `acquireOnHandbackConsent`, `LeaseCoordinator.ts:820-829`,
an equal-epoch tie-break, or one later superseded by its own higher epoch, which
clears the authorization, `:311-313`): the hold then waits for a live receipt
that may never come, the safe direction, and window (d) covers the
consequence.

"Unobserved" means never seen by either source. A peer whose renewals were once
seen but are now stale falls in the last row too, but it has been observed, so
it is not in the Change 4 unobserved-peer report.

**The solo-captain hold** (`allPeersPresumedGone`, dark via `soloCaptainHold`)
differs from today in three stated ways. It never engages for a never-observed
peer, where today's rule could call such a peer gone from an old seeded
`lastSeen`; that is the safe direction, since the holder then self-suspends on
unconfirmed renewals as it does with the hold off. And it can now fire for an
observed peer whose HTTP went silent while git still carries a fresh `lastSeen`.
Third, and largest for the operator's case: with B4 resolved off (sagemind's
posture), today's `allPeersPresumedGone` (`server.ts:5645-5662`) judges every
peer by registry `lastSeen` (`leaseLiveness.ts:45-53`). With an untracked
registry or `gitBackup:false` a peer's `lastSeen` usually stays at its pairing
value (it moves only on an endpoint change or a handoff, Root cause 1), which is
usually older than 15 minutes, so on today's build an *enabled* hold usually
engages at the first unconfirmed renewal: right after the laptop's lid closes,
and right after a Studio restart with the lid closed. With B4 on, a peer
observed before its lid closed stays online for 15 minutes today as well, so
today and Change 1 then differ only for a peer not observed since boot. Under
Change 1 the same enabled hold waits `failoverThresholdMs` for an observed peer
and never engages for a peer not observed since boot or never dialable. So
Change 1 makes an enabled hold cover less than today in exactly the operator's
target case; that is the price of applying P20 without exception, and
`liveness:false` restores today's hold timing (and with it the flap trigger). The
hold is off on sagemind today (`config.json:1188`), so this is no live
regression. The hold cannot win an epoch CAS and stays fenced by any higher
epoch it sees through git or acks (`LeaseCoordinator.ts:399-401`).

`liveness: false` restores today's rule exactly: the current `isPeerPresumedDead`,
with B4 resolved by its dev gate.

Notes:

- The freshness stamp also fires for renewals a holder broadcast before it knew
  whether they were confirmed, and for its relinquish tombstone. That is safe:
  `canAcquire` checks `current-lease-expired` before presumed-dead
  (`FencedLease.ts:313`), so a self-suspended holder's lease still expires
  within one TTL and is taken over. Liveness only matters while a peer's lease
  is unexpired.
- **Tradeoff:** a peer that died before this machine booted is never observed.
  Takeover then rests on lease expiry alone.

### Change 3 — do not build a git lease store over a registry git cannot carry

At the top of the git-sync block in `server.ts`, before the registry-sync
debouncer is wired, run `git ls-files --error-unmatch -- <registryAbsPath>` once,
with `cwd: config.projectDir` (the same repo `GitSyncManager` operates on; from
outside that repo the same path exits 128). Use `SafeGitExecutor.readSync`
(`ls-files` is on the read-only verb list, `SafeGitExecutor.ts:103`) with a 2 s
timeout. `readSync` rethrows the `execFileSync` error unchanged
(`SafeGitExecutor.ts:1236-1238`), so its `status`, `signal` and `code` reach the
caller.

`ls-files --error-unmatch` exits 1 for a path that is untracked or ignored, so
the result is mapped from the thrown error's exit status, never from "did it
throw":

- **Clean exit (status 0)** ⇒ **tracked** ⇒ `GitLeaseStore` plus the debouncer,
  as today.
- **Thrown with `err.status === 1`** ⇒ **confirmed untracked** ⇒
  `LocalLeaseStore`, and skip the debouncer (its only consumers are
  `wireRegistrySync` and `stop()`).
  - With other machines registered, report one degradation: "registry.json is
    not tracked in git, so the lease uses the local store plus the network; to
    use git for the lease, track the file and restart."
  - With no other machines, write one log line.
- **Anything else** ⇒ **check error** ⇒ keep `GitLeaseStore` and the debouncer,
  exactly as today, and report one degradation that names the error kind and
  says it "will be re-checked at the next restart" (the check runs once per
  process). A transient failure must not move a tracked registry off shared
  coordination. The kind is decided in this order:
  1. a `SafeGitExecutorError` or `SourceTreeGuardError` ⇒ `refused`;
  2. `err.code === 'ETIMEDOUT'` ⇒ `timeout`;
  3. a numeric `err.status` other than 1 (128, 129, …) ⇒ `git-exit-<status>`;
  4. a non-null `err.signal` ⇒ `signal-<name>`;
  5. any other `err.code` (an errno such as `ENOENT`) ⇒ `spawn-error`.

On `local`, the lease-purpose git reference is cleared as well, not only the
store choice. `gitSyncRef` also drives `_hasDurableLeaseAuthority`
(`server.ts:5711`) and the 2-machine git branch of `_staleOwnerSelfProof`
(`server.ts:5737-5740`), which feed U4.2 stale-owner release. A new
`leaseGitRef` is set to `gitSyncRef` only when the medium is `git`, and those
three consumers (the store choice, durable authority, the self-proof's git
branch) read `leaseGitRef`. On `local`, durable lease authority is therefore
false and the 2-machine self-proof returns false, so U4.2's evidence bar refuses
a 2-machine claim exactly as it does today on a git-less install. The
`GitSyncManager` backup instance (`gitSync`) is untouched and keeps doing
state backup.

This is an eligibility check: it confirms git can commit the file, not that
pushes reach peers. `/health` → `multiMachine.syncStatus.leaseMedium` (`git` |
`local` | `unchecked`, plus `reason` and `store`, the store actually built)
makes the choice visible. `reason` is, in this order of precedence:
`no-git-sync-manager` (machine A's route: `leaseMedium` reads `local`, whatever
the switch; `unchecked` applies only where a git-sync manager exists),
`switch-off` (with `unchecked`; `store` then shows whether git or local is
running), `tracked`, `untracked`, or `check-error:<kind>`. The store choice is plumbed
from `server.ts` into `MultiMachineCoordinator.getSyncStatus`; the field joins the
`MultiMachineSyncStatus` type, `tests/unit/multimachine-syncstatus.test.ts`, and
the agent-awareness text (CLAUDE.md template plus a `PostUpdateMigrator`
migration with a content-sniffing guard keyed on the new text, so agents that
already have a lease section still receive it).

### Change 4 — make sustained unconfirmed writes and a blind liveness feeder visible

- **Unconfirmed acquisition writes.** `LeaseCoordinator` counts consecutive
  unconfirmed acquisition writes: `casWrite` with no peer advance, or our own
  candidate handed back. At 5 it reports one degradation: "lease writes are not
  being accepted by the medium". The count resets on the first confirmed write.
  Renewals are not counted: the server always wires the HTTP transport
  (`server.ts:5550-5598`), so `renew()` confirms over the tunnel and never calls
  `store.refresh()`, and a plain broadcast failure is the normal state when the
  peer is off.
  - Timing: a lapsed lease is re-acquired only on the 2-minute heartbeat tick
    (the B3 timer only renews, and the pull-loop nudge needs a peer lease), so
    with a dialable peer that never confirms, the counter advances about once
    per heartbeat tick at the defaults and fires after about 10 minutes.
  - With a confirming peer, renewals carry on and it never fires. With no
    dialable peer, `broadcast()` succeeds vacuously
    (`HttpLeaseTransport.ts:191-195`), so it never fires either.
- **Not covered: holding a lease the medium never accepted.** After `casWrite`
  hands back our own candidate, the next loop iteration of the same
  `acquireIfEligible` call takes its self-renew branch (`FencedLease.ts:314-316`,
  `LeaseCoordinator.ts:684`). `renew()` broadcasts the lease, a peer folds the
  higher epoch and acks it as `'confirmed'` (`HttpLeaseTransport.ts:372-386`), and
  from then on every tick is a confirmed renewal, so the count stays at 1. This
  spec does not report that state. Its detector is deferred with item (i)
  (Out of scope, operator decision 3 Oct 14:46 PDT).
- **Unobserved peers.** Every registered, non-revoked peer that has never been
  observed by either source is reported, tagged `currently-dialable`,
  `previously-dialable` (sampled dialable at some point, endpoints since
  removed) or `never-dialable`, plus the qualifier `not-pulled (status: <s>)` when its
  status is not `active` (for example `currently-dialable, not-pulled (status:
  pending)`). Timing: dialable peers still unobserved after 2 ×
  `failoverThresholdMs` (measured from `max(bootMonoMs, firstDialableMonoMs)`,
  stamped by `sample()`), and registered, non-revoked peers that have never been
  dialable after 2 × `failoverThresholdMs` from when this process first saw
  them registered (`firstRegisteredMonoMs`, stamped by `sample()` like
  `firstDialableMonoMs`, so a machine paired after a long uptime gets the full
  window) (registered but with no
  address known yet, since pairing records a URL only if one was advertised,
  `machineRoutes.ts:555-559`, or a stale entry; under Change 1 such a peer keeps
  the solo hold from engaging until it becomes dialable or is revoked), get one calm,
  informational report, aggregated into a single event that lists every such
  peer and why. A peer that becomes eligible later,
  after that event, gets one further aggregated event of its own; each peer is
  reported at most once per process incarnation. A closed laptop is expected, so
  this is not an alarm.
- **Ordering check.** The server reports one degradation at boot when
  `failoverThresholdMs <= leaseTtlMs`, naming both values (see Safety posture,
  Partition). It is a signal, not a refusal.
- **Routing.** Every Change 3 and Change 4 report is a `DegradationReporter`
  event: internal, in the degradation log and digest, never a direct user notice
  and never an Attention item. None escalates.

All of these are signals only and change no lease decision: none feeds
`canAcquire`, `holdsLease` or `_staleOwnerSelfProof`.

## Safety posture (stated, not changed)

- **Availability over strict exclusivity, by choice — the governing standard.**
  This applies *The Agent Is Always Reachable*: a strict single authority would
  leave the agent unreachable whenever the machines cannot agree. Cross-Machine
  Coherence's exactly-one-holder ideal is met everywhere except in windows (a)
  to (c), and is restored by convergence after each. Window (d) is the
  opposite failure, no holder at all for part of the time, and is the one that
  most affects reachability in practice. Where the two standards
  conflict, this spec ranks reachability first and records the tension for the
  maintainer. The windows:
  - **(a) A true partition** (below).
  - **(b) Brief boot overlaps,** all of which exist today and are not widened:
    - *A standby booting with no lease of its own* acquires epoch 1 locally
      before it learns the holder's lease (`no-current-lease`,
      `FencedLease.ts:312`, comes before any liveness check, so Change 1 cannot
      stop it). It drops to standby on its first pull tick, 4 to 6 s after the
      boot acquisition returns (5 s ±20%, `MultiMachineCoordinator.ts:1396-1398`);
      that acquisition's broadcast can itself take up to `broadcastDeadlineMs`
      (8 s), so the window can reach about 14 s, or end sooner on the holder's
      next renewal push. While it lasts, `holdsLease()` is true on both machines,
      so both may send. The lease state converges without residue (the holder
      rejects epoch 1 as below its floor, `FencedLease.ts:284`), but anything
      both machines did in the window, such as a duplicate reply, stands. This is
      the incident's first-boot blip.
    - *A simultaneous boot* of two machines with no lease: both commit epoch 1,
      and the contested tie-break settles them on the first pull tick
      (`MultiMachineCoordinator.ts:1544-1581`, lower machineId keeps it).
    - *A holder restarting after its peer took over* (holder down longer than
      the TTL): it re-acquires at epoch N+1 before pulling, both hold N+1, and
      the tie-break settles it within one or two pull ticks (see (c) for what
      follows if the restarted machine wins). A lid-closed laptop that was the
      holder can do the same without restarting: if its overdue heartbeat tick
      fires on wake before its first pull, it acquires N+1 against a peer that
      already holds N+1.
  - **(c) An unplanned hand-over on holder restart,** pre-existing and
    independent of this spec. A restarted process starts its renewal nonce at 0
    (`LeaseCoordinator.ts:171`, `:255`), and the peer drops same-epoch renewals
    at or below the nonce it last saw (`HttpLeaseTransport.ts:492-494`), while
    still acking them `confirmed` (the drop path returns the epoch), so the
    restarted holder cannot see the drop. This applies to essentially every
    holder restart while the peer process stays up: a quick restart self-renews
    epoch N, and a longer one re-acquires N+1 (the peer accepts that acquisition
    because the epoch is higher, then drops its later renewals the same way). It
    also applies when the peer wakes after the holder restarted alone. The peer
    stops seeing renewals, lets the lease expire, and takes over; the restarted
    machine folds the higher epoch and yields. The takeover sticks; it does not
    hand back. If instead the restarted machine wins an equal-epoch tie-break,
    its next renewals are dropped the same way and one further hand-over follows
    after about one TTL. Tracked for the maintainer (Out of scope); the live
    proof records the observed number of transitions rather than assuming a
    bound.
  - **(d) A no-holder window, not an exclusivity one: a holder whose only
    dialable peer is unreachable is held about half the time,** pre-existing and not changed here. Its renewal broadcast resolves
    false (`HttpLeaseTransport.ts:209-233`), so after one TTL without a confirmed
    renewal `holdsLease()` turns false and `renew()` self-suspends
    (`LeaseCoordinator.ts:335`, `:895`). The B3 timer skips a non-holder and the
    pull-loop nudge refuses our own lease (`:647`), so it re-acquires only on the
    2-minute heartbeat tick, which marks it held for another TTL (`:708`). At the
    defaults that is roughly 60 s held in every 120 s, with the epoch rising by 1
    each tick, and replies held in the gaps. Nothing reports it: on the local
    store `casWrite` succeeds, so the Change 4 counter never fires. This is the
    operator's normal case (the always-on Mac Studio in charge while the laptop is
    lid-closed), and the earlier observation on 3 Oct (the laptop dropping its
    lease every TTL while the stopped Studio stayed registered). The existing
    remedy is the dark solo-captain hold. It engages at once when this machine
    took the epoch from a peer's lease (expiry, presumed-dead or not-renewing;
    `peerTakeoverAuthorizedEpoch`, `LeaseCoordinator.ts:394-399`, `:695-706`):
    the common case of the laptop holding, closing its lid, and the Studio
    taking over on expiry is then held continuously. Otherwise it rests on
    `allPeersPresumedGone`, which under Change 1 waits `failoverThresholdMs`
    (15 min) for an observed peer and never fires for a peer not observed since
    boot. So an enabled hold still leaves two cases intermittent: the Studio was
    already the holder when the peer went silent, and the Studio restarted (or
    otherwise re-acquired its own lease) with the peer never observed. It covers
    less than an enabled hold would on today's build (Change 1, third
    difference). Closing this is a separate change (Out of scope).
- **Why the local store is still right for an untracked registry.** The git store
  cannot accept any write on an untracked registry, so it fences nothing and adds
  the incident's read-back. With a tracked registry the git remote can serialize
  accepted commits through push rejection (clock skew aside), but this
  implementation does not use that to enforce exclusive holding: a rejected
  candidate can still become a steady holder through peer-confirmed renewals
  (deferred item (i)).
- **Partition.** `LocalLeaseStore` is a local compare-and-swap plus wall-clock
  expiry. While two machines are partitioned, each can hold after the TTL.
  Self-suspension fences only until the next tick. This predates this spec. A
  two-machine pool can keep exactly one authority during a partition in two
  ways. Requiring both machines to agree leaves no holder whenever either is
  unreachable. A shared third-party arbiter would let a surviving machine keep
  authority, but it is a new dependency and a new failure point (and the git
  remote cannot serve, as stated above), so it is out of scope for a fix to an
  incident; it is noted for the maintainer. Change 1 narrows
  takeover triggers whenever `leaseTtlMs < failoverThresholdMs` (the default: a
  60 s TTL, 2 × `ingressHeartbeatMs`, against 15 min), because the lease expires
  before the liveness window closes. If an operator sets the threshold at or
  below the TTL, Change 1 can declare a peer dead during an HTTP-only cut that
  git-carried evidence would have bridged, letting a takeover begin up to TTL
  minus threshold earlier than expiry would; Change 4's ordering check reports
  that configuration. When the partition heals, the pair converges: the higher
  epoch folds in, or the contested tie-break decides an equal epoch. Sends during
  a split are not prevented.
- **Clock skew.** Expiry compares the holder's wall-clock `expiresAt` with this
  machine's clock. With both machines connected and clocks that do not step, the
  overlap caused by expiry disagreement alone is bounded by the skew. That bound
  says nothing about a partition or a clock step, which can widen it; neither is
  prevented.
- **Residual GitLeaseStore read-back (tracked registry).** It can still fire when
  the registry is tracked, a push fails, and `canAcquire` is true: no lease, an
  expired lease (including expiry caused by skew greater than the TTL), or a
  peer presumed dead under Change 1's stricter rule. It no longer fires on
  frozen `lastSeen`. It can also be reached through the self-renew branch when a
  tracked registry's working tree holds this machine's own unpushed candidate
  from an earlier failed push. It is **not bounded** while a peer is reachable:
  the peer folds and confirms the renewal, so the machine holds steadily on a
  lease git never accepted, and `_staleOwnerSelfProof`'s 2-machine git branch
  still counts it as durable authority (pre-existing; Out of scope). Nothing in
  this spec reports or stops it; it is deferred item (i).
- **Registry untracked after boot.** The medium check runs once per process.
  If the registry leaves the git index while the process runs (`git rm --cached`
  on it, or a pulled commit that deletes the tracked entry; adding it to
  `.gitignore` alone does not untrack a tracked file), the git store, the debouncer and durable lease
  authority stay in force until the next restart, with the incident's
  amplifier for that process. Any change to whether the registry is tracked
  needs a restart; the agent-awareness text says so, and a test pins the
  tracked-at-boot, untracked-at-runtime case (git store kept until restart,
  then local).
- **Untracked registry whose medium check errored.** Change 3 keeps
  `GitLeaseStore` on any check error, so that process runs exactly as before
  this spec, and items (i) and (ii) can fire on every acquisition write. Change 1
  still removes the frozen-`lastSeen` trigger, the check-error degradation names
  the cause and says the git store was kept, and the next restart re-runs the
  check.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Peer presumed dead / gone (Change 1) | `invariant` | Fixed precedence over two positive-liveness sources: positive evidence beats absence, and unknown ⇒ not dead and not gone, for every callback (P20, no exception). Deterministic, with no arbiter. The floor (`current-lease-expired`) is unchanged. |
| Boot: git vs local lease store (Change 3) | `invariant` | A repo fact (path tracked), plus the existing per-machine inputs. A check error keeps today's store and reports. |
| Degradation thresholds (Change 4) | `invariant` | Fixed counters on reporting only. |

## Evidence declarations (Verify the State, Not Its Symbol)

- **Peer liveness.**
  - SYMBOLS: registry `lastSeen` (which also moves locally on a peer endpoint
    change or a handoff), and coarse git-heartbeat re-records. Neither proves
    liveness, so the new rule excludes both (`lastSeen` survives only
    behind the `liveness:false` switch).
  - STATE: the peer process is alive.
  - CORROBORATION: this machine's own live pull receipt from the peer, and a
    verified signed renewal with an advancing nonce. They differ in strength.
    The renewal is authenticated: only the holder's key can sign it. The live
    receipt is not: `PeerPresencePuller` sends a signed `session-status`
    request, but `MeshRpcClient` does not verify who answered, so any HTTP 200
    carrying an object result from the peer's address counts
    (`MeshRpcClient.ts:90`). A spoofed or misrouted answer can therefore keep a
    peer "alive". It can never cause a takeover or a second holder. It can delay
    a takeover (and `canAcquire` still takes over on lease expiry first,
    `FencedLease.ts:313`), keep the dark solo hold from engaging, and hide that
    peer from the unobserved-peer report. Neither source proves the peer is
    alive at this instant, since a delayed renewal can arrive after its author
    stopped; that is why each counts for at most `failoverThresholdMs`. Fresh
    evidence never prevents acquisition once a lease has expired (`canAcquire`
    checks expiry first, `FencedLease.ts:313`), but a standby's receipt, or a
    renewal entry retained after hand-over, keeps suppressing the solo hold
    until its own freshness window ends.
  - UNMEASURABLE (neither observed): not dead, not gone. Lease expiry remains the
    takeover path. Change 4 reports the blind feeder.
- **Self-renew of a stored lease** (unchanged code, `LeaseCoordinator.ts:684`).
  SYMBOL: a stored, unexpired self-held lease. STATE claimed: this machine is the
  accepted holder. CORROBORATION: on `LocalLeaseStore`, the stored lease is one
  this machine's own compare-and-swap accepted into the store (persisted to disk
  except when `persist()` swallows a write failure, Out of scope), and
  `renew()` then needs a peer's tunnel acknowledgement of the re-signed lease.
  The acknowledgement proves only that the peer's observed epoch equals ours:
  the peer may have discarded this renewal under its nonce watermark and still
  acked `confirmed` (window (c)), and it never proves git accepted the lease, so
  on a tracked `GitLeaseStore` the corroboration is incomplete: deferred item
  (i). A regression test pins that a discarded renewal still receives the ack.
  UNCONFIRMED by any peer: the holder serves until one TTL after the latest of
  process start (`LeaseCoordinator.ts:228`), any acquisition, confirmed or not
  (`:708`), or a confirmed renewal, then self-suspends.
- **Lease medium eligibility.**
  - SYMBOL: a git-sync manager exists.
  - STATE claimed: the registry is a file git can commit.
  - CORROBORATION: `ls-files --error-unmatch`.
  - UNMEASURABLE (git error): unknown, so today's store is kept and the error is
    reported.
  - Push reachability is unmeasured at boot. Change 4 surfaces push failure at
    runtime only as counted unconfirmed acquisition writes (about 10 minutes with
    a non-confirming dialable peer); with a confirming peer, or no dialable peer,
    it is not reported and is part of deferred item (i).
- **Single authority during a partition.** Unmeasurable by either side. Posture
  stated above: convergence on heal, not prevention.

## Frontloaded Decisions

1. **Scope: Changes 1, 3 and 4.** The `GitLeaseStore` write semantics are not
   changed. Each deferred item is classified here:
   - (i) **Unconfirmed-candidate read-back:** residual, conditions stated above,
     no longer on the incident's trigger, and removed from untracked registries
     by Change 3. **Not reported** in its persistent form. Its detector is
     deferred with it (Out of scope).
   - (ii) **Post-commit push-failure leak:** independent of liveness. It surfaces
     only after a failed push on a tracked registry. Change 4 reports sustained
     failure only while at least one dialable peer exists and none confirms
     renewals (about 10 minutes at the defaults). With a confirming peer it is
     masked exactly as in (i), and so is not reported.
   - (iii) **`syncSequence` monotonicity:** only reached through (ii).
   - (iv) **Distinct `casWrite` failure reasons:** diagnostics only.
   - (v) **`refresh()` leak:** same class as (ii), and unreachable from the
     server: `renew()` calls `store.refresh()` only when no tunnel is wired
     (`LeaseCoordinator.ts:862-871`), and the server always wires one.
   - (vi) **Retry cap regardless of id order:** bounded today by the next tick.
   - (vii) **Same-epoch tunnel fold:** affects how fast a renewal is seen, and
     fails toward takeover after expiry.

   Judged against the incident *class* (an awake machine on a lease the medium
   never accepted), not just its trigger: (iii), (iv), (vi) and (vii) cannot
   produce it, and (v) is unreachable from the server. (i) and (ii) can, but only
   on a tracked registry with a failing push, or on an untracked registry whose
   Change 3 check errored (reported, re-checked at restart). Changing them alone
   was shown in review round 1 to risk leaving no holder, so they need a
   maintainer design pass. **Principal deferral approval for (i), (ii) and (v)
   (each scenario as described above), and ratification of the
   reachability-over-strict ranking above (the partition case, the brief boot
   overlaps and the restart hand-over it names), are requested from the operator
   in the spec-approval message** (owner: Echo, the instar maintainer; reported
   back in topic 47547 within 14 days of merge). Implementation and merge wait
   until that approval is recorded in the frontmatter, separately from the
   already-approved detector and boot-pull deferrals.
2. **Unconfirmed-write alert threshold:** 5 (cheap-to-change-after: signal
   only). **Renewal-freshness window:** `failoverThresholdMs`, the same horizon
   as the router verdict.
3. **Switches:** `multiMachine.leaseFlapFix.{liveness, mediumCheck,
   unconfirmedWriteAlert}`, absent ⇒ on, read live (`mediumCheck` applies at
   restart). `multiMachine` is not in `PATCHABLE_CONFIG_KEYS` (`routes.ts:2040`),
   so a Bearer token cannot flip them; only a config-file edit (or the
   conversational path that edits the file) can, and `multiMachine` is not added
   to the allowlist. A flip is detected where the switch is read and logged once
   per transition, with actor `config-file`. They must never be seeded into
   `ConfigDefaults` (a persisted `false` would disable the fix), and they sit
   outside `monitoring.*`, so the guard-posture tripwire does not see them.
4. **No migration.** `LocalLeaseStore` reads `state/lease-local.json`, never the
   registry's `lease`, so B's stale self-candidate in `registry.json` is inert.
   The store transition is itself a boot without a lease of its own. A machine
   moving from the git store to the local store for the first time starts with
   an empty `lease-local.json` (a machine that used the local store before keeps
   whatever lease that file holds), so it goes through window (b)'s standby
   blip once. A machine that was the holder acquires epoch 1, below the peer's
   view, is fenced by the peer's higher-epoch ack (`HttpLeaseTransport.ts:385`),
   re-learns its former lease by pull, and window (c) follows.

   `mediumCheck:false` restores today's store choice. On an untracked registry
   that is the incident's amplifier again (deferred item (i)), and this spec
   does not characterise the outcome: depending on epochs, the peer's nonce
   watermark and whether the peer is reachable, the machine may yield, hand
   over, hold steadily on a lease git never accepted, or hold intermittently as
   in window (d). The Rollback section gives the sequence (revoke the standby
   first). A rollback test records what actually happens, without asserting a
   bound.

5. **Mixed versions.** Expected behaviour, under uninterrupted processes, B3
   resolved on and renewals accepted (window (c) can add hand-overs on any
   restart), and pinned by a mixed-version test: an upgraded machine judges an
   old peer alive and does not contend. An old standby on an untracked registry still makes **one**
   unwarranted takeover of a live upgraded holder after `failoverThresholdMs`
   (frozen `lastSeen`), and then holds on a lease git never accepted (the
   read-back state); nothing reports that while the old code runs. The upgraded
   machine folds that higher epoch, yields, and then sees the old holder's
   renewals as fresh, so it never re-contends: the pair settles with the old
   machine as holder and does not flap. Upgrading that machine moves it to the
   local store, which ends the state (Frontloaded 4); if its medium check errors,
   the git store is kept and the check-error degradation reports it. Upgrading
   every machine is still advised.
6. **Live proof before merge.**
   - **Provisioned by the agent, before the run starts:** two BotFather bots (an
     *agent* bot for the throwaway homes, and a *demo-user* bot that plays the
     human via `liveTest.demo`) and a demo Telegram forum group with both bots
     added. The operator has authorised the agent to create these through the
     operator's dedicated Playwright Telegram profile, so no token is requested
     from him; each token goes straight into the throwaway homes' vaults. Luna's
     own bot is never used, because it would collide with her lifeline polling.
   - **Two throwaway homes on one host, on separate ports.** A local bare repo is
     the git remote. Home B is set up with `git clone file:///…/bare.git` and then
     `instar join http://127.0.0.1:<portA> --dir <homeB> --code <code> --port
     <portB>` (a `file://` URL alone never pairs). After the scaffold, both homes
     get `failoverTimeoutMinutes: 3` (above the default 60 s TTL, so the run stays
     inside the ordering Change 1 relies on) and Telegram config pointed at the
     demo group with the agent bot. A sets `gitBackup.enabled:false`; B keeps the
     default with `registry.json` untracked. Both homes resolve the B3 renew
     timer on (`MultiMachineCoordinator.ts:951-953`: an enrolled Telegram origin
     writer, which an enabled Telegram adapter enrols, `server.ts:4499-4500`, and
     which the live proof has; or `resilientRenew.enabled:true`; or
     `developmentAgent:true`; an explicit `resilientRenew.enabled:false`
     overrides all three): without it a
     60 s TTL against a 2-minute tick makes the epoch climb regardless of this
     fix. The runner records `resilientRenew` in each `/health` snapshot. This reproduces the incident's mixed
     pair.
   - **Built work: a lease live-proof runner.** The existing user-role harness
     only sends and asserts messages, so a runner orchestrates around it: stop a
     home, start a home with an empty `lease-local.json`, cut and restore the
     loopback link between the homes, boot both at once, flip each switch. It
     reads `/health` before and after each step, and drives demo-user sends
     through the harness. Each send is correlated with the outbound attempts and
     delivered replies, and the expected delivery count is asserted. It writes a
     signed artifact mapped to `RiskCategory`:
     - **happy-path:** steady state for at least 2 × `failoverThresholdMs` (6
       minutes), one holder, flat epoch, live HTTP evidence flowing, each demo
       message answered exactly once;
     - **lifecycle:** empty-file standby boot (standby within one pull interval
       plus one request timeout of its boot acquisition returning, then no
       further acquisition), holder restart while its peer is down
       (re-acquires at once), holder restart while its peer is up (converges to
       one holder; the number of transitions is recorded), holder stopped and
       taken over by a running standby within TTL plus one heartbeat tick, and
       the held fraction over at least 3 heartbeat ticks with the peer down
       (recorded as window (d), not asserted away);
     - **concurrency:** simultaneous boot, one holder within 2 lease-pull
       intervals plus one request timeout, counted from the later of the two
       boot acquisitions returning (the same contract as the E2E);
     - **failure/rollback:** partition then heal to one holder, and every switch
       set false giving legacy behaviour;
     - **regression:** `leaseMedium: local` on the untracked home, and the mixed
       pair stable past `failoverThresholdMs` where the legacy build flaps.

     Delivery during the boot and restart windows in (b) and (c) may be
     duplicated or held; the artifact records it rather than asserting it away.
   - **channel-parity:** the same steady-state and takeover scenarios also run
     over Slack, using the harness's existing Slack support (`SlackLiveSender`,
     the `RealChannelDriver` `slack` surface, and `LiveTestRunner`'s
     `slackChannelId`). This needs, in the SageMind Slack workspace:
     - (a) a **separate demo Slack app** with its own bot token and Socket Mode
       app token. Luna's app cannot be reused: Socket Mode spreads events across
       every connection of one app, so live Luna would lose events.
     - (b) a **sender identity** that is not the agent (a second bot or a user
       token) for `SlackLiveSender`.
     - (c) the demo channel registered with its `workspaceId`.
     The agent creates and installs the app itself if its seat allows it. If
     workspace admin approval is required, that one approval is the only operator
     input, and it is requested with the spec approval. Both homes connect to one
     app, so Slack delivers each event to one of them, which also exercises
     `SlackForwardBridge`.
   - The run ends at merge and release. Re-pairing the operator's Mac Studio and
     a 30-minute post-ship watch follow. Moving the Roblox topic waits for the
     separate window (d) change (operator decision 3 Oct 16:05 PDT).

## Open questions

*(none)*

## Tests

- **Unit, builder (`leaseLiveness`).**
  - The classification table generated exhaustively over (receipt fresh, stale
    or none) × (renewal fresh or not) × (router present or absent), for both
    callbacks.
  - Coarse-only receipt ⇒ not counted.
  - Wall-clock stepped forward and back between receipts: the verdict follows
    monotonic time only.
  - Unobserved, even with `lastSeen` hours old, for any duration ⇒ not dead and
    not gone.
  - Fresh renewal, then stale renewal, with no router receipt: not dead, not
    gone, and not in the unobserved-peer report, read through the real
    `getFreshness` interface.
  - A never-dialable peer registered after a long uptime: not reported until 2 ×
    threshold after it was first seen registered.
  - A registered but never-dialable peer ⇒ never gone.
  - A revoked holder: omitted from both callbacks, taken over on expiry.
  - A dialable `pending` peer: never observed, reported with `not-pulled
    (status: pending)`.
  - An entry with `status: 'revoked'` but no `revokedAt`: classified non-revoked;
    never gone without receipt history, gone `failoverThresholdMs` after its
    last receipt with history.
  - A peer observed, then its endpoints removed, then restored, with fresh,
    stale and absent evidence: classified by its evidence throughout.
  - A peer sampled dialable, never observed, then its endpoints removed:
    reported as `previously-dialable`.
  - A stub live receipt for a peer that is actually gone: `allPeersPresumedGone()`
    is false and the unconfirmed renewal self-suspends, as with the hold off.
  - No router at all, with a fresh renewal from the holder: alive (row 2); with
    none: not dead, not gone.
  - The same callbacks, built before the router exists: they see it once
    constructed, then a live receipt (alive), then that receipt going stale
    (dead, absent a renewal).
  - `liveness:false` ⇒ today's rule exactly.
  - Both routes: A's (no git manager) and B's (git manager, untracked registry).
- **Unit, coordinator.**
  - `sample()` on a 3-machine holder whose renewals confirm via B: a
    never-observed C is reported after 2 × threshold from C's first dialable
    tick, with no callback ever invoked; a peer first dialable after boot waits
    the full window.
  - Unconfirmed-write counter on `casWrite`: degradation at 5, reset on success;
    a broadcast-only renewal failure does not count; with no dialable peer, a
    handed-back candidate is renewed and the count stays at 1 (pinned, as the
    stated unreported case); with fake timers and a dialable peer that never
    confirms, it reaches 5 at about 10 minutes.
  - Boot degradation when `failoverThresholdMs <= leaseTtlMs`, naming both
    values; none at the defaults.
  - Only a revoked other machine registered: no Change 4 report; an
    endpoint-less, non-revoked one: reported as never dialable.
  - A self-suspended holder's broadcast stamps freshness, and expiry still allows
    takeover.
  - A same-epoch renewal with a nonce at or below the peer's watermark: the peer
    acks it `'confirmed'` and leaves `lastObserved` unchanged (pins window (c)).
  - Unconfirmed self-renew: serves until one TTL after the latest of process
    start, any acquisition, or a confirmed renewal (with a monotonic clock
    starting at a large value, as `hrtime` does), then self-suspends.
- **Unit, real git** (new `tests/unit/leaseMediumSelection.test.ts`, temp repo
  with a bare remote):
  - tracked ⇒ git; untracked ⇒ local, with a degradation only when peers are
    registered; ignored but tracked ⇒ git;
  - exit-status mapping, one test each: status 0 ⇒ tracked; thrown with status 1
    ⇒ untracked; thrown with status 128 ⇒ `git-exit-128`; an injected
    `ETIMEDOUT` error (a fake executor, since a real 2 s timeout cannot be
    produced reliably) ⇒ `timeout`; an injected signal kill ⇒ `signal-<name>`;
    an injected `ENOENT` ⇒ `spawn-error`; an injected guard error ⇒ `refused`;
    each check error keeps the git store and reports one degradation naming its
    kind;
  - run from a different `cwd` than the agent repo, the check still uses
    `config.projectDir` and gives the right answer;
  - not a repo ⇒ no git-sync manager, so local, as today;
  - the debouncer is not wired on local.
- **Integration (Tier 2):** an HTTP `/health` test asserting
  `multiMachine.syncStatus.leaseMedium` and `reason`, including `unchecked` /
  `switch-off` and `local` / `no-git-sync-manager`.
- **Wired:** a test that `server.ts` calls the selection function and the
  liveness builder, does not wire the debouncer on `local`, and on `local`
  leaves `_hasDurableLeaseAuthority` false and the 2-machine branch of
  `_staleOwnerSelfProof` returning false, while the backup `gitSync` instance
  is still constructed (the `lease-tick-watchdog-boot-lifecycle.test.ts`
  pattern); and that `tickLease` and `initializeLease` call `sample()` through
  `sampleLiveness`.
- **E2E:** extend `tests/e2e/multi-machine-lease-split-brain.test.ts` (it already
  has real `LocalLeaseStore`, `HttpLeaseTransport` and `LeaseCoordinator`, plus a
  `partitioned` flag) and `tests/integration/lease-http-convergence.test.ts`.
  Callbacks come from the builder. The router source is fed by a
  `MachinePoolRegistry` with stub live and coarse beats, so both sources are
  exercised. Scenarios:
  - **the incident:** a mixed pair, built with a real `GitLeaseStore` for B over
    a temporary repo whose `registry.json` is untracked (the existing test builds
    two `LocalLeaseStore`s, `multi-machine-lease-split-brain.test.ts:112-117`),
    with each machine's selected store asserted: with every switch off the flap
    reproduces after `failoverThresholdMs` (rejected write, self-renew, role
    oscillation); with the fix, one holder and no epoch churn for at least 2 ×
    `failoverThresholdMs`, with live HTTP evidence flowing throughout;
  - two `LocalLeaseStore`s with frozen `lastSeen`: with `liveness:false` the
    flap reproduces from liveness alone; with the fix it does not;
  - empty-file standby boot: holds for at most one pull interval plus one
    request timeout after its boot acquisition returns, then standby, with no further acquisition for 2 ×
    `failoverThresholdMs`;
  - holder restart with its peer down: re-acquires at once; then the held
    fraction over 3 heartbeat ticks is recorded (window (d));
  - holder restart with its peer up, with a large prior nonce watermark on the
    peer: the trace of renewal drops, expiry, takeover and fold is asserted, and
    the final single holder with a stable epoch for at least one TTL;
  - holder stopped: a running standby takes over within TTL plus one heartbeat
    tick;
  - simultaneous boot: one holder within 2 lease-pull intervals plus one request
    timeout, counted from the later boot acquisition returning, then a stable
    epoch for at least one TTL;
  - partition then heal: one holder within 2 lease-pull intervals plus one
    request timeout after the heal, then a stable epoch for at least one TTL;
  - one-way connectivity (A reaches B, B cannot reach A), and status pulls
    succeeding while lease broadcasts fail: behaviour during the fault is
    recorded (characterisation); after connectivity is restored, the test
    asserts one holder within 2 lease-pull intervals plus one request timeout,
    then a stable epoch with confirmed renewals for at least one TTL;
  - tracked registry at boot, removed from the index at runtime (verified with
    `git ls-files`): git store kept until the next restart, then local;
  - coarse-only beats: not counted as live;
  - upgrade from the git store to the local store with a live higher-epoch peer:
    one blip, then standby; the same upgrade on the machine that was the holder:
    fenced by the peer's higher-epoch ack, re-learns its lease by pull, then
    window (c); the same upgrade with an existing `lease-local.json` above, equal
    to and below the peer's epoch: converges to one holder; delivery throughout
    is recorded;
  - mixed versions (one machine on today's build), under the Frontloaded 5
    conditions: one unwarranted takeover after `failoverThresholdMs`, then no
    flap;
  - a `mediumCheck` rollback on an untracked registry: the outcome is recorded
    (characterisation, not a regression assertion).
- **Live:** the matrix in Frontloaded Decision 6.

## Multi-machine posture

This is the multi-machine lease itself. There is no new persisted state; the
only new surfaced field is `/health` → `leaseMedium`. Each machine decides from
inputs it can measure. Change 1 is independent of the medium, so a pool that
still mixes media no longer flaps from frozen liveness.

Single-machine agents: Change 3 picks `LocalLeaseStore` for an untracked
registry, which always accepts its own epoch advance. Change 1 and Change 4 see
no peers.

## Rollback

Every lease switch restores prior behaviour, and prior behaviour includes the
incident: `liveness:false` brings back the trigger (frozen-`lastSeen` liveness)
and `mediumCheck:false` brings back the amplifier on an untracked registry.
Reverting the release brings back both. `unconfirmedWriteAlert:false` is the
only switch with no lease effect. So on a paired agent whose registry is
untracked, the rollback sequence is: stop the standby and keep it stopped;
revoke it on the remaining machine (`instar machine remove <id>`, which calls
`revokeMachine`, `src/commands/machine.ts:233`, and takes effect on the next
broadcast with no restart, since `peers()` re-reads the registry each call);
then flip the switch or revert, then restart. Revoking without stopping is
worse than either: the registry is untracked, so the revocation exists only on
the remaining machine; the still-running standby keeps treating it as a peer,
its renewals are refused (auth requires `status: 'active'`,
`machineAuth.ts:72`), and it holds intermittently and unseen while the
remaining machine holds steadily.
Stopping the standby is not enough: a stopped peer stays registered and
dialable, so the remaining machine is in window (d), holding about half the
time (`server.ts:5553-5556`, `HttpLeaseTransport.ts:191-233`). Revoking empties
the dialable set, which restores today's single-machine behaviour (this is what
was done on 3 Oct). Re-pairing waits for a fixed build. `liveness` and
`unconfirmedWriteAlert` apply live; `mediumCheck` applies at the next restart.

## Review provenance

- **Rounds 1 to 7 (v1 to v7)** settled the core: liveness from live evidence
  instead of `lastSeen` (Change 1), medium selection by an exit-status-mapped
  tracked check with a lease-purpose git reference (Change 3), and acquisition-
  write signals (Change 4). Patching `GitLeaseStore.casWrite` directly was shown
  in round 1 to risk leaving no holder.
- **Rounds 8 to 10 (v8 to v10)** added a detector for holding a lease the
  medium never accepted; every DESIGN finding in those rounds was inside it, and
  the 10-round cap was reached. The operator deferred it (3 Oct, 14:46 PDT).
- **Fresh rounds 1 to 9 (v11 to v19)** reviewed the rest. Most DESIGN findings
  from round 5 on were in a boot-pull change ("learn the lease before contending
  at boot"), including a stuck-flag path that would leave no holder and a
  restart wait that would leave the agent unreachable for one to three minutes.
  A code trace (3 Oct) showed that change addressed only the self-healing
  first-boot blip, not the sustained flap, and found the pre-existing restart
  nonce issue. The operator deferred the boot pull (3 Oct, 15:41 PDT).
- **v20** is Changes 1, 3 and 4 only, restated in full. The full per-round
  findings are in the sagemind repo at `docs/instar/lease-flap-review-rounds-1-6.md`.
- **Cycle 3, round 1 (v21)**: two DESIGN findings, both about what the posture
  left out. A holder whose only peer is unreachable holds only about half the
  time (pre-existing, unreported, and the operator's normal case), now window
  (d) and tracked; and never-dialable registered peers were silent, now
  reported. Precision: the restart hand-over applies to nearly every restart
  and does not hand back; the blip can reach about 14 s; duplicate effects in a
  window stand; macOS sleep pauses the monotonic clock; the self-renew grace
  wording; merge waits for the recorded approval.
- **Cycle 3, round 2 (v22)**: two DESIGN findings, both statements wrong about
  the solo hold: a third difference (Change 1 makes an enabled hold cover less
  than today's frozen-`lastSeen` fallback in the operator's case), and window
  (d) omitted the takeover-authorized branch, which narrows what the window (d)
  change must design. GPT: acknowledgement distinguished from acceptance (the
  self-renew evidence contradicted window (c)). Precision: the arbiter argument,
  one timing contract per scenario, the `sampleLiveness` seam, never-dialable
  wording, missing deferral entries, and the Roblox move made conditional.
- **Cycle 3, round 3 (v23)**: one DESIGN finding: `lastSeen` was said to move
  only on the peer's git push, but it also moves locally on an endpoint change
  or handoff, so "frozen" is "usually" (wording only, nothing built changes).
  GPT: the store transition on upgrade is a boot without a lease (now stated and
  tested), and "never past the lease's expiry" overstated (fresh evidence still
  suppresses the solo hold). Precision: the B4 condition on the third
  difference, `getFreshness`, no store kind, the builder's module, the ack pin
  test, a switch-to-behaviour table, and the ELI16 on the backup setting.
- **Cycle 3, round 4 (v24)**: one DESIGN finding: the `mediumCheck` rollback
  was said to yield to the peer, but it always contends at boot and, when the
  registry epoch is the higher one, wins and holds in the item (i) state; now
  stated with its cost and tested in three variants. GPT: the holder-upgrade
  route was misdescribed (it acquires epoch 1 and is fenced), the builder needs
  renewal history as well as freshness, and never-dialable timing runs from
  first registration. Precision: `leaseMedium` gains `unchecked` and named
  reasons; nickname edits also move `lastSeen`.
- **Cycle 3, round 5 (v25)**: one DESIGN finding, again in the rollback
  analysis (a formerly-holding machine hands over rather than holding, because
  of the peer's nonce watermark). Frontloaded 4 now states the possible
  outcomes and the tests record which occurs, rather than predicting each
  path. GPT: the no-router case contradicted the table (a fresh renewal still
  counts), the empty-store assumption is qualified, and the macOS sleep claim is
  labelled unverified with a recorded run to settle it. Precision: `/health`
  precedence and `store`, and the B3 precondition for the live proof.
- **Cycle 3, round 6 (v26)**: one DESIGN finding, the fourth in a row in the
  `mediumCheck` rollback text (with the peer stopped the outcome is window
  (d)). The spec no longer predicts that path: it states that the outcome is
  not characterised, that it is not a recommended rollback on an untracked
  registry, and that a test records what happens. GPT: the classification now
  covers every registered peer (an address removed later is classified by its
  evidence), the "no diagnostic stays on" claim is narrowed to events, and the
  mixed-version claim carries its preconditions and a test. Precision: all
  three B3 routes, machine A's `leaseMedium` with the switch off.
- **Cycle 3, round 7 (v27)**: one DESIGN finding, again on rollback: stopping
  the standby leaves the remaining machine in window (d); the sequence now
  revokes it. GPT: the Rollback text had called `liveness:false` safe although
  it restores the trigger, and reverting likewise; every lease lever is now
  stated as restoring prior behaviour, with one consistent sequence. Also:
  previously-dialable unobserved peers are reported, and one-way connectivity
  cases are recorded. Precision: revoked peers omitted from both callbacks, and
  the feeder's `status: 'active'` scope.
- **Cycle 3, round 8 (v28)**: internal reviewer DESIGN=0. GPT raised one
  missing failure mode (the registry untracked while a process runs; now
  stated, restart required, tested) and two points answered in place: the
  receipt-versus-renewal asymmetry is justified (a silent holder is taken over
  on expiry, which engages the hold), and characterisation scenarios now assert
  convergence after the fault is removed. Precision: the rollback sequence
  stops the standby before revoking it (revoking alone leaves it holding
  unseen), the `not-pulled` qualifier, and "revoked" defined as `revokedAt`.
- **Cycle 3, round 9 (v29)**: two DESIGN findings (internal) and two (GPT), all
  statements wrong about existing behaviour, none in Changes 1, 3 or 4: the
  receipt-asymmetry paragraph's "only a former holder" (hand-back, tie-break
  and superseded epochs also qualify), "never gone" for a malformed revocation
  with receipt history, and a `.gitignore` example that does not untrack a
  file. Corrected. The 10-round cap is reached with round 9 not clean.
- Cross-model review: GPT (`codex-cli`, gpt-6-astra, model verified from the
  Codex session log) ran in rounds 2 onward. Gemini never produced a review: its
  CLI refused to start (the signed-in account needs a Google Cloud project). By
  operator direction (3 Oct, 14:24 PDT) the review proceeds on GPT only. Internal
  reviewers were combined: three agents in rounds 2 to 4, one all-lens agent per
  round thereafter.

## Out of scope, tracked

- **Boot pull** (operator decision 3 Oct 15:41 PDT; owner Echo, within 14 days of
  merge). Closes window (b)'s standby blip. The v19 draft is the starting point:
  a per-peer `pullAllPeers` result, a boot decision on the snapshot at a 5 s
  deadline, and a `bootPending` flag. Its review found that the flag must be
  released on every boot branch, on throws, and by a ceiling; that a "no peer
  answered" wait must not apply when the restarting machine already holds the
  latest lease (renewals are broadcast-only, so `lease-local.json` keeps the
  acquisition expiry and a quick restart misses the self-renew shortcut); and
  that the server's outer catch is reached after the decision too. A cheaper
  alternative to evaluate first: have the `/api/lease` ack report
  `max(transport observed, own currentEpoch())`, so a booting standby's
  epoch-1 broadcast is fenced before it ever reports awake (inferred, untested).
  <!-- tracked: sagemind topic 47547 -->
- **Reliable holding with the only peer unreachable** (window (d)). The
  operator's goal (the Mac Studio serving while the laptop sleeps) needs it. The
  candidate is the existing solo-captain hold, enabled with the always-on
  machine as `preferredAwakeMachineId`, plus a design for the two cases it
  leaves intermittent: the Studio already the holder when the peer went silent
  (including after a U4.4 hand-back, which sets no takeover authorization)
  (it waits `failoverThresholdMs` under Change 1, where today's frozen-`lastSeen`
  fallback would engage at once), and the Studio restarted or self re-acquired
  with the peer never observed (never engages under Change 1). Takeover from a
  peer's lease is already covered by `peerTakeoverAuthorizedEpoch`. Any shortening must keep P20
  (an uninitialized state cannot authorize recovery) and the epoch fence. To be
  specified and reviewed as its own change. <!-- tracked: sagemind topic 47547 -->
- **Restart nonce watermark** (window (c)). `nonceCounter` starts at 0 in every
  process (`LeaseCoordinator.ts:171`, `:255`) while peers keep the old high
  nonce as the drop watermark (`HttpLeaseTransport.ts:492-494`), never reset on
  an epoch change. Fix candidates: seed the counter from the clock, or reset the
  watermark when the epoch rises. <!-- tracked: sagemind topic 47547 -->
- `GitLeaseStore` write hardening (items i to vii above).
  <!-- tracked: sagemind topic 47547 (moved from 46908); sent to Echo msg-1791058165363-gmjui2 -->
- **A detector for holding a lease the medium never accepted** (deferred with
  item (i), operator decision 3 Oct 14:46 PDT; owner Echo, with item (i), within
  14 days of merge). The draft from review rounds 8 to 10 is the starting point.
  It reads `git show @{u}:<repo-relative registry path>` once per epoch, in the
  self-renew branch, on `GitLeaseStore` only. Its complete verdict table:
  accepted (epoch N, this holder), superseded (epoch above N), unconfirmed
  upstream (everything else, including epoch N held by a peer, or the path
  absent upstream), and unknown (the ref is unresolvable or the read fails,
  retried at the next visit). It must not feed any proof, because a per-epoch
  verdict is absent for a healthy holder and goes stale after a later push.
  <!-- tracked: sagemind topic 47547 -->
- `LocalLeaseStore.persist()` updates its in-memory cache and swallows a failed
  disk write, so `casWrite` can report success for a lease that is in memory
  only. Pre-existing. After a restart the file holds an older lease or none; the
  machine then re-acquires or self-renews as today, and any higher epoch a peer
  holds folds in and wins. Propagating the failure is a store-level change for
  the maintainer. <!-- tracked: sagemind topic 47547 -->
- `_staleOwnerSelfProof`'s 2-machine git branch (`server.ts:5737-5740`) returns
  true whenever a git-sync manager exists: `GitLeaseStore.read()` always returns
  an object (`GitLeaseStore.ts:43-46`), so the null check never fails. It proves
  neither current reach nor that the remote accepted any lease, so its intent ("a
  claimer with a broken NIC must never claim", `server.ts:5708-5710`) is unmet
  there, before and after this spec. A correct proof needs a live remote probe
  and a per-evaluation upstream comparison: a U4.2 design change for the
  maintainer. <!-- tracked: sagemind topic 47547 -->
- `instar join` problems, plus one in `instar pair`:
  - `instar join` scaffolds `config.json` without the inviter's `gitBackup`.
  - `instar join` booted a second machine as the first when the agent repo
    tracked `.instar/machine/identity.json`.
  - `instar pair` migrates plaintext secrets that agent scripts read directly.
  <!-- tracked: sagemind topic 47547, msg-1791058165363-gmjui2 -->
