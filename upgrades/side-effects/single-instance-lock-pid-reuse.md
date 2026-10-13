# Side-Effects Review — single-instance lock identifies the holder by start time, not pid alone

**Version / slug:** `single-instance-lock-pid-reuse`
**Date:** `2026-10-12`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent — concern raised, resolved; see the second-pass section`

## Summary of the change

`SingleInstanceLock` decided whether the recorded lock holder was still running from the pid alone (`pidAlive()` → `process.kill(pid, 0)`). A pid is not an identity on a host that recycles pids quickly: Justin's laptop wraps the whole pid space every 5–11 minutes (tracked as CMT-665), so after the holder died its pid kept being re-issued to unrelated live processes, the lock read LIVE indefinitely, and the server refused to boot until a spawn happened to land in a window where that pid was free. The lock record now also carries the holder's absolute process start time (`startedAt`, ms epoch, 1s resolution, from `ps -o lstart=`). A candidate pid whose observed start POSTDATES the record by more than the skew (`PID_START_MISMATCH_MS`, which reuses the host test-runner semaphore's `START_TIME_SKEW_MS` = 120s) is provably a different process and the lock is reclaimed. The test is one-sided and the start-time read is the repo's existing shared primitive (`gatherPidEvidence` / `selfProcessFingerprint` in `hostTestRunnerSemaphore.ts`), both changes made on the second-pass reviewer's findings. Files touched: `src/core/SingleInstanceLock.ts` (the liveness decision) and `src/lifeline/ServerSupervisor.ts` (the spawned server's stderr capture switched from a truncating `tee` to `tee -a`; past a 4 MB cap the newest 512 KB is kept rather than the file being emptied, and the crash-output reader takes a bounded tail instead of reading the whole file).

Measured on `inspec` (monroe-workspace, laptop) 2026-10-12: 42 consecutive `spawns failed before binding` (48 by the time this was written), ~3.5h dark that day and ~35h dark over the preceding weekend, ending when a boot finally logged `reclaimed a stale same-host lock (dead pid 86892)`.

## Decision-point inventory

- `SingleInstanceLock.acquire()` — **modify** — the same-host "is the holder alive?" branch now consults `holderIsLive()` instead of `pidAlive()` directly.
- `SingleInstanceLock.acquire()` single-host-rename auto-heal — **modify** — its `holderDead` input uses the same `holderIsLive()`, so a reused pid is seen as dead there too.
- `ServerSupervisor.spawnServer()` crash-log capture — **modify** — no decision surface; an observability change only.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Over-block here means refusing a *legitimate start*, which is the failure this change removes rather than adds. The change can only ever move a verdict from "refuse" to "acquire", never the reverse: `holderIsLive()` returns `false` strictly more often than `pidAlive()` did, and a `false` means "the lock is stale, take it".

A record with a matching start time refuses exactly as before; a record with no start time refuses exactly as before; an unreadable candidate start time refuses exactly as before.

One narrow path changes its *reason*, not its outcome (second-pass finding): a live pid whose start postdates the record on a state dir that `df -P` cannot confirm host-local now returns `foreign-host-conflict` immediately, where before it would have cycled the handoff-grace loop and returned `duplicate-live-instance`. Both are refusals; the input is a state dir the lock refuses to reclaim in every case anyway. Stated here because the first draft of this review claimed "no new refusal path", which was not precisely true.

---

## 2. Under-block

**What failure modes does this still miss?**

- **A pid reused within the 120s skew of the original holder's start.** If the holder died and its pid was re-issued to a process that started within two minutes *after* the holder's own start, the lock still reads LIVE. On a host wrapping the pid space every 5–11 minutes that is a coincidence, and the skew is deliberately as wide as the repo's existing precedent because the opposite error (declaring a live holder dead on a clock step) is worse. A candidate that reads as started *earlier* than the record is never treated as a different process — that direction has no detection value and is the only one that could evict a genuine holder.
- **A lock written by an older build.** Until an agent restarts once on the fixed version its record has no `startedAt`, so the original wedge is still reachable on that one boot. Self-clearing — the first successful boot on the new code writes the field.
- **A host where `ps` is unavailable or slow.** Every read failure falls back to the pid-only verdict, so the wedge remains reachable there. The probe is memoized per `acquire()` (a process's start time is immutable), so a slow `ps` costs one bounded 3s read per boot, not one per poll of the handoff-grace loop. No host in the fleet is in that state, and failing the other way would weaken the duplicate guard on every host to protect a hypothetical one.
- **The wedge's siblings.** A server that dies before binding for a reason *other* than the lock (a corrupt native module, a genuinely held port) is untouched by this change. The supervisor already distinguishes the native-module case; the appended crash log is what makes the remaining cases diagnosable.

---

## 3. Level-of-abstraction fit

This is a detector at the right layer. "Is this recorded pid still the process that recorded it?" is a local, cheap, deterministic question about operating-system state, and it belongs in the lock that asks it — not in a higher gate, which has no better information and would only add latency to a boot path.

It does not re-implement an existing primitive — though the first draft did. `isAlive()` (from `ProjectRoundLock`) answers "does this pid exist", which is still the first half of the question and is still used. For the second half the second-pass reviewer pointed out that `hostTestRunnerSemaphore.ts` already reads pid start times for exactly this corroboration (`gatherPidEvidence()` → `ps -o lstart=` + `Date.parse`, and `selfProcessFingerprint()` for the holder's own start), with a one-sided `startMs > acquiredAt + START_TIME_SKEW_MS` test. The first draft had built a parallel `etime`-based reader that was two-sided, `now`-relative and 10s-tolerant — less safe on all three axes. The shipped version imports the existing primitives, so there is one start-time reader in the repo and both call sites share its semantics.

The one layer question worth naming: the lock's `heartbeat` field *could* have carried this instead — a stale heartbeat would also expose a dead holder. It cannot, because nothing refreshes it. `SingleInstanceLock.heartbeat()` has no caller in `src/`, so the recorded heartbeat is the acquire time and never advances; treating it as a liveness signal would declare every long-lived holder dead. Wiring a refresher would be a larger change with a worse failure mode (a stalled-but-live server losing its lock), so start time is the correct carrier.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is deterministic by design: this is a safety guard on an irreversible action (starting a second server), where a static, fully-enumerable rule is the correct shape.
- [ ] ⚠️ Yes, with brittle logic.

The lock holds blocking authority — that is its whole purpose, and this change does not extend it. The question signal-vs-authority exists to catch is a *brittle* check holding block authority: a heuristic that can be wrong in unenumerable ways while refusing real work. The pre-existing check was exactly that, and this change makes it *less* brittle by adding the missing discriminator. The authority is unchanged; the evidence behind it improves. Every uncertain input degrades to the prior verdict rather than inventing a new one, and the only direction that could evict a live holder (an observed start *earlier* than the record, which a wall-clock step can produce) is not tested at all, so the change adds no new way for the guard to be wrong.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is the recorded holder still running?" is an invariant with an enumerable answer (the process either is or is not the one that wrote the record), not a judgement among competing live signals. The 10s tolerance is a measurement-noise allowance on a single signal, not a weighting between signals. The surrounding decision — whether to start a second server — remains a deterministic safety guard on an irreversible action, which the standard explicitly admits as non-judgement.

---

## 5. Interactions

- **Shadowing:** `holderIsLive()` runs where `pidAlive()` ran, in both the same-host branch and the rename auto-heal's `holderDead`. It shadows nothing: `pidAlive()` is still called first and short-circuits, so a genuinely absent pid never reaches the start-time probe.
- **Double-fire:** none. The lock is acquired once per server boot; the probe runs at most once per `acquire()` loop iteration, and only when a pid is alive and the record carries a start time.
- **Races:** the probe reads operating-system state, not shared files. A process that exits between `pidAlive()` and the `ps` read yields `null`, which keeps the prior verdict — a race resolves conservatively rather than reclaiming on a flicker. The existing `O_CREAT|O_EXCL` write and pid-guarded `release()` are untouched, so the reclaim path's atomicity is unchanged.
- **Feedback loops:** none. The lock's output does not feed anything that feeds the lock.
- **The crash-log change** interacts with the supervisor's restart loop by design: more spawns now mean a longer file rather than a replaced one. The 4 MB cap is evaluated before each spawn (the only spawn site is `spawnServer()`), so it bounds a *crash loop*; it does not bound a single long-lived server writing steadily to stderr between spawns — that file can grow until the next spawn, which is the same exposure the truncating version had within one server's lifetime. When the cap trims, the newest 512 KB is kept, so the evidence a loop has just produced survives the trim.

---

## 6. External surfaces

- **Other agents on the same machine:** unaffected — the lock is per-agent (`<stateDir>/local/server-instance.lock`).
- **Other users of the install base:** the only visible change is that an agent whose previous server died restarts on the next supervisor attempt instead of waiting for a free pid. No new setting, no new message, no new route.
- **External systems:** none.
- **Persistent state:** the lock file gains one optional numeric field. Old code reading a new file ignores it; new code reading an old file treats it as absent. No migration, no cleanup.
- **Timing / runtime conditions:** the change depends on `ps -p <pid> -o etime=` being available and answering within 3s. Both macOS and Linux provide it; a failure degrades to the prior behaviour.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions — this is a boot-path library with no route, form or approval.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page, or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, and the design is load-bearing rather than incidental: the lock answers "is another copy of this agent running *on this host*", and the record is explicitly refused when its `hostname` is foreign (a shared state dir across hosts is an unsupported configuration this code exists to refuse loudly). A pid is only meaningful on the host that issued it, so a start time compared across hosts would be meaningless — the comparison is correctly reachable only after the hostname check has established the record is this host's.

The single-host-rename auto-heal is the one path where a "foreign" record is treated as local, and it still fails closed on every unmet condition. Said plainly rather than as four independent protections: its `hbStale` term is vacuous for any holder older than `staleHostRenameMs`, because (as §3 establishes) nothing refreshes the heartbeat — so after this change its liveness evidence is the start-time-corroborated pid check, and the `df -P` host-local confirmation is the load-bearing guard against a shared volume.

- **User-facing notices:** none emitted — no one-voice gating needed.
- **Durable state:** the lock file is machine-local and intentionally not replicated; it does not strand on topic transfer because it is not bound to a topic.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** revert the two files and ship as the next patch. Nothing else to undo.
- **Data migration:** none. A lock file written by this build is read correctly by the reverted code, which ignores the extra field; a lock file written by the reverted code is read correctly by this build as "no start time".
- **Agent state repair:** none. No agent needs notifying or resetting.
- **User visibility:** during a rollback window an agent whose previous server died returns to waiting for a free pid — i.e. the current behaviour. No new regression is introduced by reverting; the old one returns.

---

## Conclusion

The review changed the design — the second pass found that the first draft's start-time comparison was two-sided, `now`-relative and tolerant only to 10s, and that the repo already carried a safer one-sided `lstart`-based reader; the shipped version reuses that reader and its 120s skew, memoizes the probe per acquire, and keeps the newest slice of the crash log instead of emptying it. Two further things were sharpened. First, the direction of error: the only dangerous outcome is declaring a *live* holder dead, so every uncertain input (no recorded start time, unreadable candidate start time, a process that vanishes mid-probe) deliberately keeps the old pid-only verdict, and the tolerance is set an order of magnitude wider than real measurement jitter. Second, the heartbeat alternative was considered and rejected on evidence rather than taste — `SingleInstanceLock.heartbeat()` has no caller in `src/`, so the field never advances and could not carry liveness without a separate refresher whose own failure mode (a busy-but-live server losing its lock) is worse than the bug being fixed.

Flagged for follow-up, not resolved here: the operator was never told the agent was dark. The lifeline counted 323 suppressed "server is down" notifications across this outage, which is the same gap as CMT-663 (an agent that never finishes launching produces nothing, so every health surface is silent rather than wrong). That is tracked as its own item and is deliberately not bundled into this fix.

Clear to ship once the second-pass review concurs.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Phase 5), 2026-10-12
**Independent read of the artifact: concern raised — resolved before commit**

Blocking findings and their resolutions:
- Two-sided drift test could evict a live holder on a backward-reading start → made one-sided (`observed - startedAt > skew` only).
- `now`-relative `etime` derivation moves with a wall-clock step on Linux between write and probe → replaced by absolute `ps -o lstart=` on both sides via the existing shared primitive; skew widened to the repo's `START_TIME_SKEW_MS` (120s).
- §3 claimed no existing start-time helper; `gatherPidEvidence()` / `selfProcessFingerprint()` already existed → reused; §3 corrected.

Should-fix findings and their resolutions:
- Inconsistent clock between write (`Date.now()`) and read (`this.now()`) → both sides now read the same `ps lstart` value; no `now` arithmetic remains in the comparison.
- The self-consistency test was calibrated to the guard's own tolerance → tightened to the 1s `lstart` resolution, and a defaults-only round trip (real write, real read, no overrides) added.
- §1 "no new refusal path" was not precisely true → corrected (reason-string change on a not-host-local state dir).
- One `ps` per poll of the handoff loop → memoized per `acquire()`; a test asserts one probe.
- 4 MB cap truncated to zero → keeps the newest 512 KB; the crash-output reader now takes a bounded tail instead of reading the whole file.

Minor: `parseEtimeMs` leniency — moot, the function was removed with the `etime` design. §7 `hbStale` overstatement — reworded.

Verified as claimed by the reviewer's own checks: `SingleInstanceLock.heartbeat()` has no caller in `src/`; all three conservative fallbacks are real in the code; no consumer pattern-scans the whole crash log.

---

## Evidence pointers

- `logs/lifeline-launchd.log` (monroe-workspace, laptop) — the `Bind-failure escalation armed: N consecutive spawns failed before binding` ladder, 42 → 48.
- `logs/server-stderr.log` (same) — three lines from an unrelated earlier boot, which is the truncation defect in one observation.
- The boot that recovered: `[single-instance] reclaimed a stale same-host lock (dead pid 86892)`.
- `.instar/logs/activity-2026-10-*.jsonl` `scheduler_start` events — the outage windows (Oct 10 22:06 PDT → Oct 12 08:53 PDT, and Oct 12 12:58 → 16:30 PDT).
- `tests/unit/single-instance-lock.test.ts` (26 tests), `tests/unit/supervisor-crashlog-append.test.ts` (4 tests).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `novel` is not claimed; this is an instance of **identity-by-unstable-handle**: a decision that treats a reusable operating-system handle (a pid) as a stable identity. Registered as `closure: gap` below because no class-level guard yet refuses that pattern repo-wide.
- **`closure`** — `gap`
- **`gap`** — ACT-095 (`SingleInstanceLock decides holder liveness by PID alone — PID reuse wedges an agent dark for hours`), which also carries the two sibling defects found in the same incident: the operator receiving no notice across a 35h dark window, and the truncating crash log. The class-level guard (a lint refusing a bare `pidAlive`-style check as an identity test, where a start-time or boot-id discriminator is available) is out of this fix's scope and is tracked there.
- **`guardEvidence`** — not applicable at `closure: gap`. The two ratchets added here (`tests/unit/single-instance-lock.test.ts`, `tests/unit/supervisor-crashlog-append.test.ts`) pin *this* instance against regression but do not make the class structurally unreachable, which is why this is honestly a gap and not a guard.
