# Side-Effects Review — Lease flap fix: live-evidence liveness, lease medium check, unconfirmed-write signals

**Version / slug:** `lease-unconfirmed-candidate-flap`
**Date:** `2026-10-04`
**Author:** `luna (sagemind)`
**Second-pass reviewer:** `cross-model reviewer (codex-cli, gpt-6-astra), see below`

## Summary of the change

Implements Changes 1, 2, 3 and 4 of `docs/specs/lease-unconfirmed-candidate-flap.md` (v45, converged and approved). On 3 October a laptop and a Mac Studio paired for one agent flapped the serving lease every few seconds. The trigger was liveness read from a frozen registry `lastSeen`. The amplifier was the Studio using `GitLeaseStore` over a git-ignored `registry.json`, reading back its own unaccepted candidate after every failed push.

- **Change 1** (`src/core/leaseLiveness.ts`, `MachinePoolRegistry.ts`, `LeaseCoordinator.ts`, `MultiMachineCoordinator.ts`, `server.ts`) decides peer liveness from this machine's own monotonic live-pull receipt or a verified renewal. A never-observed peer is not dead and not gone. `acquireIfEligible` reads liveness after folding in tunnel renewals, when the switch is on.
- **Change 2** (`LeaseCoordinator.nextNonce`, `HttpLeaseTransport.recordObserved`, receiver freshness) makes each nonce strictly above the process counter and at least the current wall-clock milliseconds, and on first use raises the counter to the nonce of its own signature-verified durable lease when the first read succeeds and the nonce is a safe integer within a year of the clock (never a network observation). Receivers track nonce watermarks by holder and epoch: transport resets the floor on an authenticated higher-epoch receipt, and the coordinator verifies the signed lease before resetting its freshness floor. Same-epoch and old-epoch replays remain rejected. Acquisition and fencing rules are unchanged, but replay, freshness, and takeover outcomes change. Residual: if the receiver has a higher same-epoch nonce than the holder can recover at boot, it drops renewals until catch-up or epoch advance and can take over once. A receiver on an older build may keep dropping renewals even after a higher-epoch acquisition. No switch; rollback is reverting the release after returning to one machine.
- **Change 3** (`src/core/leaseMediumSelection.ts`, `server.ts`, `MultiMachineCoordinator.ts`, `types.ts`) checks once at boot whether git can carry the registry. A git-ignored registry gets `LocalLeaseStore`, and a lease-only `leaseGitRef` replaces `gitSyncRef` for the three lease consumers. `/health` reports `leaseMedium`.
- **Change 4** adds DegradationReporter signals: an unconfirmed acquisition-write streak, a never-observed peer, and the `failoverThresholdMs <= leaseTtlMs` ordering check.
- Three live switches sit under `multiMachine.leaseFlapFix`, each absent ⇒ on. The CLAUDE.md template section and `PostUpdateMigrator` migration carry the awareness text.

## Decision-point inventory

- `presumedDeadHolders` / `allPeersPresumedGone` (inputs to `FencedLease.canAcquire` and `soloCaptainHoldEligible`) — **modify** — the evidence they read changes from `lastSeen` to live receipts plus verified renewals; with `liveness:false` they call today's `isPeerPresumedDead` unchanged.
- Lease store choice at boot — **modify** — git or local, chosen from the registry's actual git status instead of "a git-sync manager exists".
- `acquireIfEligible` liveness read position — **modify** — inside the loop after `effectiveView()` when `liveness` is on; today's single read before the loop when off.
- DegradationReporter events — **add** — three signals, none consumed by any lease decision.

---

## 1. Over-block

No block/allow surface on messages or actions. On the lease, Change 1 makes the "presumed dead" verdict stricter: a peer is dead only on stale live evidence, never from `lastSeen`. A peer that is genuinely gone but was never observed in this process is taken over at lease expiry (about one minute) rather than earlier. That is the intended P20 behaviour, not an over-block. With the solo-captain hold enabled (off by default and on sagemind), the hold can engage later than on today's build, as the spec states.

## 2. Under-block

- A lease the medium never accepted, which then only renews, is not detected (deferred with Echo, approved 3 Oct).
- Windows (a) partition, (b) boot overlap, (c) restart hand-over and (d) intermittent holding pre-exist. They are characterised by tests, not fixed (ratified 4 Oct).
- The live pull receipt is unauthenticated (`MeshRpcClient` does not verify who answered). A forged receipt can delay a takeover, or give a never-observed peer a history that later reads as dead or gone. Its effects are listed per reader in the spec and recorded by unit tests. The window (d) change must not rest the hold gate on it.

## 3. Level-of-abstraction fit

Right layer. Liveness stays a deterministic input to the existing `FencedLease` authority. The builder replaces two closures in `server.ts` with one tested module beside today's `isPeerPresumedDead`. Medium selection runs where the store is chosen. The new reports go through the existing DegradationReporter. No parallel gate is added.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The lease authority is `FencedLease.canAcquire`, a deterministic fenced-lease rule that is the system's single holder authority by design (an invariant, not a judgment call). Change 1 changes the evidence it is fed. Change 3 changes which store it reads. Change 4's reports are signals only: none feeds `canAcquire`, `holdsLease` or `_staleOwnerSelfProof`.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The spec classifies all three decision points as `invariant`: presumed dead/gone (an enumerable evidence table), store medium (a git exit status), and degradation thresholds (signal only). The freshness window reuses `failoverThresholdMs`. The one cheap-to-change constant is the alert threshold of 5, which drives a report only.

