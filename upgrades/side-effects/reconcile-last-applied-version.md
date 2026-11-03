# Side-Effects Review — reconcile stale lastAppliedVersion (#2282)

**Version / slug:** `reconcile-last-applied-version`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end of this file)`

## Summary of the change

Tier 1. 2 runtime/test files (+182/-2) from the first commit, plus this review, its overview, one release note, and 2 docs pages (+10). `src/core/AutoUpdater.ts` advances `lastAppliedVersion` forward to the running version on the no-update path of `tick()`, and records and restarts toward `result.newVersion` in `applyPendingUpdate()` when that is newer than the pending target. A small private `isNewerVersion()` helper backs both. `site/src/content/docs/features/secure-agent-pairing.md` and `site/src/content/docs/architecture/under-the-hood.md` gain sections on `MobilePeople` and `MobileMspGrants`; this is the same text as open PR #2666 and repairs the Docs Coverage class floor (54.47% rounds to 54, floor 55) that PR #2663 lowered. Proportion: one commit attempt on this layer of work at the time of writing; no spec review rounds, as Tier 1.

## Decision-point inventory

- Auto-updater loop breaker (`lastAppliedVersion === info.latestVersion` in `tick()`) — pass-through — its input is now more accurate; the comparison is unchanged.
- Strand detection (`shadowVersion !== lastAppliedVersion` in `tick()`) — pass-through — same input change.
- `CoherenceMonitor` version-mismatch check (`lastAppliedVersion === integrity.diskVersion`) — pass-through — same input change.
- `gatedRestart` target version — modify — receives the really installed version when it is newer than the pending target.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface. Remaining gaps in the record: while an update is available the reconcile does not run, so a stale record persists until the agent reaches latest. A `null` record stays `null` by design, even on an agent that did receive an update by another route, because `null` means "never applied" to its readers. It does not identify which restart path on the affected agent skipped the write.

---

## 3. Level-of-abstraction fit

Right layer. `AutoUpdater` is the sole writer of this record, and `tick()` already owns the no-update bookkeeping (clearing `pendingUpdate`) that made the record permanently stale. `isNewerVersion` duplicates the private `UpdateChecker.isNewer` (same regex and semantics). It is kept private rather than widening `UpdateChecker`'s interface for one call.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

It updates a state record and picks a restart target. It adds no block, gate or filter.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Newer semver" is an enumerable comparison.

---

## 5. Interactions

- **Shadowing:** none. The reconcile runs on the no-update branch, and the loop breaker runs after that branch returns, so one tick reaches only one of them.
- **Double-fire:** none. The reconcile adds a log line only, no notification and no restart.
- **Races:** `tick()` returns early while `isApplying`, so the reconcile cannot interleave with an apply. `saveState()` already runs at the end of the no-update branch and persists it.
- **Feedback loops:** the loop breaker is the one to check. Recording the newer version makes it match the build on disk, which is stricter against re-applying, not looser. `CoherenceMonitor` reads `passed` for "restart pending" when the record equals the disk version; recording what was really installed makes that message true in the newer-build case, where before it would have flagged a mismatch. On the no-update path, the record moves to the running version, which only equals a differing disk version if the disk went backwards. A rollback leaves running older than the record, so it is not reconciled.
- **Restart cooldown and dampener:** `gatedRestart` keys both on the version it receives. Passing the real version means a later request for that same version is treated as a retry rather than a new version, which is correct.

---

## 6. External surfaces

`lastAppliedVersion` is visible in `GET /health` and `GET /updates/status` (`src/server/routes.ts`) and the `state/auto-updater.json` file; both now show a truer value. No other agents, channels or external systems are touched. Docs site gains two sections. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — the record describes which build this machine's install is on, and each machine updates its own install. No user-facing notice, no replicated state, no generated URL.

---

## 8. Rollback cost

A plain revert and a patch release. No migration. Any record already advanced stays correct, and the old code does not read it differently.

---

## Second-pass review

Concur with the review. An independent reviewer traced `getInstalledVersion()` (caches the version the process booted with, so the reconcile compares the running version), the forward-only direction, the loop breaker and strand detection order, and the `gatedRestart` keys (cooldown, dampener, deferral). It found no restart loop, suppressed update or hidden mismatch, and no unsupported claim in this artifact. It also noted that keying the deferral on the newer version removes a stale-deferral case that existed before.
