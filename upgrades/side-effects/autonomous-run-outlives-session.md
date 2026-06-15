# Side-Effects Review — autonomous-run-outlives-session

Spec: `docs/specs/autonomous-run-outlives-session.md` (converged + approved).
Change: GAP-D — the resume-queue host-lock distinguishes a single-host RENAME
(auto-heal) from a genuine shared-volume conflict (stay disabled), fail-closed;
a disabled revival queue self-reports to the guard-posture inventory; + the
constitutional standard "An Autonomous Run Must Outlive Its Session".

Files:
- `src/monitoring/ResumeQueue.ts` — `classifyDfSourceLocal` + `isStateDirHostLocalDefault` (FD1), foreign-host rename-vs-conflict classifier (FD2), `takeOverLockAtomic` (FD4), `guardStatus()` (D2), `autoHealStaleHostLock` config field (FD5).
- `src/monitoring/guardManifest.ts` — `GUARD_MANIFEST` entry `monitoring.resumeQueue.enabled` (component `ResumeQueue`).
- `src/commands/server.ts` — dev-gate resolves `autoHealStaleHostLock`; UNCONDITIONAL `guardRegistry.register` for the queue.
- `src/core/types.ts` — `autoHealStaleHostLock?` config field.
- `docs/STANDARDS-REGISTRY.md` — the new standard.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — Agent Awareness line (new + deployed agents).
- Tests: `tests/unit/resume-queue-autoheal-lock.test.ts` (11), `tests/integration/resume-queue-guard-posture.test.ts` (3).

## 1. Over-block (what legitimate inputs does this reject that it shouldn't?)
The auto-heal is STRICTLY ADDITIVE and gated: it can only turn a currently-DISABLED
foreign-host case into an enabled one. It never disables a case that previously
worked. The risk direction is "fails to heal a legitimate rename" → the queue
stays disabled exactly as today (no regression), just with a louder surface.
Fail-closed on any uncertainty (unknown FS, df failure, live pid, fresh heartbeat)
means some genuine renames won't auto-heal — acceptable: the operator clears the
lock manually as before, and the guard-posture alert now tells them to.

## 2. Under-block (what failure modes does this still miss?)
- pid recycling (FD3, accepted): a recycled dead pid that maps to a live unrelated
  process reads as a live conflict → stays disabled + LOUD (safe direction; worst
  case a false escalation, never corruption).
- The narrow double-boot unlink race in `takeOverLockAtomic` (two server boots on
  one machine within ms of each other post-rename): O_EXCL gives EEXIST to the
  loser in the common case; the residual double-unlink window is backstopped by
  the next-acquire live-pid + heartbeat check. Not corruption — at worst a
  transient re-evaluation.
- Genuine shared-volume setups where `df -P` reports a device string we don't
  recognize as network: classified unknown → NOT local → stays disabled (correct).

## 3. Level-of-abstraction fit
Correct layer. The lock classifier lives IN `ResumeQueue.acquireLock` (the only
place that owns the lock), and the surfacing rides the EXISTING guard-posture
inventory (GUARD_MANIFEST + GuardRegistry + GuardPostureProbe) rather than a new
parallel alert path. No new notification surface invented — it feeds the one that
already aggregates and dedups (Bounded Notification Surface).

## 4. Signal vs authority compliance (docs/signal-vs-authority.md)
COMPLIANT. The auto-heal is bounded SELF-RECOVERY of the queue's own lock with a
fail-closed default — not a brittle gate holding blocking authority over agent
behavior or message flow. The guard-posture surfacing is a pure SIGNAL-producer
(it reports a disabled state; it never blocks, delays, or rewrites anything). The
default `autoHealStaleHostLock:false` keeps the behavior change off the fleet until
proven; the dev-agent runs it dryRun-first (logs intent without rewriting).

## 5. Interactions
- Preserves the original HARD INVARIANT (never pid-probe a foreign lock) when
  auto-heal is OFF — verified by the existing `resume-queue.test.ts:417` invariant
  test (which initially regressed and was fixed by gating all probing behind
  `autoHealStaleHostLock`).
