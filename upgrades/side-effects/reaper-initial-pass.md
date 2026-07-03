# Side-Effects Review — AgentWorktreeReaper one-time initial pass (reaper-never-fires fix)

**Version / slug:** `reaper-initial-pass`
**Date:** `2026-07-02`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `echo reviewer subagent (independent read)`

## Summary of the change

`AgentWorktreeReaper.start()` scheduled ONLY a 24h `setInterval` with no initial pass. Real agent servers restart far more often than daily (updates, sleep/wake supervisor bounces), so the interval reset forever and an **enabled + armed** reaper never ran a single pass — measured on 2026-07-02 as 86 worktrees / 25GB accumulated on a machine with `enabled: true, dryRun: false` (the fseventsd/reboot incident's root cause). The fix adds a one-time initial pass `initialPassDelayMs` (default 15 min) after `start()`, keeping the 24h cadence unchanged. Files: `src/monitoring/AgentWorktreeReaper.ts` (config field + initial `setTimeout`, unref'd, cleared by `stop()`, `initialPassPending` in `snapshot()`), `src/core/types.ts` + `src/config/ConfigDefaults.ts` (config plumbing), `src/core/PostUpdateMigrator.ts` (CLAUDE.md awareness bullet for fresh + already-installed sections), `tests/unit/agent-worktree-reaper.test.ts` (7 new tests).

## Decision-point inventory

- `AgentWorktreeReaper.evaluate()` (keep/reap classifier) — **pass-through** — untouched; all safety gates (in-use / dirty / unmerged / detached → KEEP) unchanged.
- `AgentWorktreeReaper.start()` scheduling — **modify** — adds WHEN a pass runs (one initial pass), never WHAT a pass may delete.
- `killsEnabled` (enabled && !dryRun) — **pass-through** — the initial pass runs through the same `reap()` with the same dry-run/enabled gating and the same `maxReapsPerPass` blast-radius cap and per-path failure breaker.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (Nothing new is rejected; the classifier is untouched.)

---

## 2. Under-block

The inverse risk (over-DELETE) is the relevant frame for a deleter: the initial pass cannot delete anything the interval pass wouldn't — same `reap()`, same gates, same cap. Residual miss: an agent whose server restarts more often than every `initialPassDelayMs` (15 min) still never completes a pass; that pathological restart-loop case is out of scope here (the crash-loop itself is the incident to fix) and the pass is cheap enough that a partial-uptime server still benefits on the next calm boot.

---

## 3. Level-of-abstraction fit

Right layer: the defect is purely in the component's own scheduling, so the fix lives in the component's `start()`. Alternatives considered and rejected: a scheduler job wrapping the reaper (duplicates an existing component lifecycle for no gain); persisting `lastPassAt` across restarts and firing when overdue (more state, more failure modes — the 15-min delayed pass achieves the same outcome stateless).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change adds no authority and no detector. The reaper's existing (deliberately conservative, fail-closed) classifier keeps sole authority over deletions; this change only makes the already-shipped schedule actually execute. Dry-run/enabled defaults are unchanged (ships OFF + dry-run).

---

## 5. Interactions

- **Shadowing:** none — no other component schedules reaper passes.
- **Double-fire:** initial pass and interval pass could theoretically overlap on a pathologically slow pass; `reap()` already has a `running` re-entrancy guard (returns empty, does not queue). Confirmed in code and covered by existing tests.
- **Races:** the initial pass lands ~15 min after boot — after the busy post-boot window, and any worktree in use at that moment is kept by the `isInUse` gate (lock or live process cwd). A concurrently-created fresh worktree is kept by `isInUse`/dirty/unmerged gates exactly as during an interval pass.
- **Feedback loops:** none — reaping does not feed anything that schedules reaping.

---

## 6. External surfaces

- Other agents on the same machine: each agent's server reaps only its own `.worktrees/` estate (worktreesDir-bounded) — unchanged.
- Install base: behavior change is that an agent with the reaper ENABLED will now actually reclaim merged+clean+idle worktrees within ~15 min of boot instead of never. The feature still ships OFF + dry-run by default, so fleet agents see no change until an operator opts in.
- External systems: the initial pass may trigger the existing one-per-sweep `gh` merged-PR call ~15 min after boot (same call the interval pass makes; fail-safe to cherry-only).
- Persistent state: none added; `initialPassPending` is in-memory observability on the existing snapshot route.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added — config-only tuning, and the existing `GET /worktrees/agent-reaper` report is unchanged in shape (one additive field).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard/approval/form files touched; one additive JSON field on an existing observability route).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A worktree estate is a per-machine filesystem artifact; each machine's reaper reclaims only its own disk. No user-facing notices are emitted (housekeeping events go to the existing reaper event listeners/logs), no durable state is held that could strand on topic transfer, and no URLs are generated. The pool-wide "how much disk is reclaimable across machines?" question remains answerable per-machine via the existing route (a merged view is a separate feature, not regressed here).

---

## 8. Rollback cost

Pure code change. Config kill-switch without a release: `{"monitoring": {"agentWorktreeReaper": {"initialPassDelayMs": 0}}}` restores exact legacy scheduling (interval-only). Full rollback: revert the PR, ship next patch. No persistent state, no migrations, no user-visible regression during the rollback window (the feature ships dark; worst case is returning to "reaper never fires", which is the status quo ante).

---

## Conclusion

The review confirms this is a scheduling-only fix to a real, measured never-fires defect, with the deletion authority, safety gates, blast-radius cap, failure breaker, and OFF+dry-run defaults all untouched. The one design question the review surfaced — could the initial pass fire during a busy/fragile boot window — is addressed by the 15-min delay, the unref'd timer (never holds the process open), the `running` re-entrancy guard, and the existing in-use/dirty KEEP gates. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** echo reviewer subagent (independent audit, 2026-07-02)
**Independent read of the artifact: concur**

Concur with the review. Verified against the real diff: (a) the initial pass invokes the identical `reap()` — same KEEP gates, same `killsEnabled` dry-run gate, same `maxReapsPerPass` cap, same per-path breaker, so it cannot delete anything the interval pass could not; (b) the `running` re-entrancy guard returns empty without queuing; (c) double-`start()` is blocked by the `this.timer` guard, `stop()` clears both timers, the fired callback self-clears so `snapshot()` stays honest, and production has exactly one `start()` callsite; (d) the migrator addendum is idempotent via the `initialPassDelayMs` content-sniff, the anchor matches deployed CLAUDE.md byte-for-byte (verified against a live deployment), and anchor drift degrades to an append — no corruption path; (e) `initialPassPending` is additive and backward-compatible at the single `res.json(snapshot())` consumer; (f) config plumbing delivers `initialPassDelayMs` from `.instar/config.json` with no server.ts change, and `0` genuinely restores interval-only scheduling. Reproduced the test evidence: 47/47 green.

---

## Evidence pointers

- `tests/unit/agent-worktree-reaper.test.ts` — 47/47 green (7 new: initial-pass timing, dry-run respected, disabled → no timers, `<=0` rollback lever, stop() cancels, 24h cadence unchanged, snapshot honesty).
- Live incident data: 2026-07-02 topic 30379 — reaper `enabled:true, dryRun:false, lastPassAt:0` with 25 reap-eligible worktrees sitting unreclaimed; server uptime histories show restarts always < 24h apart.
