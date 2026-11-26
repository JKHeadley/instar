---
title: "A planned restart keeps the lead: the lease outlives the boot while a restart is pending"
slug: "planned-restart-keeps-lead"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
parent-spec: "docs/specs/takeover-ready-pool.md"
eli16-overview: "docs/specs/planned-restart-keeps-lead.eli16.md"
lessons-engaged: "finding_668 (2026-06-02 solo demotion), fb-2bf6ccd0-705 (boot race), incident_role_restart_lease_loop_1121, ACT-1308, P19, P20, P21, P22, L7, B23"
review-convergence: "2026-11-21T13:20:26.617Z"
review-iterations: 6
review-completed-at: "2026-11-21T13:20:26.617Z"
review-report: "docs/specs/reports/planned-restart-keeps-lead-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 16
cheap-to-change-tags: 0
contested-then-cleared: 15
clean-door-anthropic-review: "claude-code:claude-fable-5"
approved: true
approved-by: "echo, under the operator's standing rule (Justin, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes\") and Approval Only Where Required; the design serves the owner-approved post-mortem fix program (topic 145840, 2026-11-20) and the parent spec takeover-ready-pool; no constitution or CODEOWNERS path touched; the convergence report (docs/specs/reports/planned-restart-keeps-lead-convergence.md) was read before approval"
---

# A planned restart keeps the lead: the lease outlives the boot while a restart is pending

## Problem statement

