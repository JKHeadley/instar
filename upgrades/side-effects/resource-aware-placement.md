# Side-Effects Review — Resource-aware placement

**Version / slug:** `resource-aware-placement`
**Date:** `2026-11-07`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review)`

## Summary of the change

Spec: `docs/specs/resource-aware-placement.md` (converged in 6 rounds, approved by Echo under its standing grant citing Justin's 2026-11-06 17:40 and 18:30 messages in topic 134088). Tier 2.

- New pure module `src/core/machineResourceProfile.ts`: machine size (cores, memory) from registry hardware or the load report; a heavy-work floor (12 cores, 32 GiB) with a per-machine override; per-core load from FRESH evidence only; heavy headroom (fresh verdict not saturated/impaired, ≤ 1.0 per core including pending heavy items); a signal-only command classifier.
- `PlacementExecutor`: the load term is per-core × 8 (today's scale); machines without a fresh load number are ranked after measured ones ("measured first", including sticky's comparison); a new `workWeight: 'heavy'` path picks only heavy-capable machines with headroom, otherwise `queued` with a named reason.
- `MachineLoadReport` advertises `heavyWork` (the machine's own `multiMachine.placement.heavyWork` override) and `heavyPending` (heavy helper spawns it accepted in the last 3 minutes).
- Local Verify: a `peerFit` seam skips peers that are too small, busy or unmeasured, and tries the rest least-loaded first (audited at most once per 10 min per reason).
- Jobs: `workWeight` on job definitions; a heavy job skips a below-floor machine while another online heavy-capable machine exists (new skip reason `machine-too-small`, feeding the existing job-silence alert with plain wording).
- Routes: `GET /pool/placement/preview` (read-only dry run) and `POST /pool/heavy-work/spawn` (places a headless helper through the chosen machine's own `/sessions/spawn`; started / refused / unconfirmed / queued). `/sessions/spawn` accepts `workWeight` and answers definite refusals (admission, spawn cap, duplicate name) with 409 + code instead of 500.
- Agent awareness: one CLAUDE.md template line plus a `PostUpdateMigrator` migration (marker `Resource-aware placement (heavy work`).

Size: about 14 source/test files, ~1,300 added lines. Effort: 6 spec rounds (at the Tier-2 cap; most rounds were the helper route's failure semantics).

## Decision-point inventory

- Heavy size floor (`profileOf`) — add — invariant; unknown size → not capable.
- Heavy headroom (`heavyHeadroom`/`heavyFit`) — add — invariant; stale/missing → load-unknown, never idle.
- Placement load term + measured-first (`PlacementExecutor.score`/`measuredFirst`) — modify — deterministic normalisation.
- Heavy placement branch (`PlacementExecutor.decide`) — add.
- Verify peer eligibility (`LocalVerifyService.fitPeers`) — add (seam; absent = today).
- Heavy job gate (`JobScheduler.triggerJob`) — add.
- Spawn refusal classification (`classifySpawnRefusal`, `/sessions/spawn` catch) — modify (500 → 409 for three definite refusals).
- `inferWorkWeight` — add — signal only, no authority.

## 1. Over-block

- A heavy item when every big machine is busy waits (`queued` / 409) even though a small idle machine exists. Intended (operator: heavy work not on the Mini); the per-machine `allow` override lifts it.
- A big machine with no fresh load evidence (e.g. ~15 s after its server restarts, or a peer on old code without a report) gets no heavy work until its report arrives.
- A verify peer the pool cannot see is skipped when the pool runs (pool dark keeps today's behaviour).
- A declared-heavy job on a small machine running jobs is skipped while a big machine is online; the job-silence alert names the fix. No built-in job declares heavy.

## 2. Under-block

- In-session Agent-tool subagents cannot be placed; the change gives the agent a preview and a placed-helper route and tells it to use them, but cannot force it.
- The coordinator's own Local Verify slot still runs full verifies even on a small coordinator (instar feedback fb-f291c30d-bbe).
- Pending-heavy damping is approximate across two deciders.
- A helper whose spawn was delivered but never recorded, with a lost response, could later be started again (accepted risk in the spec; mitigated by the duplicate-name refusal and the "check shared side effects" rule).

## 3. Level-of-abstraction fit

Placement decisions stay in the single canonical `PlacementExecutor` (no parallel placement logic). The profile math is a pure module consumed by placement, verify, the scheduler and the routes. The helper route reuses the target's existing `/sessions/spawn` (validation, rate limit, caps, admission) instead of duplicating spawn logic.

## 4. Signal vs authority compliance

- [x] No brittle logic holds blocking authority. The only brittle detector (`inferWorkWeight`) is signal-only: it labels the preview, nothing reads it to refuse/move/skip. The size floor reads enumerable hardware facts with an operator override; headroom reads the machine's own quorum verdict plus one fresh number. Refusals are deferrals with named reasons.

## 4b. Judgment-point check

No competing-signals judgment point is added; every new decision is deterministic over measured or declared inputs, classified `invariant` in the spec's decision table and contested by reviewers over six rounds. No LLM arbiter.

## 5. Interactions

- **Shadowing:** the heavy branch runs after the existing quota, overload-admission and channel gates, so it never overrides them; for heavy work the "place on a quota-blocked machine anyway" fallback is replaced by `queued`.
- **Rebalance / overload shed:** both call `decide()`; their triggers are unchanged (session ratio, closed admission) but target choice uses per-core scores, so a move can go to a different machine than before, inside their existing caps and cool-downs.
- **Sticky:** comparison now excludes unmeasured machines, so an unmeasured peer can no longer break hysteresis.
- **Job-silence alert:** `machine-too-small` joins the reasons that feed it; same 3-skip threshold and 24 h dedupe.
- **Races:** the decider reservation is taken before the forward and kept to expiry; released only on a definite refusal.
- **Feedback loops:** none; the heavy-pending count only adds load to a target, damping (not amplifying) further placement.

## 6. External surfaces

- Other agents on the same machine: none (load report fields are per agent server).
- Install base: every multi-machine agent's conversation placement now uses per-core load and measured-first; Local Verify hand-offs skip small machines. Single-machine agents: unchanged (the job gate never applies alone; heavy preview on one machine just reports it).
- `/sessions/spawn` callers: three error cases change from 500 to 409 with `code`. Reviewed: no caller or test depends on 500.
- External systems: none. No Telegram/Slack notices added (the job-silence alert is existing).
- Operator surface: the override is a config value the agent sets on the machine it describes; the preview is a read-only route the agent reads and reports from. No new operator-facing action requiring a phone surface.

## 6b. Operator-surface quality

No dashboard or approval surface touched — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Profile / headroom / placement load: proxied-on-read from each machine's own heartbeat.
- `multiMachine.placement.heavyWork`: machine-local, advertised in its load report — machine-local-justification: hardware-bound-resource.
- `heavyPending` (target-side) and decider reservations: in memory, 3-minute lifetime — hardware-bound-resource (estimates of a machine's committed capacity, superseded by its load report).
- Preview / helper spawn: answer from the local pool view (`answeredBy` + evidence ages); the spawn rides the existing authenticated peer channel.
- Job weight: part of job definitions (already synced); skips recorded in each machine's existing skip ledger.

## 8. Rollback cost

Revert the PR and release. No data or state migration. Leftover `multiMachine.placement.heavyWork` keys are inert after a revert; older peers ignore the new load-report fields; the CLAUDE.md line would remain on updated agents until a later migration removes it (harmless text describing routes that would then 404).

## Conclusion

Ships live by default per the operator's direction. The change narrows where heavy work goes and makes "busy" size-aware; every refusal is a named deferral; the only brittle detector holds no authority.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent, fresh context, read-only (second pass of 2026-11-08 over the landing commits; the first pass below is the original builder's).

Concur with the review. (Independent second-pass reviewer, read-only audit of the worktree diff; no build or suite run.) Claims verified: `inferWorkWeight` is consumed only by the preview's `inferred` field; unknown/stale load returns `load-unknown`, never idle; the heavy branch sits after the quota, admission and channel gates and queues instead of using the quota-blocked fallback; `/sessions/spawn` maps exactly the three typed or legacy refusals to 409 + code; the job gate returns null (does not apply) with no registry, no self row, or no other online heavy-capable machine; the module-level `_resourcePoolRegistryRef` has no TDZ risk (a module `let`, read lazily); the `'self'` key is consistent between `acceptedHeavy.record` and the sampler's `count`. Notes:
1. `forwardHeavySpawn` (heavyWorkPlacement.ts:154) dials the peer with raw `fetch`, not `poolPeerFetch`, so a dead rope is never demoted and the next helper picks it again. It also omits `X-Instar-AgentId`, which logs the auth deprecation warning. The URL is already guard-admitted by `resolvePeerUrls`, so this is not a credential leak. Suggest `poolPeerFetch` (POST does not fall through) plus the agent-id header, matching routes.ts:13082.
2. Self loopback `http://127.0.0.1:${ctx.config.port}` (routes.ts ~25109) fails when `config.host` is an explicit non-loopback address (`resolveMeshBindHost` then binds only that address). The thrown ECONNREFUSED is reported as `unconfirmed / do not retry` although nothing was sent. More generally, a connection refused error before any bytes are sent could be classed as a definite failure.
3. A local caller placing on self takes two `spawnLimiter` tokens from the same 127.0.0.1 bucket (outer and inner route). A 429 is correctly classed as refused, so this is only a halved budget.
4. `selfHeavyJobProfile` (machineResourceProfile.ts:259) applies a live `allow` override only when the self row already has a `loadReport`, so a heavy job can be skipped in the boot window before the first report. This is minor because the report soon carries the override anyway.
5. Peer fit's "pool dark keeps today's behaviour" applies only before the registry exists. The registry is built whenever an identity manager exists, so on any multi-machine install a verify peer that is not in the pool, or has no fresh evidence, is skipped. This is the intended over-block in §1. Also, the heavy job gate counts an online big *standby* as "elsewhere to run", but a standby runs no jobs. The alert text names the fix, and §1 already accepts this.

**Author response.** Notes 1 and 2 fixed before commit: the peer forward now dials through `poolPeerFetch` (rope health recorded; a POST never falls through) with `X-Instar-AgentId`; the self forward uses this server's configured bind host when it is a specific address; and a refused connection (nothing reached the target) is classed `refused` (`connection-refused`), not unconfirmed — tests in `tests/unit/heavy-work-placement.test.ts`. Notes 3–5 are accepted over-blocks already listed in §1/§2.

**Follow-on commit.** `PendingHeavyWork.clear()` was added for test isolation only (the integration routes share one process-wide reservation list); no runtime code calls it.

**Local Verify fix (2026-11-07).** The first full verify failed 4 unit tests in 3 files, reproduced locally: (1) the CLAUDE.md line contained `sessions?scope=pool`, an older migration's marker, so the pool-visibility idempotence tests counted it twice — reworded; (2) the no-silent-fallbacks scanner's 20-line window around an existing `.catch` (JobScheduler.ts ~758) reached the new `selfHeavyProfile` field's `= null;` — the field is now optional; (3) the write-domain ratchet needs every mutating route declared — `POST /pool/heavy-work/spawn` is annotated `@write-domain:none` (in-memory reservation; the target's `/sessions/spawn` owns the write).