## 5. Interactions

- **Solo-captain hold (dark):** reads `allPeersPresumedGone`, which now never treats a never-observed peer as gone. Recorded by test.
- **B4 skew-immune liveness:** reproduced exactly when `liveness:false` (unit test).
- **U4.2 stale-owner release:** reads `_hasDurableLeaseAuthority`, which is false on `local`, so U4.2 refuses a 2-machine claim as it does on a git-less install.
- **GitSync backup:** the backup `gitSync` instance is untouched; only lease consumers move to `leaseGitRef`.
- **Debouncer:** not wired on `local`.
- **Write counter vs renewals:** renewals never call `casWrite`, so they are never counted.
- **Nonce consumers (Change 2):** transport replay and coordinator freshness watermarks are scoped to a holder and epoch. The tombstone's "strictly above our last renewal" rule and U4.4 hand-back consent nonces compare by order; none assume small values or step 1. The hand-back consent token draws from the same `nextNonce`; its single-use check burns used (holder, nonce) pairs. Seeding above a known own lease also reduces restart collisions when the clock is corrected. A still-running old receiver does not reset its watermark at a higher epoch, so mixed-version rollback needs the single-machine procedure below.
- **No double-fire:** each report deduplicates (once per streak; once per peer and window; once at boot).
- **DegradationReporter (shared component):** gains an event-level `internalOnly` flag. It survives normalization and restart-queue replay, and it suppresses remediation dispatch, Attention items and Telegram delivery. Callers that omit it behave exactly as before; the reviewer checked existing callers for routing regressions and found none. Only the new lease events set it.
- **Lease tick robustness:** sampling and reporting failures are caught inside the coordinator, so a malformed registry or a throwing reporter cannot skip a renewal or reconciliation. Diagnostic failures in medium setup cannot clear an established git reference.
- **Switches:** read through `LiveConfig`, so a `config.json` edit applies without restart (except `mediumCheck`).

## 6. External surfaces

- `/health` gains `multiMachine.syncStatus.leaseMedium` (`medium`, `reason`, `store`), read-only.
- New DegradationReporter events are internal only: no user notice and no Attention item.
- The CLAUDE.md awareness section reaches new agents through the template and existing agents through the migration.
- Behaviour depends on runtime timing (`failoverThresholdMs`, `leaseTtlMs`). The ordering check reports a misconfiguration.
- Wire protocol and lease record format are unchanged, so mixed versions interoperate. This is tested in both orientations.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the multi-machine lease itself.

- **Liveness:** machine-local by design. Each machine judges its peers from its own receipts and verified renewals; replicating them would reintroduce the frozen-symbol fault.
- **Medium choice:** per machine. Each machine checks its own checkout and reports its own `leaseMedium`. A tracked pair stays on git; a git-ignored pair is local plus authenticated tunnel on every machine. This is how the laptop already ran.
- **Notices and state:** no user-facing notices, so there is no one-voice concern. No new durable state.

## 8. Rollback cost

Each switch is a live config flip, except `mediumCheck`, which applies at restart. No release is needed and no data migration is involved.

Caveat, stated in the spec, the ELI16 and the awareness text: rolling back `liveness` or `mediumCheck` (or the release) restores the original fault on a paired agent with a git-ignored registry. The safe back-out is therefore:
1. Stop the standby and keep it stopped.
2. Run `instar machines remove <name>` on the remaining machine.
3. Flip the switch and restart.

The stray candidate left in the Studio's registry is inert, and nothing needs cleaning up.

## Conclusion

Ships. The changes feed and select inputs for the existing lease authority, add no new authority, and carry per-change rollback switches. The residual risks (pre-existing windows, the unauthenticated receipt, never-accepted holding) are declared in the spec and were ratified or deferred by the operator on 3 and 4 October.

## Second-pass review (if required)

Required: this change touches lease and session-ownership authority.

**Reviewer:** cross-model code reviewer, codex-cli gpt-6-astra (independent session, read-only).
**Independent read: concur, after two fix rounds.**

- **First pass (CHANGES REQUESTED), six findings:**
  1. The switches were not live: they read the boot-time config.
  2. The new reports could reach users through the `notifyUser` path.
  3. A sampling exception could abort a lease tick.
  4. A diagnostic failure could silently switch the medium to local.
  5. The write streak did not clear when its switch went off without a CAS write.
  6. The solo-hold characterisation passed without the solo hold.
- **Second pass:** findings 1, 3, 4 and 5 were resolved. Finding 2 was partial (structured dispatch and replay), and so was finding 6 (the test was still inside the grace period).
- **Third pass: APPROVE.** A mutation check (solo-hold branch disabled) confirms the positive case now fails without it.

## Evidence pointers

- Spec: `docs/specs/lease-unconfirmed-candidate-flap.md` (v45). Convergence report: `docs/specs/reports/lease-unconfirmed-candidate-flap-convergence.md`.
- Unit: `tests/unit/leaseLiveness.test.ts`, `LeaseCoordinator.test.ts`, `LeaseCoordinator-selfHeal.test.ts`, `MachinePoolRegistry.test.ts`, `leaseMediumSelection.test.ts`, `leaseMediumRealGit.test.ts`, `lease-medium-wiring.test.ts`, `multimachine-syncstatus.test.ts`, `PostUpdateMigrator-leaseMedium.test.ts`.
- Integration: `tests/integration/lease-medium-health.test.ts`, `tests/integration/lease-http-convergence.test.ts`.
- E2E: `tests/e2e/multi-machine-lease-split-brain.test.ts`.