On the Echo pool (Studio named preferred, Laptop, Mini; instar 1.3.1944) between 00:27 and 01:51 PST on 2026-11-21 the
lead cycled and the merge line never ran (fb-135e3043-add, fb-fdb55c1c-a79 — Echo's own filings of the incident; the
owner's attributable act is the approval of the post-mortem fix program in topic 145840 on 2026-11-20, recorded in the
parent spec's `approved-by` line). The *merge line* is Local Verify: the pool's pre-merge test run, which only the machine
holding the lead executes, so a lead that keeps moving means no pull request is ever verified. The restart ledger on the
Studio (`logs/restart-requests.jsonl`) records these consumptions; the sequence between them is a reconstruction from the
feedback records and the code on origin/main at 0f6e66b0e, not a per-epoch log:

| Request written (UTC) | Consumed | Writer and reason |
|---|---|---|
| 08:27:43 | 08:42:30 (supervisor) | role-change: this machine gave up the lease |
| 08:44:27 | 08:44:30 (supervisor) | role-change: this machine took the lease |
| 09:00:29 | 09:14:38 (in-process watcher) | role-change: this machine gave up the lease |
| 09:38:35 | 09:45:31 (supervisor) | role-change: this machine took the lease |
| 09:55:13 | 09:55:21 (supervisor) | role-change: this machine took the lease |

Consecutive requests are 16.7, 16.1, 38.1 and 16.6 minutes apart, so `roleFollowRestart`'s 15-minute stamp held. Three
requests were consumed 3 to 15 minutes after they were written; the ledger does not record why (section 1 step 6 adds
that record), and a Local Verify hold, which defers a planned restart, is the inferred cause. Each round, as
reconstructed:

1. The Studio receives the lead by hand-back (`LeaseHandbackReconciler`, 10-minute health window), for example epoch 23757
   at 09:38:35Z (the feedback record's epoch). `roleFollowRestart` asks for a planned restart because the scheduler is built
   only at boot. The role-restart spec (lease-takeover-role-restart) named "no machine named preferred" as a condition and
   said Echo was unchanged; PR #2783 ("start jobs after lease takeover") widened the shipped condition to `applies:
   config.scheduler.enabled` so that a holder on a pool with a named preferred machine would run its jobs after a takeover
   — the right fix for that problem, which is why this spec ratifies the widening rather than reverting it. The widening is
   the proximate cause of this loop and had no causal record until now; this spec records it and amends the role-restart
   spec's condition to the shipped one (an edit in this change).
2. A restart request is consumed by one of two consumers that race for the same file every 10 seconds. The lifeline's
   supervisor deletes `restart-requested.json` and `planned-exit-marker.json`, sends the server an interrupt, waits 3
   seconds and kills the tmux session (`ServerSupervisor.performGracefulRestart`). The server's own
   `ForegroundRestartWatcher` (constructed in every mode, although its header says it is for foreground mode only) deletes
   the file, writes the marker and hands the shutdown on with the 20-second deadline. The lease has a 60-second TTL
   (`multiMachine.leaseTtlMs`, default twice the ingress heartbeat) and nobody renews it while the process is down. Boot
   takes 70 to 150 seconds on the Studio, about 4 minutes on the Laptop.
3. The lease lapses mid-boot (09:46:44Z). The Mini, the previous holder, claims the next epoch within a second.
4. The Studio's new process reaches `initializeLease()`. Boot claim safety (takeover-ready-pool R1, PR #3541) asks the peers
   first, sees the Mini's newer epoch and adopts it. Correct under R1: its own lapsed lease is never permission.
5. Ten minutes later the hand-back returns the lead to the Studio, which restarts for the role change, and the loop closes.
   Every round freezes the pool for the length of a boot.

The stopgap on the night was `bootClaimSafety.enabled: false` on the Studio only (CMT-2118, topic 145840), which makes the
Studio claim from its own stale record at boot, exactly what R1 exists to remove. This spec replaces the stopgap so it can
be removed.

The cause is not the hold; it is that a restart the machine chose for itself lets its own lease lapse. takeover-ready-pool
R5 ("no restart on role change") removes the restart that started this loop, but update restarts and operator restarts
exist whatever R5 does, and R5 is a later build increment. R5 also said "there is no planned-restart extension; a holder
slower to restart than W is taken over once and gets the lead back at most once through hand-back", written on the
assumption that role restarts are gone. With role restarts still present, hand-back plus a boot longer than the TTL is a
loop, not "once". This spec amends that sentence and its two restatements in takeover-ready-pool.md (R5, Frontloaded
decision 7, the failure-modes row "Holder restarts slower than W") and R1's "on return it adopts the current epoch" clause;
those edits are part of this change.

**Why not act at exit.** The first draft extended the lease in the server's shutdown handler. Review against the code showed
that cannot work on the supervisor's path: it deletes both request files before it signals the server and kills the
server 3 seconds after the interrupt, while the shutdown sequence awaits several subsystems before it reaches the lease.
(The in-process watcher's path has the full 20 seconds, but a design that works on one consumer only is not a design.)
Everything below happens while the server is healthy, before any exit.

**Why not transfer the lead instead.** The textbook answer to a leader's planned restart is a deliberate leadership
transfer to a peer. Here it is wrong: with role restarts still shipped, a transfer is one lead move and one boot, and the
hand-back that follows is a second move and a second boot — the loop's own shape, started on purpose.

**Why not let the lifeline renew during the boot.** The lifeline survives the server's restart, but it does not run in
foreground mode, does not hold the lease signing key today (takeover-ready-pool R2 gives it the key later), and a second
renewing process on one machine would mean two writers of one lease (nonces and `selfIssued` are process state). The
design below needs no second writer and works in every mode.

**Why not reclaim earlier in the boot.** fb-135e3043-add also asks that "boot must not exceed the lease TTL without
renewing". The lease coordinator is constructed and `initializeLease()` awaited well into the server's boot; what consumes
the 70 to 150 seconds before it was not measured on the night (the server's stderr log did not carry the boot timeline).
Moving the lease earlier in the boot order is a boot-order change with its own risks and belongs with takeover-ready-pool's
build increment 5 (R5, the scheduler that no longer needs a restart); the measurement and the move are filed as an
improvement through `POST /feedback` by the build run, bound to that increment by name, and listed in the run's completion
list. The extension here is needed in any case: even a lease initialised in the first second of a boot lapses during a
3-second kill followed by a 60-second process start on a loaded machine.

## Proposed design

One rule: **a machine that restarts for a planned reason while holding the lead keeps the lead through its boot.** It is
implemented inside the existing fenced-lease protocol, with no new network surface and no new record kind on the wire.

**Terms.** **TTL**: the lease time-to-live (60 s on Echo). **Epoch N**: the holder's current fencing epoch.
**Renewal**: the holder's periodic re-signing of epoch N with a later `expiresAt`, broadcast on the lease channel and
folded by peers (`recordObserved`, nonce strictly higher); on Echo every 30 s (`renewIntervalMs` = clamp(TTL × 0.5, 5 s,
60 s)), run by `MultiMachineCoordinator.leaseRenewTick` under its re-entrancy guard, tick timeout and unconfirmed-retry
arm; it exists only with `resilientRenew` resolved on, which this feature requires (section 4). **Request**:
`state/restart-requested.json`, the one file every writer in instar uses to ask this server to restart. **Consumers**: the
lifeline's `ServerSupervisor` and the in-process `ForegroundRestartWatcher`; both record the consumption in the restart
ledger (`recordRestartRequest`) before they delete the file. **Episode**: the state from the first sight of a request until
it ends (section 1); while an episode is open the holder is *pending*. **Window**: the bounded time a pending renewal's
expiry is set ahead. **The continuity file**: `state/lease-continuity.json`, this machine's own signed copy of its latest
pending renewal with the episode's facts. **Window lease**: an own lease on disk that is unexpired and is either carried by
a continuity file or, on a `LocalLeaseStore`, carried by a store record that bears a pending marker (`pendingEpisodeId`
beside the lease in `lease-local.json`, written with every pending renewal through `LocalLeaseStore.persist`, which carries it through `casWrite`, `refresh` and
`relinquish` alike so no write path drops it mid-episode, and cleared by the confirmed boot renewal, by `relinquish()` and
at an episode's end) — a state the store records, never a shape derived from timestamps, and the only
thing rule 1b (section 2) acts on. **Evaluable round**: one `pullAllPeers` round becomes evaluable at the earlier of every
known peer having a probe outcome for it (the transport records a probe when each dial ends) and R1's pull deadline
(`OWN_LAPSE_PULL_DEADLINE_MS`, 10 s) after it started; peers without an outcome by then count as not answered in that
round and their late outcomes feed the next one; a transport that cannot pull, or zero known peers, is evaluable at once.
Rule 1b evaluates when a probe lands and at the deadline, never from the tick's `finally` alone. At most two rounds are in
flight (the tick guard releases at `awaitTimeoutMs`, 20 s, while a dark dial runs to `requestTimeoutMs`, 30 s). **Qualifying answer**: a pull from a *live
peer* whose responder identity was verified — the peer's signed accept-ack checked against its registered key
(`verifyLeaseAckIdentity`), on the mesh dial or on the legacy dial, which this change teaches to send a request nonce whenever the peer's key is known (R1's rules are unchanged; the legacy
dial's probe outcome changes from always-silent to `signed` when the ack verifies, so on a mesh-off pool R1's boot hold now
defers to an answering preferred peer instead of claiming after 45 s of false silence; broadcast confirmation on the legacy
dial stays a 2xx, so an un-upgraded keyed peer mid-rollout cannot suspend the holder) — and that returned the peer's lease view,
`null` included (a verified "no lease" attests no newer epoch at that peer); a bare 2xx with no verified ack, an unsigned
R1 answer (a server still starting) and a peer with no known key never qualify. **Live
peer**: a machine in `knownPeerIds()` (dialable, not revoked) that is not in `presumedDeadHolders()` under the enabled
liveness derivation and is not *settled silent* — silent on at least R1's `silentProbes` probes spanning at least its `silentSpanMs` (3 and 45 s
by default; the same settings, no second knob), R1 rule 4's own test, read from the same probe history. The legacy dial,
which today records every probe as silent, learns in this change to record `signed` when the peer's ack verifies, so a
pool with the mesh dial off does not read its answering peers as silent; a peer whose ack cannot be verified (no known
key) still reads silent and is named in the log as "answered without a verifiable identity", and its returned view still
folds for the superseded check, which is what keeps the survivor hold safe on a pool of such peers. **Confirmed**: a renewal whose `broadcast()` resolved true (a verified epoch ack from a peer, or a legacy
2xx from a key-less peer, or vacuously with zero peers — so `confirmed` means "epoch N acknowledged by a peer", and the
qualifying-answer gate at boot is what makes the boot renewal sound), or whose exact nonce was confirmed late
(`adoptLateRenewal`), or that a git store's `refresh` pushed (a test-only path: in production the
HTTP transport is always constructed and `renew()` never takes the store's push); the solo-captain hold and
`confirmHoldOnPeerPull` never count, and the one defined exception is the survivor hold of section 2 step 5.

### 1. While a restart is pending, every renewal outlives the boot

The holder's renewal is the extension. Nothing new is sent; the renewal's `expiresAt`, cadence and persistence change.

1. **Announce before the request is visible.** A new leaf module `src/core/restartRequestSignal.ts` carries one
   process-wide emitter: `announceRestartRequested({ requestedBy, reason, requestedAt })`, returning a promise, and
   `announceRestartWithdrawn()`. The promise resolves at once when no subscriber is attached (multi-machine off, lease
   not initialised) or the subscriber signs no renewal (this machine is not the holder, or is still confirming its own
   reclaim), and otherwise when the subscriber's window renewal is confirmed or the module's own deadline (equal to the transport's
   resolved broadcast deadline, 8 s with default settings) passes; on a git store (test-only in production terms) the
   subscriber writes the continuity file and nudges the renew tick, whose push is the confirmation, and the promise resolves
   at once — the push never runs on a writer's stack, and a synchronous push could not be bounded by a timer anyway. An
   announce that arrives while one is in flight joins the same promise (coalesced). Subscriber errors are isolated inside
   the module (caught, logged, recorded as `error` evidence); an announce can never throw into a writer, so a failed write
   of the continuity file can never stop an update's restart from being requested, and a failed file write never stops the
   broadcast (the store write, where present, is the fallback copy). Every writer of the request that lives in the server
   process calls it before the request becomes visible (its rename or link): `roleFollowRestart.requestRoleRestart` (via
   its call site in `src/commands/server.ts`), `AutoUpdater.requestRestart`, `AgentServer.requestSupervisedRestart`,
   `sessionPoolPairActivation.requestPairActivationRestart`, `writeSubscriptionReloginRestartRequest`,
   `writeConnectRestartRequest`, `FeedbackFactoryDefaultsSelfHeal.requestSelfHealRestart` and the Telegram `fix-command`
   in `src/commands/server.ts`. The three writers behind nearly every holder restart — role change, update, API restart —
   **await** the promise before publishing, so the request is never visible until the window renewal is confirmed or 8 s
   have passed (then they publish anyway and the continuity file says `confirmed: false`). Their return types become
   promises, and every consumer of those returns awaits: `applyTeamSwitchHere` in `AgentServer` (its callers in
   `machineRoutes` and `TeamSwitches` already accept a promise), the two recommended-services restart wrappers in
   `routes.ts` and the sync `requestRestart(reason): boolean` interfaces behind them in `src/recommended/telegramSetup.ts`
   and `cloudflareDomain.ts` (widened to promises, with their callers in `recipes.ts` and `recommendedServiceRoutes.ts`),
   and `AutoUpdater.gatedRestart`; `DesktopSetupTarget.requestRestart`, `teamRoutes.requireMemoryPrivacy` and the
   already-awaiting route sites take a promise today and stay as they are. The await is asymmetric on purpose: a lost race
   on these three writers re-runs the exact loop this spec ends, while the out-of-process race below costs today's
   behaviour once on a rare path. `reconcileRole` in `server.ts` becomes single-flight (a second call while one awaits returns the
   in-flight promise; the 60-second interval calls it with a catch) and re-evaluates `decideRoleRestart` against the live
   role after the await, skipping the publish on `same-as-boot`. `POST /server/restart` answers 202 up to 8 s later than
   today. The other writers announce and publish at once (announce-then-write): the subscriber has already signed, persisted
   and started the broadcast on the writer's stack, so only a kill within the broadcast's flight can lose it. Two writers
   are normalised in this change so every request has the same shape (`plannedRestart: true`, a 1-hour `expiresAt`,
   `pid`, atomic publish): the fix-command (today a bare write with none of them; it also sets `bypassHolds: true`, so an
   operator's "restart" is not newly held behind a verify run and the reply "momentarily" stays true) and the self-heal
   restart (no `expiresAt`). `withdrawRoleRestart` calls `announceRestartWithdrawn` after its unlink. A writer outside the
   process (the `instar machine` CLI's pair activation, a hand-written file) is covered by a 2-second `fs.statSync` poll of
   the request while this machine holds the lease (one stat; on a filesystem error it logs once and backs off, doubling to
   the renew cadence, and the renew tick's own sighting remains; stops with `coordinator.stop()`); for those writers the
   race with the consumers' 10-second polls is real and a lost race is today's behaviour once, logged at the next boot
   from the restart ledger as `lease-continuity: the last restart (<requestedBy>) had no pending renewal; the lead was not
   kept.` An announced
   episode whose file has not appeared within one poll interval **after its announce promise settled**, and for which the
   restart ledger holds no consumption row (a consumer can read and unlink a published file inside that interval), is
   closed with a log line (the writer failed to publish). **The in-process watcher also awaits** the episode's current
   confirmation promise once (at most the module deadline) for a request it is about to consume whose episode has no
   confirmed window renewal yet, setting its shutting-down guard before the await and re-checking the file and the ledger after it (a request consumed
   meanwhile by the supervisor is left alone, so the shutdown is never re-entered; a file gone with no row was withdrawn
   during the await, so the guard is cleared and the watcher keeps watching), so the one
   consumer that lives in the process never kills a window renewal it could have waited 8 s for.
2. **The subscriber.** On an announce or a sighting it opens the episode (or re-reads an open one; the episode id is a
   `randomUUID` minted in process, never derived from request fields). Then, only if this machine `holdsLease()` and has at least one known peer (a
   standby, or a machine still confirming its own reclaim, opens the episode and does nothing else; a machine with no known
   peer has nobody to extend against and the feature is inert there), it signs the window renewal — epoch N, same `acquiredAt`, `expiresAt = now + window`, fresh nonce — installs it as `selfIssued`
   (`installRenewal` keeps the higher nonce against a TTL renewal in flight), writes the continuity file and the local
   store copy (step 4), and broadcasts **that exact renewal** outside the renew tick's guard with `adoptLateRenewal` as its
   late path, then nudges the renew tick once that broadcast settles so the pending cadence starts without a third
   broadcast in flight. The persisted lease is therefore the broadcast one. Both signing paths are synchronous from reading
   the pending state to `signLease`, so a TTL renewal can never carry a higher nonce than the window renewal, and peers
   fold the higher nonce whatever order the two arrive in (`recordObserved`).
3. **The episode is latched; one rule, stated once.** Any request file present opens an episode (the watcher acts on any
   existing file, expired or not, so a present file means a consumer will act). An open episode ends only when:
   (a) this process announces a withdrawal; (b) the file has been absent for 60 s — the 20-second shutdown deadline plus the supervisor's 3 s kill plus the 25 s
   stall slack, rounded up to one TTL — and no consumption row for this request (`requestedAt`
   and `requestedBy`) exists in the restart ledger, which both consumers write before they unlink: the request was
   withdrawn by another process or discarded by the supervisor as expired, and the log says `lease-continuity: the
   restart request (<requestedBy>) was removed without being acted on; renewals return to the lease TTL.` — a consumption
   row instead means a kill follows, so the window holds until (c) or (d); (c) a hard cap of first sight + `PLANNED_RESTART_DELIVERY_MS` (the consumers' own delivery bound: the 3-hour verify hold
   plus one hour, 4 h), whatever the file says — the capped request (by `requestedAt` and `requestedBy`) is remembered
   until the file disappears or its content changes, so its next sighting opens nothing — with the sentence `lease-continuity: a restart request (<requestedBy>) has been pending for four hours
   and no consumer acted on it; renewals return to the lease TTL.`; (d) the process exits; (e) a consumption row for this request exists, `max(60 s, the resolved shutdown deadline + 3 s + 25 s)` have passed since it (the deadline is `INSTAR_SHUTDOWN_DEADLINE_MS`,
   20 s by default), and this process is still running — the kill failed or the supervisor detached — with the sentence `lease-continuity: the restart request
   (<requestedBy>) was consumed but this process is still running; renewals return to the lease TTL.` and an `error`
   evidence row. In (b), the no-row removals are: withdrawn by another process, discarded by the supervisor as expired or
   as a repeated update restart, or unreadable to either consumer. The ledger is read once when the absence reaches 60 s by
   a new `findRestartRequestRecord(stateDir, { requestedAt, since })` over a bounded tail, matching `requestedAt` and `at ≥
   episodeOpenedAt` (an unattributed flag has no `requestedAt`, so an unattributed row — `attributed: false` — since the episode opened matches it), and the
   verdict is latched; an unreadable ledger, or a tail whose oldest row is newer than `episodeOpenedAt` (rows are about
   300 bytes and the file is capped at 256 KB with half-rotation, so the tail is sized to reach the episode's start in
   every realistic case), reads as "row present", the safe side, and the log says the cut was disclosed. A deletion by a consumer never ends it. When an episode ends by (a), (b), (c) or (e) the continuity file is deleted, the next renewal is written to a local store
   without the pending marker (so the store never holds an unmarked long-expiry record), and that one TTL renewal follows
   at once so peers' views shrink back within one cadence (a crash inside that gap, at most one cadence plus one stall, still meets the
   window expiry on peers — stated, accepted), and a late confirmation of a window renewal from the closed episode does not
   recreate the file (the file carries the episode id). `roleFollowRestart`'s one-minute check can re-request while the
   role differs from boot, so successive episodes can keep the holder pending across a multi-hour hold; the bound is per
   episode and the hourly log line (step 6) is what makes a long condition visible.
4. **The renewal and its persistence while pending.** Every renewal signed while an episode is open carries the window —
   the renew tick's, `confirmHoldOnPeerPull`'s, and the boot renewal of section 2 — and a boot renewal that confirms with
   an episode already open is followed at once by a window renewal, so a request that became visible while this machine
   was still confirming its reclaim is covered within one broadcast, not one cadence. `renew()` signs with `expiresAt =
   now + window` and broadcasts as every renewal does (deadline 8 s). On a tunnel transport the renew tick runs every `min(renewIntervalMs, 10 s)` while
   pending (four extra broadcasts a minute, only while pending; the timer and its unconfirmed-retry arm follow the pending cadence,
   re-armed when an episode opens and restored when it ends), so the last confirmed renewal is at most one cadence plus one
   stall old when the kill comes; on a git-only mesh (no tunnel) the cadence stays `renewIntervalMs`, because each renewal
   there is a synchronous git push and the push is its confirmation. `confirmHoldOnPeerPull`, which re-signs the own lease
   on a no-shared-medium store, uses the window while pending so it cannot shorten the extension. The holder's monotonic
   self-fence is unchanged: `holdsLease()` still needs a confirmed renewal within one TTL, so the holder gains nothing from
   its long expiry; only peers wait longer, and only for a holder that was asked to restart. Each signed window renewal is
   written, at signing and before its broadcast settles, to the continuity file: `{ v: 1, episodeId, lease: <the signed
   LeaseRecord>, meta: { requestedBy, reason, requestedAt, episodeOpenedAt, renewedAt, windowMs, confirmed, exitedAt:
   null }, signature }`, where `signature` is this machine's lease key over `['lease-continuity-v1', lease.nonce,
   canonical(meta)]`; `confirmed` flips to true when that renewal confirms (on time or late), and a newer renewal replaces
   the file. `requestedBy` and `reason` pass through `restartRequestAttribution`'s existing
   `cleanString`, exported in this change (200 characters, one line — the supervisor's own bound on the `reason` it logs) before the file, the log and the evidence, because a hand-written flag
   controls them. Mode 0600, atomic rename. On a `LocalLeaseStore` the window renewal is also written to the store
   (`refresh`: one local file write; the file and the store then hold the same record) together with the pending marker
   `pendingEpisodeId`, so a lost continuity file still leaves a window lease on disk and the marker, not a timestamp shape,
   says so; on a `GitLeaseStore` with a tunnel nothing is written to the store (no uncommitted
   registry change), the continuity file is the only local copy, and losing it means the lapsed path at boot — the lead
   lost once, as today, named in Mixed versions. A `casWrite` that advances the store's epoch during an open episode
   rewrites the continuity file at once so it is never stale for a cadence; `relinquish()` deletes it, so a conceded epoch
   is never renewed from the file at the next boot. The signature is not a defence against an attacker on this disk (who
   could read the key); its adversary is corruption and stray tooling, which `verifyLease` and the structural checks
   mostly cover already — it is kept because it is cheap and makes a damaged file fail closed with a reason.
5. **At exit, bookkeeping only.** The shutdown handler's first synchronous action, above its first `await`, stamps
   `exitedAt` into the continuity file if it names a lease this process confirmed (one write, under 5 ms). If the process
   is killed first the stamp is missing and boot uses the later of `renewedAt` and the consumption row's time for this
   request (matched by `requestedAt`; the row is written before the unlink, so it understates the gap by a few seconds
   where `renewedAt` overstates it by at most one cadence plus one stall). Nothing else about shutdown changes.
6. **Logging, evidence and the read surface.** The first pending renewal of an episode logs `lease-continuity: a restart
   is pending (<requestedBy>: <reason>); epoch N is being renewed with a <window> ms expiry so the lead survives the
   restart.` and records feature evidence `multiMachine.takeoverReadyPool` kind `fired`, reason `pending restart renewal
   extended the lease`, with `{ epoch, windowMs, requestedBy }`. An open episode writes one `held` evidence row per episode
   and one log line per hour, each carrying `pendingForMs` and the consumers' hold verdict (`plannedRestartVerifyState`:
   whether a hold applies, until when, and from which source), so the next long gap between a request and its consumption
   is recorded, not inferred. `GET /health`'s authed `multiMachine.syncStatus` gains `pendingRestart: { requestedBy, since,
   windowMs } | null`, read from the subscriber's in-memory episode state (never a file; `getSyncStatus()` runs on hot
   paths) and machine-local like the rest of `syncStatus` (`requestedBy` is caller text, already bounded); the dashboard is
   unchanged, and the log is the second source. No owner notice: nothing is theirs to decide (Near-Silent), and the posture is readable.

**The window.** Resolved at each pending renewal, on this machine, from live config:

- **Margin** = `pendingRenewIntervalMs + askDeadlineMs (10 s) + broadcastDeadlineMs (8 s) + stallSlackMs (25 s)`, where the
  first term is the effective pending cadence on this store (10 s on a tunnel transport, `renewIntervalMs` on a git-only
  mesh) —
  the time between the last renewal and the kill, the boot ask, the boot renewal's confirmation, and a stalled event
  loop (11 to 21 s stalls were measured on the Laptop; 25 s is above the observed maximum; a stall of the TTL class or
  longer loses the lease today whatever the window says — it costs one takeover, never a second holder); 53 s on Echo.
- **Base** = `slowestOfLastTwentyBoots + margin` when at least one boot has been measured (section 2), else `3 × TTL +
  margin` (233 s on Echo). The unmeasured base covers a 180 s boot; the Laptop's 4-minute boot exceeds it, so a Laptop
  holding the lead is taken over once on its first planned restart and measured, after which its window covers it. An
  explicit `multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.windowMs` replaces the base.
- **Floor** = `TTL + margin`: an expiry shorter than that is the lease's own life.
- **Ceiling** = the smallest of the caps peers enforce with their own settings, resolved with the parent's defaults
  assumed for peers because config is per machine and R3's posture rows are not built: `TTL × min(own
  nonRenewalMissedObservations, 6) − broadcastDeadlineMs` (the stale-holder takeover threshold, which R3 makes resolve on
  with the default 6 on eligible peers; the subtraction covers the fold delay before the peer's watermark advances; 352 s
  on Echo), `failoverThresholdMs − broadcastDeadlineMs` (the presumed-dead threshold, from `failoverTimeoutMinutes`, 15 min
  default), and R1's unsigned-answer ceiling (`UNSIGNED_WINDOW_CEILING_MS`, 10 minutes today, moving with the parent spec
  if it moves). A peer configured below these assumptions takes over earlier; that is a legitimate takeover the returning
  machine adopts, never a second holder.
- Samples run from exit to confirmation, so slow-answering peers inflate them and grow the window toward its ceiling —
  a feedback loop the ceiling bounds and the "creeping boot" log line shows. One clamped outlier sample (an OS update boot,
  or a wall clock that stepped forward across a boot, read-clamped to R1's ceiling) pins the window at the ceiling for
  twenty boots; `windowMs` is the remedy and the hourly log line shows it. A
  clamped value is logged once per episode with the bound that applied.

**Cost while pending, stated plainly.** A request can wait hours behind a Local Verify hold. For that whole time the
holder's lease is `window` ahead instead of one TTL, so a *crash* of the holder in that period delays the peers' takeover
by up to `window − TTL` (about 170 s on Echo with no measured boots; up to 290 s at the Echo ceiling), and the owner's
five-minute reply bound (takeover-ready-pool R5: W plus the pool's ~125 s claim-to-reply) is then exceeded by the same
amount. This is accepted for the pending state only: the machine has been asked to restart, each episode is bounded by the
consumers' delivery bound, R5's W budget cannot cover the Studio's measured boot (its formula gives 130 s on Echo against a
150 s boot), and the alternative — a window short enough for the bound — recreates the loop this spec exists to end.
Outside a pending episode nothing changes: the TTL stays 60 s and takeover timing is today's. The pending posture is
readable on `/health` and recorded hourly; the owner is not notified (Near-Silent: nothing is theirs to decide).

### 2. At boot, a window lease is confirmed with a peer before it is held

Boot claim safety's rule 1 speaks of a *lapsed* own lease. A window lease is a *held* lease; renewing it is not a claim,
but holding it must not rest on a local file alone. Rule 1b applies whenever the own record at construction is a window
lease — whatever the switches say, because the persisted window can outlive a rollback and the fence is the boot side's
floor. An ordinary own record that happens to be unexpired without a pending marker (a restart within one TTL of acquiring, or
within one TTL of a confirmed boot renewal) is not a window lease and takes today's path — which holds it on local state
for up to one TTL, a pre-existing gap R1 does not cover, named in §4 and filed — so the fleet's boot is byte-for-byte
today's; with the switch off the renewal side is byte-for-byte today's and the boot side keeps this rule for exactly as
long as a window lease is on disk. The 2026-06-02 lesson (a role reconcile must never demote on local state alone) is
engaged knowingly and in the safe direction: rule 1b keeps the machine *standby* on local state until a peer confirms —
the posture R1's hold already has — and the E2E asserts that no subsystem write fails read-only during the wait.

**The fold.** The constructor reads the store's own record and the continuity file; on a git store the verdict is
re-judged after `primeFromDurable` fetches the registry, which runs synchronously before the pull loop starts — an ordering
the build keeps when it moves the pull loop ahead of the branches. The file's lease is folded into the own record — and seeds the
nonce floor `nextNonce` reads, under the same one-year-ahead cap the store seed has (a file nonce above it is refused), so
a backward wall-clock step across the boot cannot sign a nonce peers reject as replay — only when: the file's lease
verifies (`verifyLease`), names this machine, is at the store's epoch, and carries a nonce higher than the store's or equal
with a byte-identical record (the local store holds the same renewal; a git store without a tunnel does too); the store's
own record verifies (a `LocalLeaseStore` record force-expired by a relinquish has its `expiresAt` rewritten under the
signature and fails here; the git store's relinquish is a no-op on most pools, which is why `relinquish()` also deletes the
file); the file's `expiresAt` has not passed; and the meta signature over `lease.nonce` verifies. A file that fails a check
is measured if it can be (the expired case: the boot outran the window, which is exactly the sample that grows it), then
deleted and logged (`lease-continuity: <reason in a sentence>; the record is discarded.`); the lease is judged by its own
signature and expiry alone.

1. **The fence is "never confirmed", not zero.** `lastRenewOkMonoMs` becomes `number | null`; the constructor leaves it
   `null` when rule 1b applies (it primes it, as today, otherwise). `holdsLease()` is false while null; `renew()`'s
   self-suspend branch does not fire while null — an unconfirmed boot renewal returns false (except the survivor hold of step 5) and logs once per boot
   `lease-continuity: the renewal of epoch N after this machine's planned restart has not been confirmed by a peer yet;
   this machine stays standby until it is.` — no `self-suspend` line, no `onSelfSuspend`, no `splitBrainState:
   self-suspended`; `msSinceConfirmedRenewal()` returns `null` while null, the renew-skip line says "not yet confirmed
   after this machine's planned restart" instead of "lapsed … NaN ms ago", and the unconfirmed-retry arm does not arm —
   each reader branches on `null` explicitly, never on coercion. So `reconcileRoleToLease('lease-init')` reads standby, the
   poll intent stays "do not poll", and nothing is served on the strength of the file. Grace and suspend logic are
   unchanged once the fence is primed. (A zero sentinel would pass the fence whenever `process.hrtime` reads under one TTL
   — a launchd start right after an OS boot.)
2. **Pull loop first; the pull loop is the ask.** Whenever rule 1b applies, `initializeLease` starts the lease pull loop
   before any branch (today only the `bootClaimSafety` branch does) and holds the tick guard around its acquire as that
   branch does, so the pull tick's nudge cannot run a second renewal alongside it. Rule 1b makes no ask of its own: it
   evaluates the latest *evaluable round* (Terms) when a probe lands and at the round's 10-second deadline, and once more
   from the pull tick's `finally` so a pull that throws still nudges; peers dark at boot simply have no outcome in that
   round, and at most two rounds are ever in flight.
3. **First evaluable round: measure or discard, in every branch.** On the first evaluable round after construction — before and
   independently of the acquire, so the observe-only and defer-to-preferred branches of `initializeLease` reach it too —
   the superseded check of step 4 runs once: a window lease the peers have moved past is measured, discarded and logged
   there, so the Mini booting with a superseded window lease while the Studio holds N+1 still records its boot sample. A
   machine that boots observe-only with a window lease it will never renew relinquishes it with the signed tombstone
   (`relinquishAndBroadcast`), so peers do not defer to it for the window.
4. **Superseded.** If the view shows an epoch strictly newer than N, or `observedByPeer()` shows a live lease at epoch N
   held by another machine (the same-epoch case `effectiveView` masks), the normal rules apply (R1 rules 2 to 4 when on,
   then the lapsed-lease path). The boot is measured (step 7), the continuity file is cleared with `lease-continuity: the
   lease this machine held before its planned restart was superseded by epoch M, now held by <machine>; this machine adopts
   it and discards its continuity record.`, and feature evidence `fired`, reason `taken over during a planned-restart
   boot`, is recorded with `{ epoch, newEpoch, holder, bootMs, windowMs, requestedBy }` — a boot longer than the window is
   R5's designed outcome, not an error. (A live same-epoch lease naming a third machine is `held-by-live-peer`: stand
   down; an expired one is hearsay and ignored.)
5. **Renewal.** Otherwise, if the own lease is still unexpired at this instant (re-checked immediately before signing; a
   pull that straddled the expiry routes to the lapsed path), the machine renews epoch N (TTL expiry, or the window if an episode is already open — §1 step 4; fresh nonce,
   broadcast) **if** at least one live peer gave a qualifying answer in the latest evaluable round. **With no live peer** —
   every known peer presumed dead or settled silent by R1's own test — the machine does not wait the window: it renews
   epoch N as a **survivor hold**, on exactly the evidence R1 would accept a moment later for a claim of N+1 (three silent
   probes over 45 s from every known peer), and that renewal primes the fence and ends the hold — a new branch in `renew()`: fence `null`, rule 1b's live set empty on
   the live probe history at the moment the broadcast returns unconfirmed ⇒ `installRenewal` and `markRenewOk`, logged
   `lease-continuity: every known peer (<names>) has been silent for <span>; this machine keeps its own epoch N as a
   survivor hold, as boot claim safety would let it renew its own epoch now.` No more authority is granted than R1 grants
   today, and in the non-preferred case less (R1 ends its hold on the preferred machine's silence alone; this needs every
   known peer): once R1's hold ends with an unexpired own lease, today's code renews it with no ask. The epoch does not
   climb at boot and `bootAwake` reads true, so the survivor's role restart *at boot* does not recur. What follows is
   today's rule for a holder whose peers are all dark: the next renewals are ordinary, unconfirmed, and under the
   monotonic self-fence the holder self-suspends one TTL later and re-acquires at the next heartbeat (the existing epoch
   climb, the solo-captain hold where its condition holds, R2's job to end); after that first TTL the self-suspend demotes the role on the next reconcile, and `reconcileRole` may request a role
   restart once the 15-minute stamp allows — today's sole-survivor behaviour, the §4 residual, R2's job to end. The solo-captain hold's
   presumed-gone leg is not consulted (under the default liveness derivation no peer is presumed dead inside a boot, so that
   leg could never fire here). During a cut this is R2's conditional guarantee again: the other side may hold N+1 until the
   cut heals and the higher epoch wins; keeping N rather than claiming N+1 makes that reconciliation a clean higher-epoch
   win instead of a same-epoch contest. Where the liveness derivation is disabled, "live peer" means every known peer not
   settled silent, so a stale registry can never make the branch renew unasked. **Partitions keep R2's conditional
   guarantee.** If the returning machine reaches peer B (no newer epoch) while peer A, unreachable from both, holds N+1,
   the returning machine renews N and both sides serve until the cut heals; then the higher epoch wins
   (`higherEpochEvidence`, `peerLeaseSupersedes`) and the N side demotes. That is the posture takeover-ready-pool R2
   already accepts for the pool, with Telegram's 409 tie-break resolving it once R2 is built; requiring every peer's answer
   instead would leave the pool leaderless for the window whenever one peer is dark at boot (a closed laptop) and
   re-create a hand-back round. Peers that did not answer are named in the log line.
6. **Confirmed means confirmed.** The hold ends only when the boot renewal is *confirmed* as defined in Terms (or is the survivor hold of step 5). `renew()` returning true inside grace (ACT-1308) does not count — a first renewal in a
   process has no earlier confirmation to be in grace of. On confirmation the fence is primed, the confirmed TTL-expiry
   renewal is written to a local lease store without the pending marker (`refresh`; on a git store nothing), and the
   continuity file is deleted; the store then holds an ordinary unexpired renewal for at most one TTL, and a crash inside
   that minute takes today's path (renew at once), as a restart within a TTL of an acquisition does today — the foundation
   gap named in §4; the late-confirmation path does the same, and a confirmation with an episode still open broadcasts a
   window renewal at once (section 1 step 4).
7. **Verdict, measurement and cleanup.** `initializeLease` awaits the first verdict — `confirmed`, `superseded` or
   `timeout` — for up to 120 s whatever the window's remaining time (against dark peers the probes land only when their dials time
   out: the third silent probe lands at about 5 s start + 2 × (20 s guard + 5 s re-arm) + 30 s dial ≈ 85–89 s, the
   verdict's broadcast returns 8 s later ≈ 97 s, and one 25 s stall slack brings it to about 122 s, rounded to 120 s; a
   second stall takes the `timeout` path, one extra planned restart; and a wait that
   ended at the window's expiry would leave a slow boot standby with two probes recorded and re-enter the loop; if the
   window expires during the wait the own lease is lapsed and the lapsed path's own R1 verdict — a claim of N+1 after the
   silence span, or waiting on an answering peer under rule 2 — is the verdict this wait ends on), extended while any known peer is
   still `answering-unsigned` (a server booting, as in a pool-wide update) up to the remaining window and capped so that
   this wait plus R1's unsigned-answer window never exceeds R1's ceiling (a forged marker at a peer's address can delay
   the lapsed path, as it can delay R1 today, but not twice), without holding the tick guard between evaluations. A boot that follows a late promotion (the `timeout` case below; the episode that opens for that role-change request on a
   machine whose `bootAwake` was false records `afterLatePromotion: true` in the continuity file's `meta`, which is the
   trigger) waits the full remaining window, so that second boot always ends in a verdict: a peer answers, every peer settles silent, or the window lapses into R1's own verdict. While the own
   lease is unexpired nobody else can hold, so the pool loses no *holder* by waiting; what it loses is this machine's
   ingress for boot plus the wait (the poll intent reads "do not poll" and peers defer), stated here beside the crash cost
   — the all-peers-silent case pays R1's 45 s, not the window. The boot sample is taken at the verdict, whichever it is (confirmed, superseded, survivor hold, or the lapsed path's
   claim), so a slow dark-pool boot's next window covers the verdict time too. What waits is the rest of this machine's boot
   — nothing answers on its port but the boot beacon's 503 — under the lifeline's startup tolerance (600 s grace, extended by its
   ceiling multiplier for a `starting` beacon; the 300 s maintenance wait governs alerting only: a Laptop's 240 s boot plus
   the wait logs a warning, nothing more). On `confirmed`: the R1 boot hold ends if it was active; the log says
   `lease-continuity: this machine renewed its own epoch N after its planned restart (<requestedBy>; boot <ms> ms; <k>
   peers asked, <j> answered, <names> silent); it keeps the lead.`; the continuity file is consumed; the boot time `now −
   max(exitedAt ?? renewedAt, consumptionAt)` (for an unattributed flag `renewedAt` alone) is appended to `state/restart-budget.json` (`{ samples: [{ at, ms, outcome
   }] }`, last twenty, mode 0600; a negative value is `unknown` and not added; a sample above the previous slowest is
   logged so a creeping boot is reviewed, not absorbed); feature evidence `fired`, reason `kept the lead through a planned
   restart`, with `{ epoch, bootMs, windowMs, requestedBy, confirmedAtExit, peersAsked, peersAnswered, outcome, basis }`, where
   `basis` is `peer-confirmed` or `survivor-hold` (only `peer-confirmed` rows count toward graduation) and `outcome` is
   `planned` when `exitedAt` was stamped and `exit-unstamped` when it was not (a kill before the stamp, or a
   crash during an open episode — the evidence says only what it knows). `restartBudgetMs()` returns the slowest sample
   below twenty and the p95 from twenty — R5's shape — and is the seam R1's `peerRestartBudgetMs` and R5's posture rows will read — that seam is unwired today (no provider in
   `src/`), so until R5 publishes posture rows `restart-budget.json` sets only this machine's own window. On `timeout`: the boot continues as standby and the pull-tick nudge keeps evaluating until the window ends; a
   reclaim that confirms after `bootAwake` was read promotes the role, and `roleFollowRestart` then asks for one more
   planned restart — at once when the consumed request was an update or older than 15 minutes, otherwise after the stamp
   ages, during which this machine leads with no scheduler — which again carries the window: one extra boot, and that boot waits the full remaining window (above), so a peer that
   answers only after the first boot's wait cannot repeat the pattern; the measurement for a two-boot sequence spans both
   boots (no renewal happened between them) and is logged as such rather than as a creeping boot, and the boot-ledger
   sentence "the lead was not kept" fires only when no window lease was found at construction.

**Why the lease, not the file, is the authority.** `expiresAt` is inside the holder's signature; a tampered lease fails
`verifyLease` in rule 1b and `holdsValidLease` everywhere else. Peers never read the file; they see only renewals.
`restart-budget.json` is unsigned and read-bounded: every sample is clamped to `[0, UNSIGNED_WINDOW_CEILING_MS]` on read (the constant is exported from `BootClaimHold` for it;
a non-finite sample is discarded, and a non-finite resolved window or `windowMs` falls back to the unmeasured base, logged
once),
and the window it feeds is capped by the peer thresholds whatever it says.

### 3. What the peers do (unchanged code, stated because the invariant depends on it)

While the pending renewal's expiry stands, a peer's view names the restarting machine as holder of an unexpired epoch N:

- `canAcquire` answers `held-by-live-peer`; nobody claims. `isHolderHealthy` is true, so a non-preferred peer keeps
  deferring to a preferred holder, and a preferred peer does not claim from a non-preferred holder either. The behaviour
  is the same whichever machine is preferred.
- `staleHolderTakeover` and the presumed-dead rule cannot fire inside the window on a peer at or above the assumed
  thresholds: the nonce watermark advanced at the last pending renewal and the window is capped under both.
- `LeaseHandbackReconciler` evaluates on the holder only; the holder is down.
- A peer that did not receive the extension (unreachable at the time, or git-only and not yet fetched) still holds the
  old expiry and may take over after the TTL, legitimately. The returning machine learns the newer epoch in its pulls and adopts it (section 2 step 4). The converse case — a peer that
  claimed N+1 during the boot and then went dark before anyone else saw it, while the returning machine held N as a
  survivor and the peer later returns with an expired N+1 above the live N — resolves as one takeover and one hand-back
  (R2's posture), never a split; today's code lets such a returning record acquire over a live lower-epoch holder, which is
  filed as foundation gap (5) with a card. A peer that itself restarted during the holder's boot forgets its nonce watermark; where a
  third live peer exists its first pull re-serves that peer's view carrying the window renewal, so the window is
  re-learned; in a two-machine pool, or a pool-wide update that restarts every machine within minutes, nobody re-serves
  and R1 alone decides (its unsigned-answer window on a named tunnel, its silence span otherwise) — R1's accepted outcome.
- Peers judge `expiresAt` on their own wall clocks, as they judge every lease: a peer whose clock runs minutes ahead
  shortens the window by that much and may take over early (adopted on return), one behind lengthens it, bounded by the
  skew-immune stale-holder watermark. The window triples that exposure relative to the TTL; NTP-disciplined clocks are
  assumed, as the lease already assumes.
- A machine that dies for good after a pending renewal holds the pool for at most the window (233 s by default on Echo,
  352 s at the Echo ceiling), then the normal expired-lease takeover runs.

### 4. Switch, gates and what is not changed

`multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.enabled` rides the development-agent gate like
`bootClaimSafety` (live on a development agent, dark on the fleet unless set); `takeoverReadyPool.enabled: false` is the
rollback for the whole project. It governs the renewal side (section 1) and is read live on every renewal; the boot side
(section 2) is keyed on the disk state as explained there. It requires `resilientRenew` resolved on: without the dedicated
renew timer the only renewal is the 2-minute heartbeat, so pending renewals could not exist; the switch then logs once and
stays inert. `windowMs` is the only other setting; no default is seeded (`ConfigDefaults` stays unseeded for the
`takeoverReadyPool` block, as today). The ask deadline is clamped to `tickWatchdog.awaitTimeoutMs` where an operator set
that below 10 s, and the clamp is logged once per boot with both values, because under it no tunnel answer can qualify.

`roleFollowRestart`'s request is unchanged (R5 removes it later; until then it is the planned restart this spec keeps the
lead through). **Residual, owned by R5:** an *unplanned* holder restart with no episode open (a crash, a power loss, a
`launchctl kickstart -k`, a kill), and a sole survivor on a tunnel transport, still lapse the lease, boot through R1's hold
as a standby, re-acquire after the hold and then restart once more for the role change — two boots. That is today's
behaviour and R5 is its fix; this spec names it so it is not mistaken for a regression, and the release note and the
agent-awareness entry say which restarts are covered: anything that writes the request (the app and dashboard restart,
`POST /server/restart`, an update, a role change, the Telegram fix command) and nothing that bypasses it. The lifeline's
Telegram poll and the standby's behaviour are unchanged; during a planned restart the poll pauses for the boot plus the
confirmation wait, as the lifeline follows the poll intent rule 1b holds at "do not poll".

**Supervision tier.** Tier 0: lease-protocol decisions over enumerable inputs, no policy decision; the brakes are the
ones stated (poll backoff on error, cadence bounded by the episode, evaluation bounded by the window).

**Five foundation gaps this spec builds around, filed rather than absorbed.** (1) The supervisor kills the server 3
seconds after its interrupt while the server's own teardown is designed for a 20-second deadline and saves session resume
state inside it; the in-process watcher gives the full deadline; every supervisor-driven restart cuts that teardown — and
a consumer-side handshake (ask the running holder for one bounded extension before unlinking, proceed on timeout) is the
supervisor-side counterpart of what this spec gives the in-process watcher. (2) Two consumers race for one request file;
the watcher's own header says it is for foreground mode only, yet it is started in every mode, and the latch, the 8-second
await and the ledger check in this spec exist to absorb that redundancy — one consumer per request is the fix. (3) The
role-restart spec's condition no longer matches the shipped code (PR #2783). (4) `LeaseCoordinator`'s constructor primes
the fence for every boot, so an own record unexpired within one TTL of an acquisition is held on local state for up to one
TTL with no ask — the gap R1 leaves open for the ordinary case and rule 1b closes only for window leases. (5) A returning machine whose own expired record is above a live
peer's lease acquires over that live holder instead of adopting it (section 3). All five, and the boot-order measurement, are filed through `POST /feedback` (the upstream record) and each gets a Work Board card (`POST /work-board/cards` with the post-mortem project's `projectKey` and a `doneWhen` item
naming the fix) under the post-mortem project (topic 145840) so it has an owner and a cadence rather than a receipt in a queue that is dark on this
agent; the completion list cites the card ids; (3) is also corrected in the role-restart spec's text in this change.

**Where the owner learns of the pending cost.** The deviation from the post-mortem's five-minute bound while a restart is
pending is the agent's decision under Approval Only Where Required, on the basis of the parent spec's approval, and is
recorded on CMT-2118 with the live proof; the failover notice (takeover-ready-pool R10, when built) gains the clause "a
restart was waiting, so the hand-over took longer" when a restart was pending at the loss, and until then the restart
ledger joined to the lease epochs is the record.

**Mixed versions.** A peer without this change folds the longer-expiry renewal as any renewal (`acceptTunnelLease` has no
clamp on `expiresAt`). A *holder* without this change still loops, and the update restart that installs this change runs
the old code on the holder; no mechanism orders updates across the pool, so one more hand-back round during the rollout is
accepted (bounded by the 15-minute stamp). A *binary* rollback within an open window, on either store, boots with the window lease on disk (the old code ignores the
pending marker) and the old code's unconditional renewal: pre-R1 behaviour on a local file for up to the window, once;
named in the release note, and a rollback that wants to keep the boot fence has the running holder persist an ordinary
TTL renewal first (ending the episode does that). On a tunnel holder with a git store the continuity file is the only local copy of the
window renewal; losing it means the lapsed path and the lead lost once, as today.

**Removing the stopgap.** When this change is live on the Studio, `bootClaimSafety.enabled: false` (CMT-2118) is removed
by re-enabling the switch there. The build run records on CMT-2118 (`PATCH /commitments/CMT-2118`, topic 145840) the two
steps and the check that closes it — the first `kept the lead through a planned restart` evidence row on the Studio with
`bootClaimSafety` on and the lease epoch unchanged across that restart in the ledger — and the run's completion list
carries that update; the config edit itself is outside this PR.

## Frontloaded Decisions

1. **The extension is the holder's own renewal with a longer expiry, made while a request is pending.** Peers verify and
   fold it with code they already run; a mixed pool degrades to today's behaviour on the unflagged side, never to a protocol
   error.
2. **Nothing depends on the shutdown.** The supervisor's 3-second kill and its deletion of the request files make any
   exit-time step unreliable; exit does bookkeeping only.
3. **Writers announce before the file is visible through one shared signal; the three hot writers and the in-process
   consumer await confirmation.** Out-of-process writers are covered by a 2-second poll and the residual race is stated.
4. **The episode is latched by one state-based rule**: it ends only on withdrawal, on a file absent for 60 s with no consumption recorded, on a consumption row 60 s old with
   this process still alive, on the four-hour cap, or at exit — never on a consumer's deletion; ending it deletes the
   continuity file and clears the store's pending marker.
5. **The continuity file carries the lease; the lease is the authority.** A missing file never costs the lead on a local
   store; on a git store with a tunnel it costs one lapsed boot, as today.
6. **A window lease at boot is confirmed with a live peer before it is held, with a "never confirmed" fence**, keyed on the
   disk state so a rollback cannot reopen the hole; an ordinary unexpired acquisition is not a window lease.
7. **Partitions keep R2's conditional guarantee.**
8. **The window is measured; its ceiling is what peers enforce, not the five-minute bound.** The bound is exceeded only
   while a restart is pending and only if the holder then crashes; stated and accepted as the agent's decision under
   Approval Only Where Required on the parent's approval, recorded on CMT-2118; the posture is readable on `/health`.
9. **Pending renewals run every 10 s on a tunnel transport**; a git store keeps its cadence because its renewal is a push.
10. **The boot waits up to 120 s for its verdict, longer while a peer is still booting**, because nobody else can hold
    while the own lease is unexpired; a later verdict costs one extra planned restart, named as such.
11. **A dark pool pays R1's verdict time, not the window, and boots awake**: peers settled silent by R1's test leave the live
    set, the boot wait runs to that verdict whatever the window's remaining time, and the survivor renews its own epoch as
    a survivor hold on that same evidence; its authority afterwards follows today's rules for a holder whose peers are all
    dark. A silence that is this machine's own doing is not that evidence: when every route to a peer fails on this
    machine's side before a byte leaves (no route to host, a Local Network permission), or the peer advertises nothing
    this machine may dial, the probe carries a cause and the peer stays alive-and-unknown in the live set, so no survivor
    hold is taken; the reclaim waits, keeps asking, and lapses to today's path at the window's end (the Studio's
    192.168.87.x refusal, raised by the Chief of Staff).
12. **The parent spec is amended in four places** and the role-restart spec's condition is corrected to the shipped one
    with its causal record and the trade-off that keeps the widening.
13. **Lives in the existing ladder** as a composed entry, never by widening the parent's flag path.
14. **Two new state files are registered** in `state-coherence-registry.json` and excluded from backup replication.
15. **Five foundation gaps are filed with tracked cards, not built over silently.**
16. **The cost while pending is accepted, readable on `/health`, recorded per episode and hourly, with no owner notice.**

## Decision points touched

| Decision point | Classification | Basis and justification |
|---|---|---|
| While an episode is open, a holder's renewal carries the window and is persisted; a standby or no episode changes nothing | invariant | basis: enumerable-domain; evidence: three facts decide it (holds the lease, an episode is open, switch on); the night's loop is what the rule removes |
| An episode opens on any present request and ends only on withdrawal, a file absent 60 s with no consumption row, a consumption row 60 s old with the process still alive, the four-hour cap or exit | invariant | basis: irreversible-consequence; evidence: a renewal in the seconds between the consumer's deletion and the kill would replace the window with a TTL on every peer, re-running the loop; both consumers write the ledger row before they unlink, so its absence after 60 s is the state "not consumed"; 60 s exceeds the 20 s deadline plus the 3 s kill |
| Pending cadence 10 s on a tunnel transport, the store's cadence on a git store | judgment-candidate | floor: any cadence is safe because the margin resolves from it; arbiter: none; static because the only cost it trades is broadcasts per minute, which the margin already prices |
| Window = slowest of last 20 boots + margin (3 × TTL + margin unmeasured; `windowMs` replaces the base), floor TTL + margin, ceiling min(TTL × min(own N, 6) − 8 s, failoverThreshold − 8 s, R1's ceiling) | judgment-candidate | floor: never below the lease's life, never above a threshold a peer enforces, never above R1's ceiling; arbiter: this machine's measured boots, replaced by the operator's `windowMs`; not a judgment point beyond that because the only inputs that vary are this machine's own boots, which the measurement already reads |
| Margin = pending cadence + ask deadline + broadcast deadline + stall slack (25 s), resolved live | invariant | basis: external-constraint; evidence: the three intervals are the system's own deadlines (the pending cadence, `OWN_LAPSE_PULL_DEADLINE_MS`, `broadcastDeadlineMs`) and are the only times between the last renewal and the boot renewal's confirmation; the slack is above the 21 s stall measured on the Laptop, and a stall of the TTL class costs one takeover whatever the window |
| Twenty samples, p95 from twenty; samples read-clamped to R1's ceiling | invariant | basis: external-constraint; evidence: R5's published shape for `restartBudgetMs`; R1's ceiling is the longest any window may be |
| The hot writers' and the watcher's await equals the broadcast deadline (8 s) | invariant | basis: external-constraint; evidence: the promise cannot resolve later than the broadcast settles |
| At boot a window lease — a continuity file or a store record bearing the pending marker, never a timestamp shape — is not held until a renewal confirms in this process (fence `null`), whatever the switches say; an ordinary unexpired acquisition takes today's path | invariant | basis: irreversible-consequence; evidence: serving on a local file during a partition is a second holder (the 2026-11-20 36-move incident class); a rollback with a window lease on disk would otherwise reopen it for the window |
| The fold accepts the file's lease only when both records verify, equal nonces only with identical records | invariant | basis: irreversible-consequence; evidence: a relinquished epoch renewed from a file is a contested same-epoch split; identical records are one renewal, not two |
| The boot renewal proceeds only after a qualifying (identity-verified) answer from a live peer with no newer epoch; with no live peer it is a survivor hold on R1's silence evidence | invariant | basis: irreversible-consequence; evidence: a renewal against an unseen newer epoch is a same-epoch split; a bare 2xx is what the parent's R1 refuses to count; with nobody to ask, R1's silence verdict is the only evidence there is, and it already authorises a claim of N+1 |
| A boot renewal counts only when confirmed by a medium, never in grace | invariant | basis: irreversible-consequence; evidence: ACT-1308's grace exists for a holder that already confirmed in this process |
| Rule 1b makes no ask of its own: it evaluates the pull loop's latest evaluable round (every peer answered, or 10 s after the round began), under the tick guard, nudged when a probe lands, at the deadline and from the pull tick's `finally`; at most two rounds in flight | invariant | basis: external-constraint; evidence: `withTickTimeout` abandons a slow tick without cancelling it, dark dials run to their 30 s timeout, and the deadline reuses `OWN_LAPSE_PULL_DEADLINE_MS`, one constant read in two places |
| `initializeLease` waits up to 120 s for a verdict whatever the window's remaining time, longer while a known peer answers unsigned, bounded by R1's ceiling | judgment-candidate | floor: bounded by 120 s plus the unsigned extension; the verdict set is closed (confirmed, superseded, survivor hold, or the lapsed path's R1 verdict), and after the cap the boot continues as standby and the nudge retries; arbiter: the peers' answers; evidence for 120 s: R1's third silent probe against dark peers lands at ≈ 85–89 s (5 s start + 2 × (20 s guard + 5 s re-arm) + 30 s dial), its broadcast at ≈ 97 s, plus one 25 s stall slack ≈ 122 s, rounded to 120 s, well under the 600 s startup grace for a 150 s boot; not a judgment point beyond that because waiting longer only delays this machine's own boot |
| A known peer leaves the live set when settled silent by R1's `silentProbes`/`silentSpanMs` (3 / 45 s default); with no live peer the window lease is renewed as a survivor hold | judgment-candidate (inherited from R1) | floor: exclusion only moves the boot toward acting on R1's own evidence, never past it — the survivor hold grants exactly what R1 would grant as a claim of N+1 at that moment; arbiter: the probes, R1's settings, no second knob |
| The 2-second request poll while holding | judgment-candidate | floor: a lost race is today's behaviour once, logged; one stat per tick, backing off on filesystem errors; arbiter: none; static because the consumers' 10 s polls set the only useful cadence |
| The continuity file is single-use and discarded when stale, superseded or invalid, after measurement; a superseded boot is `fired`, not `error` | invariant | basis: enumerable-domain; evidence: the checks are each named in a log sentence; a boot longer than the window is R5's designed outcome |
| One `held` evidence row per episode; the hourly log line is log-only | invariant | basis: external-constraint; evidence: the ladder's harm ratio divides by every row of the feature, so an hourly row would let the feature's own waiting flatter its metric; the log cadence has no external effect |

## Multi-machine posture

- **The extended renewal:** unified. It travels on the existing lease channel (broadcast, served to every pull) and, on a
  git-only mesh, the lease store's push, the same replication every renewal has.
- **`state/lease-continuity.json`:** machine-local by design — this hardware's own exit and restart timing and the one
  renewal its own next process will reclaim; the record is meaningless on any other machine (it names this one and is
  refused elsewhere), and the derived value peers need, `restartBudgetMs`, is published unified by R5's posture rows and
  read by R1's `peerRestartBudgetMs` seam. Excluded from backup replication.
  - machine-local-justification: hardware-bound-resource
- **`state/restart-budget.json`:** machine-local by design — this hardware's own boot durations; a copy on another machine
  would set that machine's window from foreign boots. Excluded from backup replication.
  - machine-local-justification: hardware-bound-resource
- **`pendingRestart` on `/health`:** machine-local by design, like the rest of `syncStatus` (this process's in-memory
  episode state on the authed branch; no pool merge of `syncStatus` exists and none is built here).
  - machine-local-justification: hardware-bound-resource
- Notices: none. Nothing is sent to the owner; `/health`, the log lines and feature evidence are the record.

## Verify the state, not its symbol

| Symbol read | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|
| an announce from a writer, or `restart-requested.json` present | this server has been asked to restart and a consumer will act | the announce comes from the writer itself; the watcher acts on any present file; the ledger row written before the unlink says whether a disappearance was a consumption; the 4-hour cap bounds a file no consumer handles | unreadable file ⇒ no episode ⇒ TTL renewal (today); an announce with no file one poll after its promise settled ⇒ episode closed |
| `holdsLease()` at renewal | this machine is the confirmed holder | the monotonic self-fence and `higherEpochEvidence` inside it | false ⇒ no renewal at all (today) |
| a window lease on disk at construction | the lease may still be ours | `verifyLease` on both records; then a qualifying identity-verified answer from a live peer with no newer epoch, or a medium's confirmation, or the survivor hold of §2 step 5 on R1's settled-silent evidence | no qualifying answer ⇒ not held; after the window ⇒ lapsed path |
| the continuity file's two signatures, holder, epoch, nonce, `expiresAt` | this process's predecessor renewed epoch N for a pending restart | the lease's own signature and nonce, judged independently | any check fails ⇒ measured if possible, discarded, logged; the lease is judged alone |
| `confirmed` in the file | a peer acknowledged epoch N for that renewal | the boot pull re-checks the peers' views directly, so this field is informational | absent ⇒ false |
| `now − max(exitedAt ?? renewedAt, consumptionAt)` | this boot's duration | bounded below by 0 and above by R1's ceiling on read; `renewedAt` overstates by ≤ one cadence plus one stall, the ledger row understates by the consumer-to-kill seconds | negative ⇒ `unknown`, not added |
| `restart-budget.json` samples | this machine's recent boots | unsigned; clamped on read; the window it feeds is capped by thresholds peers enforce | unreadable ⇒ the unmeasured base |
| a peer settled silent (R1's `silentProbes` over `silentSpanMs`) | that peer cannot be holding or claiming | the same evidence R1 accepts before letting this machine claim N+1; the survivor hold grants no more | fewer probes ⇒ the peer stays live and the wait continues |

## Testing

**Unit** (`tests/unit/LeaseContinuity.test.ts`, `tests/unit/restartRequestSignal.test.ts`,
`tests/unit/LeaseCoordinator-plannedRestartContinuity.test.ts`): window resolution at every boundary (floor, unmeasured
base, measured + margin, `windowMs`, each cap, a clamped value logged once, a read-clamped outlier); margin from config
(TTL 60 and 120 s); the episode rule (announce, sighting, withdrawal ends it and deletes the file, a consumer's deletion
with a ledger row keeps it open, a deletion with no row ends it after 60 s, the four-hour cap, an expired request present
opens one, an announce with no file closes one poll after the promise settled and not before — the hot writer's file
appearing at 7.9 s is never closed); the signal module (every write site of the request in `src/`, found by a ratchet over
the source that separates readers from writers, is classified in-process (announces before publishing; the three hot
writers and every consumer of their returns await) or out-of-process (listed); the promise resolves at once with no
subscriber or no renewal; coalescing; subscriber errors never reach the writer; `reconcileRole` single-flight with a
concurrent call); continuity file sign/verify and fold (good, wrong holder, wrong epoch, lower nonce, equal nonce identical
on a local store, equal nonce different record refused, past `expiresAt`, tampered meta, tampered lease, foreign key, a
force-expired local record refuses the fold, `relinquish()` deletes the file; measured then discarded when expired; the
folded nonce seeds `nextNonce` under the one-year cap so a backward clock step still signs above it); restart-budget cap,
read clamp and `restartBudgetMs()` below and at twenty; `msSinceConfirmedRenewal()` null handling with explicit branches.
The coordinator tests use real Ed25519 leases and the real `LocalLeaseStore` on temp files with a scripted transport and
an injected monotonic clock starting at 5 000 ms (the zero-sentinel trap), and include **the night's loop as a test**: the
Studio holds N, a role-change request is announced, its renewals carry the window at the 10 s cadence and are persisted, it
"exits" (a new coordinator from the same files 90 s later, TTL 60 s) — with the switch off the Mini claims N+1 at 60 s and
the Studio adopts it (the loop); with the switch on the Mini is refused `held-by-live-peer` throughout, the Studio's
`holdsLease()` is false until a qualifying answer, no `self-suspend` is logged, it renews N on the next evaluable round, and
the holder and epoch never change. Also: a renewal in the 3 s after the file is deleted keeps the window; an announce during
an in-flight TTL broadcast still lands the window renewal on the peer (nonce order); a crash with no episode (lapsed lease)
runs the R1 hold unchanged; a restart within one TTL of an ordinary acquisition (no continuity file) takes today's path; a
local-store record carrying the pending marker with under one TTL remaining and no continuity file is still a window
lease, and the same record without the marker is not; a crash during an
episode is kept and labelled `exit-unstamped`; file present but a newer epoch seen ⇒ adopt, measured, discarded; a
same-epoch other holder visible only through `observedByPeer()` ⇒ adopt; peers silent for three probes over 45 s ⇒ the
survivor hold at once (epoch unchanged, fence primed, no role restart), never the window; a two-machine pool with the other member asleep ⇒ the survivor hold at the silence verdict, `bootAwake` true, no role
restart (the epoch is asserted unchanged only through the first TTL; afterwards today's dark-peer renewal rules apply); a
150 s boot with both peers asleep ⇒ the wait outlives the window's expiry and ends on a verdict before `bootAwake` is
read, and the sample taken at the verdict covers the verdict time; a round with one dark peer and one answering
peer is evaluated at its 10 s deadline, not at the dark dial's 30 s; a crash within one TTL of a confirmed boot renewal
(marker cleared) takes today's path; a boot renewal that confirms with an episode open is followed by a window renewal
within one broadcast; a consumption row 60 s old with the process alive ends the episode; the watcher's await then
finding the file consumed by the supervisor does nothing; the partition case with a confirming peer on each side ⇒
both serve until the N+1 peer is reached, then the N side demotes; two four-minute Laptop boots ⇒ the second window
reflects the first measured boot; a tampered stored lease is treated as lapsed; switch off with a window lease on disk ⇒
rule 1b still applies; a bare 2xx from a key-less or stranger peer never qualifies and a verified `null` view does; a
non-preferred holder keeps the lead exactly as the preferred one does.

**Integration** (`tests/integration/planned-restart-lease-continuity.test.ts`): two real `HttpLeaseTransport`s over local
HTTP with the real `/api/lease` and `/api/lease/pull` receive paths: a pending renewal folds on the peer with the window
expiry; the peer's coordinator refuses to claim for the window; a restarted coordinator's pull returns the peer's verified
view (the legacy dial now carrying a request nonce) and its renewal confirms; a peer that never received the extension
takes over at the TTL and the returning machine adopts it; a request file written by another process (no announce) and
consumed 10 s later still has an extension broadcast when the 2 s poll saw it first; a healthy peer whose first delivery
takes 5 s is covered because the hot writer awaited confirmation before publishing and the supervisor consumed at once
after that.

**E2E** (`tests/e2e/planned-restart-keeps-lead-boot-path.test.ts`): the real `MultiMachineCoordinator.initializeLease` on a
development-agent config **with `bootClaimSafety` off** (the Studio's live config) and on, with a lease file and
continuity file left by a pending renewal and a peer answering with a verified view naming this machine: the pull loop
starts before the acquire, `holdsLease()` is false before the answer and true after, no subsystem write fails read-only
during the wait, the machine is `awake` when `initializeLease` returns, no claim of N+1 is made, and the log carries the
`keeps the lead` sentence; with silent peers it stays standby, logs no suspend, and the pull tick nudges rule 1b; with a
peer answering unsigned the wait extends; a Mini booting superseded through the defer-to-preferred branch still measures
and discards its file; the fleet (dark) path with today's disk shape is byte-for-byte today's. Wiring assertions: every
write site announces before publishing and the three hot writers and their return consumers await; the watcher awaits
before consuming; the shutdown handler stamps `exitedAt` above its first `await`; `MultiMachineCoordinator` subscribes the
coordinator to the signal and arms the 2-second poll; `/health` carries `pendingRestart` on its authed branch; the ladder entry is composed; the
two state files are in the registry and the backup block list.

**Evidence before the fragment.** The throwaway-pool run (test-agent-live: one real supervisor-driven restart of the
holder, lead epoch before and after, the `keeps the lead` sentence) is run before the release fragment is written and is
what its `## Evidence` cites; the Studio live proof below is the CMT-2118 close-out, not the evidence bar. The live proof
also sends one owner-channel message during the restart and records the time to its reply beside the epoch row, so the
owner's reach gap during a planned restart is measured, not inferred.

**Live proof** (after merge, recorded on CMT-2118 by this run, carried out by topic 145840): re-enable `bootClaimSafety`
on the Studio, trigger one API restart of the holder, and read: the `a restart is pending` sentence before the exit, the
`keeps the lead` sentence at boot, the Mini's log showing `held-by-live-peer` and no `acquired lease`, the epoch unchanged
across the restart in the ledger, and a Local Verify run starting on the Studio afterwards.

## Maturation plan

- **ladder:** multiMachine.takeoverReadyPool
- **dark-window:** none on Echo (a development agent; the owner approved the post-mortem fix program in topic 145840 on
  2026-11-20, which this loop's closure serves); the fleet stays on today's behaviour until the graduation criterion is met.
- **test-agent-live:** the three test tiers above on the throwaway pool used for the parent's increments, including one
  real supervisor-driven restart of the holder.
- **dev-agent-live:** Echo, with the Studio's stopgap removed; evidence rows `fired` with the three reasons above and one
  `held` per episode in `logs/feature-evidence.jsonl`; `error` only for a failed write or a file that fails verification;
  the criterion reads error rows over fired rows.
- **fleet:** the intersection of the parent's fleet eligibility (multi-machine agents whose conversations are on
  Telegram, as takeover-ready-pool limits it), the parent's own graduation, and this criterion; with the parent's R5 (no
  restart on role change) landing before or with it.
- **graduation criterion:** fourteen days on Echo with at least three planned restarts of the holder, at least one of them
  a hand-back-driven role restart (not only updates), each with `kept the lead through a planned restart` on `basis: peer-confirmed`, the lease epoch unchanged across it in
  the restart ledger, no `taken over during a planned-restart boot` for a boot inside the window
  (the returning holder's own row is how a peer acquisition inside the window shows), and error rows at or under 5 % of
  fired rows.

## Migration

None for config: the `plannedRestartLeaseContinuity` block is optional in `types.ts` and stays unseeded in
`ConfigDefaults`. The two state files are created on first use; `state/lease-continuity.json` joins the registry's
`lease-coordination-state` paths and `state/restart-budget.json` its `process-restart-coordination` paths (both machine-local, single-writer, transport none; both categories are on the frozen no-retention baseline, so a new path
needs no retention row, and both files are self-bounded: one record, and the last twenty samples), and both spellings
(`state/…`, `.instar/state/…`) join `BackupManager`'s `BLOCKED_PATH_PREFIXES`. `devGatedFeatures.ts` gains the switch's
entry with its justification and `machineCoherenceManifest.ts`'s `COHERENCE_MANIFEST_EXCLUSIONS` its row, as
`bootClaimSafety` has; `feature-ladders.json` gains a composed entry (`id` and `flag.path`
`multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity`, `title`, `disposition: composed`, `composedInto:
multiMachine.takeoverReadyPool`, `final: default-on`, `risk: sensitive`, `tracking { state: measured, plan }`, `rungs: {}`,
`aliases: []`). The existing awareness entry `server-restart-and-boot-readiness` gains one sentence in plain words (and its "restarts within about 10 seconds" line gains "after a wait of up to 8 s while
the lead is secured"): a restart asked for through the request keeps the lead on a development agent; a kill or a lifeline-level kickstart does not
until the role change no longer needs a restart (a later build); `/health`'s `pendingRestart` and the `lease-continuity:`
log sentences say which happened. A release-note fragment `upgrades/next/planned-restart-keeps-lead.md` (`<!-- bump:
patch -->`; `## What Changed`, `## What to Tell Your User`, `## Summary of New Capabilities`, and `## Evidence` because a
fix is claimed) tells the user which restarts now keep the lead, that a kill or kickstart does not until R5, that a version rollback within a window, on either store, boots as pre-R1 once, that an API restart answers up to 8 s later, and that
nothing changes for agents outside the development rung yet.

## Rollback

`multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.enabled: false` (read live at the next renewal), or
`takeoverReadyPool.enabled: false`. Renewals return to the TTL at once and an open episode's continuity file is deleted.
A window lease already on disk keeps the boot side's rule 1b for one boot (the fence, the pull, the confirmation), after
which the disk is back to today's shape; a continuity file left on disk is read, measured and deleted by that boot
whatever the switch says. A renewal already broadcast with a window expiry lapses at its `expiresAt` as any lease does.

## Open questions

*(none)*
