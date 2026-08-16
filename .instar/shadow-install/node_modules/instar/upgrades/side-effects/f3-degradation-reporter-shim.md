# Side-Effects Review — F-3: DegradationReporter normalization shim

**Version / slug:** `f3-degradation-reporter-shim`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships the F-3 milestone of the Self-Healing Remediator v2 foundation (per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A5, §A33, §A50): an **additive, back-compat shim** on `DegradationReporter` that introduces the `NormalizedDegradationEvent` contract, a `reportStructured()` go-forward emit API, a `setRemediator()` hook for the future F-8 dispatcher, and a durable `RestartPending` queue at `<stateDir>/remediation/degradations-queue.jsonl` (1000 entries / 5 MiB cap, drop-and-counter on overflow). All ~103 existing legacy `.report(...)` callers continue to work unchanged; they are normalized internally to `provenance: 'free-text'` and (per §A6) cannot match any runbook prefilter — they will route to `no-matching-runbook` once F-8 ships.

A new warning-only lint at `scripts/lint-degradation-emit-sites.js` catalogues every emit site (legacy vs structured) without blocking. F-8 may upgrade it to blocking once a deprecation timeline is agreed.

Files touched:
- `src/monitoring/DegradationReporter.ts` (modify — adds `NormalizedDegradationEvent`, `RemediatorLike`, `reportStructured()`, `setRemediator()`, `_normalize()`, `_setRestartPending()`, `_readRestartPendingQueue()`, `_getQueueDropCount()`, plus durable-queue plumbing)
- `scripts/lint-degradation-emit-sites.js` (new — warning-only)
- `tests/unit/degradation-reporter.test.ts` (extend — 9 new tests for the F-3 shim)
- `upgrades/NEXT.md` (append F-3 entry)

## Decision-point inventory

- `DegradationReporter.report` — **modify** — legacy entry point. New behaviour: routes to Remediator (if wired) OR to RestartPending queue (if flag set) OR to legacy alert path (default). Backward-compat: when no Remediator and no RestartPending, behaviour is byte-identical to pre-F-3.
- `DegradationReporter.reportStructured` — **add** — new emit API for go-forward callers. No legacy alert path — structured callers MUST wire a Remediator (F-8) or their events are recorded-only.
- `DegradationReporter.setRemediator` — **add** — registration hook for the F-8 dispatcher. No consumer wired in this PR.
- `DegradationReporter._setRestartPending` — **add** — supervisor-controlled flag that re-routes events to the durable queue. The flag itself is the authority; no brittle inference logic.
- `DegradationReporter._normalize` — **add** — pure transform from legacy → normalized. Always tags `provenance: 'free-text'`. §A6 already forbids matchers against free-text-provenance events; no new authority is added by the normalization.
- `scripts/lint-degradation-emit-sites.js` — **add** — warning-only catalogue. Exits 0 always.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- The change has no block/allow surface on the emit path itself — legacy `.report()` still always succeeds in recording an event. The only "rejection" is the queue cap: events emitted during RestartPending past entry 1000 or byte 5 MiB are silently dropped and counted. That's per spec §A5 (drop-and-counter on overflow) and is by design: the alternative (unbounded queue growth during a long restart-pending window) is worse. Operators see the loss via `_getQueueDropCount()` and the sidecar file `degradations-queue.jsonl.drops.json`.
- `reportStructured()` does NOT fall through to the legacy alert path. Structured callers without a wired Remediator will see their events recorded but not alerted. This is intentional per §A33: legacy alert side-channel is for legacy callers; structured callers belong to the Remediator path.

---

## 2. Under-block

**What failure modes does this still miss?**

- Legacy callers continue to land at `no-matching-runbook` because their provenance is `free-text` — per §A6 this is the intended steady state, not a gap. The under-block here is exactly what NovelFailureReviewer (A26 — not in this PR) is designed to consume: cluster the unmatched events and propose new runbooks.
- The `_normalize` errorCode extraction inherits the F-2 free-text regex set. Novel error-text shapes return `LEGACY_DEGRADATION` rather than a more specific code; NovelFailureReviewer (later PR) is the smart layer that proposes new runbooks for those.
- RestartPending replay does NOT enforce the §A30 5-second wall-time cap or coalescing logic — that authority belongs to the F-8 Remediator dispatcher, which sees the replayed events one by one. F-3 only provides the durable surface.
- The queue file is per-machine and not synced. If a machine restart-pending-windows and the agent's state-dir is on a different machine after rebalancing, the queue is lost. Acceptable: RestartPending is a process-lifetime concept tied to the lifeline supervisor that owns the file.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