- The new GUARD_MANIFEST entry passes `lint-guard-manifest` (the drainer is not
  auto-flagged, so no orphan NOT_A_GUARD entry — which would itself fail the lint).
- `guardRegistry.register` is UNCONDITIONAL (even when start() returns false) so a
  lock-disabled queue reads `off-runtime-divergent`, not `missing`.
- Does NOT touch `evidenceEligible` / the #1157 revival path — strictly the lock
  gate. No double-fire with the existing same-host stale reclaim (that path is
  unchanged; this is the foreign-host branch only).

## 6. External surfaces
- New config key `monitoring.resumeQueue.autoHealStaleHostLock` (fleet default
  false). No new route. `GET /guards` and `GET /sessions/resume-queue` gain a
  truthful disabled-state read; no schema break (additive).
- CLAUDE.md template + migrator add one awareness bullet (new + deployed agents).
- No external network/timing dependence beyond a single bounded (3000ms) `df -P`
  at lock-acquisition.

## 7. Multi-machine posture (Cross-Machine Coherence)
MACHINE-LOCAL BY DESIGN, and that is the whole point: the resume-queue lock + its
state dir are deliberately host-local (a shared volume across two hosts is
unsupported — the invariant this change PROTECTS). The fix makes the host-local
assumption ROBUST to a rename of the SAME machine without ever weakening the
cross-host protection (a genuine foreign live host still disables). guardStatus is
read per-machine; each machine's `/guards` reports its own queue. No replication
needed or wanted (a lock is intrinsically local).

## 8. Rollback cost
Cheap and immediate. `monitoring.resumeQueue.autoHealStaleHostLock:false` (the
fleet default) fully disables the new auto-heal — reverting to today's
disable-on-mismatch behavior — with no restart-data implications (config read at
queue construction; next server start picks it up). The guard-posture surfacing is
inert when the queue is healthy and harmless when disabled (it only reads state).
No migration, no data repair. The constitutional-standard doc + CLAUDE.md lines are
documentation (no runtime surface).

## Test coverage (Testing Integrity)
- Unit: `resume-queue-autoheal-lock.test.ts` — FD1 truth-table; auto-heal on
  provable rename; stays-disabled on non-local FS / live pid / fresh heartbeat;
  dryRun no-rewrite; auto-heal-off preserves original behavior; guardStatus.
- Integration: `resume-queue-guard-posture.test.ts` — a runtime-disabled queue
  classifies `off-runtime-divergent` through the real GUARD_MANIFEST entry +
  `deriveGuardRow` (the route's path); a healthy queue does not.
- E2E: the existing `tests/e2e/resume-idle-autonomous-lifecycle.test.ts` exercises
  the queue alive end-to-end; this change is additive and those pass. (A dedicated
  boot-with-stale-lock E2E is a candidate enhancement; the unit+integration tiers
  cover the new logic and its wiring.)
- Regression: full resume-queue unit + route suite (100 tests) green; tsc clean;
  lint-guard-manifest clean.

## Second-pass review
**Concur with the review.** Independent Phase-5 audit (guard/recovery path) verified, citing code:
1. Auto-heal can NEVER fire on a genuine shared volume with a live remote holder — `fsLocal` is dispositive and `&&`-short-circuits before any pid probe; `df -P` on a network mount never reports `/dev/*`.
2. The HARD INVARIANT (never pid-probe a foreign lock) is preserved when auto-heal is OFF (the fleet default) — all probing is gated behind `if (this.cfg.autoHealStaleHostLock)`; the existing invariant test (default config) still asserts `probed===false`.
3. `takeOverLockAtomic` O_EXCL first-writer-wins is correct; the only residual is the documented narrow double-boot unlink window, backstopped by the next-acquire live-pid+heartbeat check — transient/self-correcting, never durable corruption.
4. Signal-vs-Authority compliant — the only authority is the queue refusing to start itself (bounded self-recovery, fail-closed); `guardStatus()` is a pure signal producer.
5. No common-path regression — a healthy boot never enters the foreign-host branch and never calls `df`.
Verdict: sound, fail-closed in the right direction, well-tested on both sides of every decision boundary, safely gated.