**Landing review (2026-11-08).** A fresh read-only reviewer re-read the Local Verify changes (`src/localVerify/LocalVerifyService.ts`, `src/localVerify/localVerifyWiring.ts`), the lease test's new per-test cap and the new architecture-page section, and concurred. Verified: an absent fit function keeps the configured peer order; a throwing one counts the peer eligible with an infinite score (sorted last, never dropped); when every peer is ineligible the dispatch returns without marking anything passed and the PR runs in the local slot; result import and status still use the unfiltered peer list, so a run already in flight is accepted; the skip audit is keyed per peer and reason with a 10-minute window; the wiring calls the real `heavyFit` on the pool row. The lease test simulates about two hours of lease traffic under fake timers in a fixed-size loop, and no assertion changed. Two overstated docs sentences (the job gate applies only while another online machine is eligible; the 12-core / 32 GB floor is a fixed constant and the per-machine `heavyWork` allow/deny override was unmentioned) were corrected before commit. Non-blocking gaps noted: the all-peers-ineligible test does not assert the later local run, and the status view does not show resource skips (only the audit log does).

## Evidence pointers

- Unit: `tests/unit/machine-resource-profile.test.ts`, `tests/unit/placement-resource-aware.test.ts`, `tests/unit/heavy-work-placement.test.ts`, `tests/unit/job-heavy-weight-gate.test.ts`, `tests/unit/localVerify/peerVerifier.test.ts` (peer fit block); existing `PlacementExecutor`, `placement-overload-admission`, `signed-out-machine-placement`, `SessionRouter`, `RebalancePlanner`, `overload-shed`, `start-failure-placement` suites green.
- Integration: `tests/integration/resource-aware-placement-routes.test.ts`.
- E2E: `tests/e2e/resource-aware-placement-alive.test.ts`.
- Live: read-only preview on Echo's real fleet (PR body).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered controller added — not applicable.