`DegradationReporter` is the right layer for the shim. It's the single emit point for every degradation in the codebase; placing the normalize/dispatch wiring elsewhere would require touching all ~103 emit sites today instead of zero. The shim preserves the legacy emit API exactly and lets the migration be incremental — which is the precise intent of §A33 / §A50.

The RestartPending queue lives inside `DegradationReporter` rather than a separate `RestartPendingQueue` module because (a) only this reporter feeds it, (b) the durability story is local to the reporter's stateDir, and (c) F-8 will own the higher-layer replay scheduler. Pulling it out to its own module now would over-fit; pulling it out later if F-8 needs cross-reporter queue management is a refactor with no behaviour change.

The lint is at the right layer (a repo-level grep), produces a single warning-only signal, and explicitly defers authority to F-8 — that matches signal-vs-authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The shim is a routing change, not a decision point. `_normalize()` is a pure transform. `setRemediator()` is a registration hook. `_setRestartPending()` is set by the lifeline supervisor (the higher-layer authority), not inferred by the reporter. The lint script is warning-only and exits 0 always. The §A6 free-text provenance contract IS an authority — refusing runbook matchers — but that authority lives in the runbook registry validator (F-8), not here. F-3 only stamps the provenance; F-8's smart gate enforces the refusal.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The existing legacy alert path (`reportEvent`) still runs when no Remediator is wired. When a Remediator IS wired, the legacy alert path is BYPASSED for new events — that's the point of A33's "the legacy Telegram-alert path fires only on `no-matching-runbook`." F-3 wires the bypass; F-8 wires the round-trip back to `no-matching-runbook → legacy alert`.
- **Self-heal interaction:** The existing `registerHealer` / `attemptSelfHeal` flow runs inside `reportEvent`. When a Remediator IS wired, healers are NOT invoked — the Remediator is expected to own the heal-or-alert decision. This is acceptable for the F-3 PR because no Remediator is wired today; healers continue to run on every emit. F-8's design must explicitly cover healer composition with runbooks (it does — A50 places healer-vs-runbook precedence on the Remediator side).
- **Persistence:** The legacy `degradations.json` file continues to receive every event for the health-check API. The new queue file (`remediation/degradations-queue.jsonl`) is independent — events under RestartPending are recorded in both. No double-dispatch risk: queued events flow through replay → dispatch, never through the legacy alert path twice.
- **Drop-counter sidecar:** `degradations-queue.jsonl.drops.json` is the only new file outside the reporter's `degradations.json`. Backup/sync rules (per A35): the queue lives under `.instar/remediation/` which F-7 will add to `BackupManager`'s exclusion list (per-machine). No backup-sync changes ship in this PR.

---

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

- **Behavioural surface:** Zero change for current users. No Remediator is wired in F-3, so every legacy `.report()` call follows the same code path it did pre-F-3. No new files exist on disk until F-8 sets RestartPending, which it cannot yet.
- **Type surface:** `NormalizedDegradationEvent` and `RemediatorLike` are exported from `src/monitoring/DegradationReporter.ts`. They are additive — existing consumers' imports remain valid. The exported `DegradationEvent` shape is unchanged.
- **CLI / config / endpoint surface:** None changed.
- **Tests:** 9 new unit tests under the existing file. No changes to existing tests.
- **Lint behaviour:** The new lint script is not wired into any existing gate (pre-commit / pre-push / CI). It is a documented manual command per §A33: `node scripts/lint-degradation-emit-sites.js`. Adding it to CI is explicitly deferred to F-8.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Revert path:** This is a single-PR shim with no consumer (no Remediator wired anywhere). A `git revert <merge-commit>` followed by a patch release rolls back the entire change with no data migration. The `degradations.json` file (legacy) is untouched.
- **Stuck-state risk:** If F-8 ships partial Remediator wiring and is reverted, any events accumulated in `<stateDir>/remediation/degradations-queue.jsonl` during a RestartPending window would be orphaned. Mitigation: F-3 has no way to set RestartPending (no caller wires it), so the queue file cannot be populated until F-8 ships. F-8's own rollback story must include a queue-drain step.
- **Compat risk for downstream consumers:** Code outside this PR that imports `DegradationEvent` continues to compile unchanged. Code that imports the new `NormalizedDegradationEvent` would need to bridge to the legacy type — but no such code exists in this PR or on main today.
- **Worst-case incident:** A bug in `_normalize` could break the legacy `.report()` path. The integration test for "with no remediator set, legacy alert path runs unchanged" catches the obvious regression; a more exotic bug (e.g. Redactor crash) would be caught by the existing legacy tests because `_normalize` is invoked in every `.report()` call. If it slipped through, the back-out is a one-line revert in the `report()` method to skip the normalize-and-route block.
