# Side-Effects Review — Boot claim safety (takeover-ready pool, increment 1)

**Version / slug:** `takeover-ready-pool-boot-claim-safety`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (required: lease / session-lifecycle)`

## Summary of the change

Implements R1 of `docs/specs/takeover-ready-pool.md` (fix id `boot-claim-safety`, fb-2bf6ccd0-705). Until the *boot hold* ends, a restarted machine does not claim the lease. It asks its peers first, even when a preferred machine is named. It never claims while the named preferred machine answers, and it claims only after the preferred machine (or every known peer, when none is named) has been silent on 3 probes spanning at least 45 s. Unsigned answers count only for a bounded window.

Files:
- `src/core/BootClaimHold.ts` (new, pure rules and switch resolution)
- `src/core/LeaseCoordinator.ts` (the ask-peers branch drops the `survivorMayHold`/`soloCaptainHold` conjuncts when the switch is on, then the hold check; `bootHoldActive()`, `bootClaimSafetyEnabled()`)
- `src/core/HttpLeaseTransport.ts` (per-peer probe history with signed/unsigned/silent answers, the `instarMachineMarker`)
- `src/core/MultiMachineCoordinator.ts` (pull loop starts before the boot claim; one tick nudge when the hold ends)
- `src/server/AgentServer.ts` and `src/server/BootHealthBeacon.ts` (the `X-Instar-Machine` marker on every response)
- `src/commands/server.ts` (wiring)
- `src/core/types.ts` (config)
- Registries: `devGatedFeatures.ts`, `machineCoherenceManifest.ts`, `feature-ladders.json`

Tier 2 (lease authority, fleet-reaching code). Size: about 340 LOC of source across 11 files, plus about 700 LOC of tests in 6 files. Effort: the spec converged in 6 rounds, a separate run. This build took 1 commit attempt (see the PR).

## Decision-point inventory

- `LeaseCoordinator.acquireIfEligible`: the ask-peers branch (modified) and the new boot-hold check (added). Both can only make the machine *not* claim, or delay a claim. Neither can cause a claim the normal rules would refuse: `canAcquire` still runs first and still requires a lapsed lease.
- `BootClaimHold.evaluateBootHold`: the rules (new, pure).
- `HttpLeaseTransport.classifyAnswer`: signal-only classification of a pull reply (new).
- `MultiMachineCoordinator.initializeLease` / `tickLeasePull`: ordering, plus a one-shot nudge of the existing lease tick (modified).

## 1. Over-block

The hold delays a legitimate takeover. With the preferred machine dead and unreachable, a survivor now claims after about 45–50 s of probes instead of at boot. This is the spec's intended cost, and it fits inside the takeover wait W (R5).

With the preferred machine wedged and answering unsigned 503s, the delay is the window (225 s interim) plus 45 s. This is bounded by design, so a wedged machine cannot keep the pool silent forever.

With no preferred machine named, a peer that answered unsigned (alive but starting) holds the hold for up to the window. That is the same bound.

One legitimate case pays a small new cost. A holder whose own lease lapsed transiently, then re-acquires, now does one pull (≤10 s deadline) first, because the ask-peers branch no longer needs `survivorMayHold`. The renewal path normally keeps a holder from lapsing, so this mainly affects real lapses, which is exactly when asking is right.

A preferred machine that answers signed but never claims (observe-only, held back by `acquireHeldBack`, or identity-ineligible) holds others back only for its own restart window plus the silence span, counted from its first signed answer (interim 225 s + 45 s). After that, the normal rules apply. Without this bound such a pool would have no holder for good, which the old code avoided (second-pass finding 1).

With no preferred machine named, an answering peer with a lower machine id is awaited the same way (the pool's usual lower-id tie-break). Two machines restarting together therefore do not both claim the same epoch: the lower id claims and the other adopts it. This costs the higher-id machine at most that same bounded wait when the lower-id peer cannot claim.

A preferred machine that is in the registry but not dialable (no URL) cannot be probed. The rules then fall back to the every-known-peer test rather than waiting forever.

## 2. Under-block

- A peer reachable only through the Threadline relay, with no lease-wire endpoint, is not a known peer here, so it cannot hold others back. R2 (increment 2) covers ties through Telegram; the relay is not a lease medium today.
- A legacy peer (older build, no endpoint advertisements) answering 2xx is counted as silence, per spec: a legacy dial counts only signed replies. Its lease, if it holds one live, still folds into the view through the normal signature-checked path and ends the hold with a live holder. So a legacy *holder* is never taken over. A legacy *non-holder* preferred machine can be taken over after 45 s. The spec accepts this.
- `restartBudgetMs` is not published yet (R5). The interim window applies until R5 wires `peerRestartBudgetMs`. The seam exists, and the clamp is unit-tested.
- **Staggered boots (second-pass round-2 note b).** A deferring machine's signed-answer bound starts at the preferred machine's first signed reply. The preferred machine may still be in its own hold, waiting on a third peer. If both claim within one pull interval, they tie at the same epoch, and the existing contested-split resolver (lower id wins, loser relinquishes) cleans it up. The spec now places the full answer in R5 (increment 5): the pull reply reports "in boot hold" and the bound extends while it does, within the 10-minute ceiling.
- **Git-only mesh.** On a mesh with no pull-capable transport (no `pullAllPeers`), there is no known peer, so the hold ends at once and acquisition is today's path. Production always attaches `HttpLeaseTransport`, so this is a test-double or degenerate case. R1 does not implement git-fetch probing there (second-pass finding 3).
- **Fast restart within the lease lifetime.** An own lease that has not expired at boot goes to `renew()` before any pull. This existed before the change: a renewal must be confirmed over the medium, and `higherEpochEvidence` fences a superseded epoch. R1's rules are about a *lapsed* own lease (second-pass finding 4).
- Probe timestamps use the wall clock (`Date.now`), consistent with the transport's other timing. A large wall-clock step during the first minute of boot could shorten or lengthen the 45 s span. The normal rules still need a lapsed lease, so the worst case is the old behavior, not a new failure.

## 3. Level-of-abstraction fit

The rules live as a pure module consumed by `LeaseCoordinator`, the single place that owns acquisition. That is the layer the spec names. Classification lives in the transport, which alone sees status codes, headers and endpoint kinds. Ordering lives in the coordinator's lease-init. No new loop or timer was added: the probes ride the existing lease pull loop, and the nudge reuses `tickLease`.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. The transport's answer classification is a signal. The hold is a restraint on this machine's own claim: it never blocks another machine, a message, or a user action, and it never takes anything. Its only authority is to say "not yet" to its own CAS, bounded in time by deterministic floors (3 probes, 45 s, and a window capped at 10 minutes). The brittle part, header matching, can only turn an answer into silence, which shortens the wait. It can never extend the wait past the window. Compliant.

## 4b. Judgment-point check

The 3-probe/45-s threshold is listed in the spec's decision table as a judgment-candidate with a floor (the normal rules still need a lapsed lease), an arbiter (the probes), and configurable values (`silentProbes`, `silentSpanMs`). It is not a competing-signals judgment that needs an LLM. It is a liveness floor, and the values come from the interim hotpatch (no contest since 2026-11-20 10:35).

## 5. Interactions

- **F4 `shouldDeferToPreferred`** at boot still runs first and is unchanged.
- **`acquireHeldBack`** and **identity eligibility** run before the hold and are unchanged.
- **`peerOutranksLapsedSelf` / contested-split resolver.** The hold prevents the same-epoch tie that those paths exist to clean up. They remain in place for ties from other causes.
- **Pull-loop nudge.** It calls `tickLease` once, under its existing reentrancy guard. During the boot acquire, `leaseTicking` is held, so the early pull loop cannot run a second acquisition at the same time.
- **`LeaseHandbackReconciler`.** The preferred machine returning adopts the newer epoch (a unit test covers this), and hand-back is untouched.
- **`survivorMayHold` / `soloCaptainHold`.** They are still used everywhere else (renew, hold, git `localCommitIsFinal`). Only the ask-peers conjunct is bypassed, and only with the switch on.
- **Response marker middleware.** It is mounted second, after `closeUnreadBodyOnError`, and only sets a header. CORS and security headers are unaffected.

## 6. External surfaces

There is one new response header on every HTTP response, including unauthenticated ones and the boot beacon's 503s: `X-Instar-Machine: <16 hex>`, the first 64 bits of `sha256("x-instar-machine:v1:" + machineId)`. It does not disclose the machine id. It is a stable per-machine fingerprint: anyone who can reach the server could already tell that the same server answers. It lets a peer that knows the id confirm the reply came from that machine's Instar. It is not a credential and grants nothing. It is unsalted and stable, so an observer can link one machine's endpoints together (Tailscale and tunnel) and can tell the server runs Instar. A replayed marker counts only on a machine-bound endpoint, and only for the time-limited unsigned window, so replay can delay a takeover by at most that window. This is accepted as specified (second-pass finding 6).

There are new log lines, `boot-hold: <rule> <verdict>`, printed on change only, and one feature-evidence row per ended hold. There are no notices, routes or messages. Timing now depends on peer reachability during the first minute after a restart, which is the point.

## 6b. Operator-surface quality

Not applicable. No dashboard, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

The decision is machine-local by design: each machine restrains only its own claim, from its own probes. The coherence authority remains the fenced lease and CAS. A mixed pool, where one machine has the switch on and another off, degrades on the unflagged side to today's acquisition, which is exactly today's risk and nothing worse.

The marker is per machine by construction. There are no user-facing notices, so no one-voice gating is needed. There is no durable state: the probe history and hold latch are process-local and reset on restart, which is correct because the hold is per boot. No URLs are generated.

Status surfaces: none new or changed (`/health`'s body is unchanged; only the header is added).

## 8. Rollback cost

Rollback is a config switch: `multiMachine.takeoverReadyPool.enabled: false` or `…bootClaimSafety.enabled: false`, read live on every acquire. The next acquisition uses today's path, with no data migration and no state to repair.

The marker header has no off switch. It is inert, and removing it would need a code revert. A full revert is a plain code revert with no persisted format. The interim hotpatch on the Laptop and Mini is retired by installing a release that carries this fix, which overwrites the patched dist file. Until then, auto-apply stays held on those machines (a rollout step recorded in the PR).

## Conclusion

The change closes the boot-claim tie that caused the 2026-11-20 lead churn, as specified, with bounded delays, signal-only classification, and an off switch read live. Ready to ship once the second pass concurs.

## Second-pass review (if required)

**Reviewer:** second-pass subagent
**Independent read of the artifact: concern**

Verified against the code: the unsigned window and its clamp, 52x/530 never counting, quick tunnels and LAN never counting, legacy dials counting as silence, a stale standby not ending the hold, the 3-probe/45 s boundaries, the ask-peers branch dropping `survivorMayHold`/`soloCaptainHold` only when the switch is on, and `leaseTicking` stopping a second acquisition during init. With the switch off, acquisition is the old path. The only differences are the unconditional marker header, one extra `store.read()` in the constructor, and probe bookkeeping, and none of them change a claim. No case was found where the change claims something the old code would refuse. Tests pass: 59 unit, 8 integration, 5 e2e.

Findings:
1. **(Medium: permanent no-holder, a regression against the old code.)** Rule 3 has no time limit for *signed* answers (`BootClaimHold.ts` deferToPreferred branch, `answered-signed` → hold). A preferred machine that answers signed but never claims keeps every non-preferred machine in the hold for good, so the pool has no holder. It can get that way through `leaseRole`/`telegramPolling:false` observe-only, `acquireHeldBack`, or identity-ineligibility. The old code claimed after the lapse, because F4 `shouldDeferToPreferred` defers only to a *healthy holder*. The artifact does not mention this. Suggested fixes: treat a signed preferred reply whose view names no live holder as settled after a bounded window, or have the preferred machine advertise that it cannot claim.
2. **(Low/Medium: spec deviation.)** `newerViewThanBootRecord` (LeaseCoordinator.ts) ends the hold when the *local* record names another live holder. That is not a peer pull or a remote fetch, and it also covers a git store with no remote. The latch then lets the machine claim at that lease's lapse without rule 3, even if the preferred machine is answering. Spec rule 4 requires a peer view or a fetched refresh.
3. **(Low: spec gap, no regression.)** On a git-only mesh (no `pullAllPeers`), `knownPeers` is `[]`, so the hold ends at once with "no known peer to ask". The git-fetch semantics of rules 2 and 4 are not implemented there. The artifact should say that R1 does nothing on git-only meshes.
4. **(Low, pre-existing.)** An own lease that has not expired at boot goes straight to `renew()` before any pull, so rule 1 does not cover a fast restart within TTL after a survivor's holder-not-renewing takeover. The confirmed-broadcast requirement and `higherEpochEvidence` reduce the risk.
5. **(Low: liveness.)** `tickLeasePull` clears `bootHoldNudgePending` before `tickLease()`. If a heartbeat tick holds `leaseTicking`, `tickLease` returns at once and the nudge is lost, so the claim waits for the next heartbeat (about 2 min). Clear the flag only when the tick actually ran.
6. **(Low: security.)** `X-Instar-Machine` is an unsalted, stable 64-bit fingerprint on every unauthenticated response, public tunnel included. It lets an observer tie the same machine across endpoints, and it marks the host as Instar. It can be replayed, but a replay only counts on machine-bound endpoints and only for the time-limited window. Acceptable as specified. Worth noting in §6.
7. **Test gaps:** no tests for findings 1, 2, 3 or 5. No test for a git store where a remote-fetched epoch ends the hold and a local write does not. No test for the rule-1 pull when the view holds another machine's lapsed lease (that path skips the ask and relies only on the pull loop). No test for two machines restarting at once with no preferred named (a same-epoch contest, which the R9 drill says must fail).

### Resolution of the round-1 concerns (author)

1. **Fixed.** A signed answer from an awaited peer (the preferred machine, or with none named a lower-id peer) that names no live holder holds only until that peer's first signed answer plus its restart window plus the silence span (`BootClaimHold.ts`, `signedHoldExpired`; `firstSignedAtMs` in `HttpLeaseTransport.recordProbe`). Tests on both sides of the boundary: `tests/unit/BootClaimHold.test.ts` (an answering peer that never claims; a published restart time) and `tests/unit/LeaseCoordinator-bootClaimSafety.test.ts` (a preferred machine that answers but never claims).
2. **Fixed.** `newerViewThanBootRecord` now counts only a peer-sent lease, checked by `acceptTunnelLease` exactly as `effectiveView` folds it, or a durable epoch newer than the boot record on a store with a shared medium (a git remote). This machine's own copy never counts. Tests: a local record naming a live other holder does not end the hold; a git store with a remote ends it on a fetched newer epoch, and the same file with no remote does not.
3. **Documented** in §2 (git-only mesh).
4. **Documented** in §2 (pre-existing).
5. **Fixed.** The nudge flag is cleared only when `tickLease` really runs, or when the lease is already held. E2E test: a nudge landing while a lease tick is in flight is kept for the next pull tick.
6. **Documented** in §6.
7. **Tests added** for 1, 2 and 5, and for the git-remote case. The rule-1 ask now also runs during the boot hold when the stale view names another machine's lapsed lease. Two machines restarting together with no preferred named are covered by a unit test: exactly one claims and the other adopts it, at the same epoch with no contest, via the lower-id rule above.

**Round 2 independent read: concur** (two notes, neither blocking the code)

I checked each fix in the code:
- Finding 1: `signedHoldExpired` now bounds the hold at the peer's first signed answer + its window + the silence span. The lower-id await gives two machines restarting together one claimant.
- Finding 2: `newerViewThanBootRecord` now counts only a lease that passes `acceptTunnelLease`, or a git epoch on a store with a shared medium. `GitLeaseStore.hasNoSharedMedium` reads `hasNoRemote`. An unreadable check counts as having a remote, which is harmless, because nothing writes locally during the hold.
- Finding 5: the nudge flag is cleared only when `tickLease` actually runs or the lease is already held.
- The rule-1 ask now also runs for any stale view during the hold.

Tests pass: 70 unit, 8 integration, 6 e2e. The typecheck is clean.

Notes:
- **(a) The spec must be amended to match.** `docs/specs/takeover-ready-pool.md` rule 3 says "while the named preferred machine answers at all, the deferring machine never claims". Decision table line 545 says "signed liveness always counts". Both now differ from the code: a signed answer from a peer that has not claimed is bounded, and a lower-id peer is awaited when no preferred machine is named. The spec is authoritative and nothing under `docs/` is modified, so amend it (and re-tag if the convergence tag requires it) in the same PR.
- **(b) Low, a remaining edge.** A non-preferred machine starts its signed-answer clock when it first hears the preferred machine. The preferred machine may still be in its own hold, waiting on a third peer that answers unsigned over a longer window, or that started answering later. Once R5 publishes different restart budgets, or with staggered boots, the non-preferred machine can claim first. If both claims land within one pull interval, they tie at the same epoch, and the existing contested-split resolver has to clean up. A possible fix: the preferred machine reports "in boot hold" in its pull reply, and the hold extends while that holds, bounded by the 10-minute ceiling. Fine to file as an R5 follow-up.

## Evidence pointers

- `tests/unit/BootClaimHold.test.ts`
- `tests/unit/LeaseCoordinator-bootClaimSafety.test.ts`
- `tests/unit/HttpLeaseTransport-bootProbe.test.ts`
- `tests/unit/BootHealthBeacon.test.ts`
- `tests/integration/boot-claim-safety.test.ts`
- `tests/e2e/boot-claim-safety-boot-path.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: this fixes TypeScript lease logic, not a prompt, hook, config, skill or standards text. It adds no self-triggered controller either: the one-shot `tickLease` nudge fires at most once per process, when the boot hold ends, and adds no loop, retry or restart. Not applicable.
