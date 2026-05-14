# Side-Effects Review — W-4 db-corruption runbook + SemanticMemory.invokeFromRemediator

**Version / slug:** `w4-db-corruption-runbook`
**Date:** `2026-05-13`
**Author:** echo
**Second-pass reviewer:** not required (no outbound-messaging, session-lifecycle, sentinel, or coherence-gate surface)

## Summary of the change

W-4 of the Tier-2 Self-Healing Remediator v2 rollout. Adds `src/remediation/runbooks/db-corruption.ts` — an ApprovedRunbook that lets the Remediator dispatch on structured-provenance SQLITE corruption events and orchestrate the existing SemanticMemory corruption-recovery path through a HMAC-authenticated surface entry point. The surface entry point `SemanticMemory.invokeFromRemediator(ctx)` is added alongside, paired with a small set of helpers (`getDurabilityMode`, `runIntegrityCheckForRemediator`, static registry of active instances). The legacy in-line corruption-recovery path inside `SemanticMemory.open()` (lines 178-243 — integrity_check + probe-read + quarantine + JSONL rebuild) is unchanged and remains the canonical CLI-path safety net. Per A34, the surface this runbook wraps is verified live on main BEFORE this change lands. Per A9, verify asserts both `db.mode === 'durable'` AND `pragma integrity_check === 'ok'` so a future in-memory fallback path would be flagged `verify-failed` rather than passing silently. Files: `src/remediation/runbooks/db-corruption.ts`, `src/memory/SemanticMemory.ts`, `tests/unit/runbooks/db-corruption.test.ts`, `tests/unit/SemanticMemory-invokeFromRemediator.test.ts`, `upgrades/NEXT.md`.

## Decision-point inventory

- `Remediator.dispatch (matched runbook selection)` — pass-through — the new runbook is one more candidate registered alongside W-1; dispatch logic itself is unchanged.
- `db-corruption.eventPrefilter` — add — structured-provenance only (`native-binding | subsystem-explicit | probe-id`); `'free-text'` excluded per §A6.
- `db-corruption.match()` — add — confirms the event is about a SemanticMemory-class store (subsystem in {`semantic-memory`, `memory`, `better-sqlite3`} or reason text mentions `SemanticMemory`).
- `db-corruption.preconditions()` — add — checks that an active `SemanticMemory` instance is registered. If not, returns false → dispatch falls through, no action taken.
- `db-corruption.verify()` — add — durability-aware probe returning `verified-healthy | verify-failed | verify-inconclusive` per §A21.
- `SemanticMemory.invokeFromRemediator()` — add — surface entry point with optional §A3 HMAC verification; on invalid HMAC, refuses orchestrated path (it does NOT silently fall back to in-line, because the in-line path naturally fires on the next `open()` anyway).
- `SemanticMemory.open()` — modify (additive) — sets a `_lastRecoveryRebuilt` flag when the existing rebuild path runs. No behavioral change to the recovery itself.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- Free-text-extracted `SQLITE_CORRUPT` events from logs/stderr (provenance `'free-text'`) will route to `no-matching-runbook` instead of firing the recovery. This is intentional per §A6 — free-text matchers are an injection surface — but it does mean a real corruption event whose only signal is a parsed log line won't auto-heal until SystemReviewer (Tier-3) promotes the signal or a probe is wired. The legacy in-line path inside `open()` still catches everything on next open, so this is a "miss the orchestrated path" not "miss recovery entirely." Acceptable.
- A SemanticMemory instance not explicitly registered via `setActiveInstance()` will see `preconditions()` return false → dispatch is a no-op. This is intentional: partial CLI surfaces (e.g. `instar memory` one-shot commands) shouldn't be targets of Remediator-orchestrated recovery. The server bootstrap is the natural place to register the primary instance.

---

## 2. Under-block

**What failure modes does this still miss?**

- A truly silent in-memory fallback would require a code change in `SemanticMemory` (not currently present); today durability is binary — either we have a real `dbPath` or we don't. If a future change adds `:memory:` fallback without setting `dbPath`, `getDurabilityMode()` correctly returns `'in-memory'` and verify returns `verify-failed`. Until that change lands, the durability-degraded branch is dead code — but harmless, and exists exactly so the runbook is ready when fallback ships.
- The post-recover integrity check runs once at end of `open()`. A corruption introduced after open completes (e.g. mid-write torn page) is caught on the NEXT open or by an A52 probe — not by this surface invocation. Same shape as W-1.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The runbook is a thin orchestration shim: it declares a structured prefilter, narrows with `match()`, gates with `preconditions()`, delegates the actual work to the surface (which owns the recovery), and probes with `verify()`. The surface owns the policy of "how do we recover?" — that's the right separation: orchestration logic stays in `src/remediation/`, recovery logic stays in `src/memory/`. No duplicated logic; the runbook just composes existing primitives. Mirrors the W-1 pattern exactly.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.

The runbook's `eventPrefilter` and `match()` are **detectors** that surface "this event looks like SemanticMemory corruption." They produce structured signals (matched/not-matched). The **authority** is the `Remediator` — it holds the lock, enforces the deadline, signs/verifies the capability ctx, drives the audit log, and decides the final dispatch outcome. The surface (`SemanticMemory.invokeFromRemediator`) is also a downstream consumer of the ctx, not a parallel decision-maker — it can refuse on invalid HMAC, but that's the structurally-correct response to a forged capability token (per §A3), not a brittle filter sitting in front of a smart gate.

`verify()` is similarly a structured probe (durable+ok / corrupt / degraded / inconclusive) — the Remediator decides what to log and whether to count against churn (§A8/§A21).

No new brittle blocking logic introduced.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the in-line corruption-recovery path inside `SemanticMemory.open()` still runs on every open — including the re-open the surface triggers. This is intentional: the orchestrated path delegates back to the in-line logic. There is no race because the surface explicitly `close()`s before re-opening. Per §A2, both paths should acquire the same machine lock; the existing in-line path doesn't yet hold a lock (that's an F-3 / surface-lock workstream beyond W-4 scope), but the Remediator does hold one per dispatch — so concurrent orchestrated dispatches are serialized. Concurrent in-line + orchestrated against the same dbPath remains a known F-3 gap (called out in the spec).
- **Double-fire:** if a SQLITE_CORRUPT event is normalized AND a probe fires AND the in-line path also runs naturally on next open, three signals converge. The Remediator's lock + storm-coalesce prevents double-orchestrated execution. The in-line path is idempotent — running it after the orchestrated heal is a no-op because `_needsRebuild` is only set on integrity_check failure, which has been resolved.
- **Races:** the surface closes its own db handle before re-opening. Concurrent callers using the same `SemanticMemory` instance during recovery would see an `ensureOpen()` throw — same as today's `close()` semantics. The Remediator's lock structurally serializes orchestrated attempts on the same machine.
- **Feedback loops:** none. Recovery emits no new degradation events; the existing quarantine marker file is unchanged.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents:** none. Recovery operates on per-instance `dbPath`.
- **Other users:** none. No public API surface added beyond the runbook export.
- **External systems:** none. No Telegram/Slack/GitHub touchpoints.
- **Persistent state:** the existing `.corrupt.<ts>` quarantine file and `.corrupt-recovery.<ts>.marker.json` continue to be written by the unchanged in-line path. The new `_lastRecoveryRebuilt` is a process-memory flag only — not persisted. The new audit-projection entries (`db-corruption: started → verified-healthy`) ship through the existing AuditWriter, same shape as W-1 entries.
- **Timing:** the recovery path can take seconds to tens of seconds on large JSONL files. Already covered by the existing `autoRebuildMaxBytes` cap in `open()`. The runbook's `expectedRuntimeMs: 60_000` budgets one minute; the Remediator's AbortController enforces it.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. Revert the four touched files and ship as a patch. No persistent state to migrate (the `_lastRecoveryRebuilt` flag is in-memory only; `setActiveInstance` is a process-local registry). No user-visible regression during rollback — the in-line corruption-recovery path still handles everything it handles today. Agents that have run with the new code will simply lose access to the orchestrated path until they update; they retain the safety net.

---

## Conclusion

W-4 lands a small, additive, properly-gated wrapper around an already-proven recovery path. The signal-vs-authority separation is clean: detectors (prefilter + match) feed the Remediator (authority); the surface receives a capability ctx and performs the work but does not gain new decision power. The §A34 surface-alignment precondition is verified: the corruption-recovery code on main is real, not stubbed. The §A9 durability-not-liveness verify is in place, ready for the day a fallback path is added — when that future change lands, this runbook automatically flags it `verify-failed`. Clear to ship.

---

## Second-pass review (if required)

Not required. The change does NOT touch outbound/inbound messaging block/allow, session lifecycle, compaction, coherence gates, sentinels, or watchdogs. It composes existing primitives (Remediator, AuditWriter, MachineLock, SemanticMemory.open) without introducing new authority.

---

## Evidence pointers

- 29 new unit tests pass (`tests/unit/runbooks/db-corruption.test.ts` 17 cases + `tests/unit/SemanticMemory-invokeFromRemediator.test.ts` 12 cases).
- Adjacent tests still pass: `tests/unit/semantic-memory-corruption-recovery.test.ts` (12), `tests/unit/runbooks/node-abi-mismatch.test.ts` (12), `tests/unit/semantic-memory.test.ts`.
- `npx tsc --noEmit` clean.
- Surface alignment verified by `grep -n "quarantineCorruptDb\|nuclear option" src/memory/SemanticMemory.ts` against origin/main HEAD = `3ba88731` — recovery is live on main at lines 178-243, 273-315, 1655-1674.
