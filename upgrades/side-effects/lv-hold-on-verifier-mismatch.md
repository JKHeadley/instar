# Side-Effects Review — a verifier changed on disk holds the local-verify queue for the restart instead of erroring every entry

**Version / slug:** `lv-hold-on-verifier-mismatch`
**Date:** `2026-10-24`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (small, reversible): 2 source files (`src/localVerify/LocalVerifyService.ts`, `src/localVerify/localVerifyWiring.ts`), 2 test files, ~90 LOC of source. Effort: one build round, one commit attempt.

When the auto-updater installs a new instar version it replaces the package files on disk and restarts the server ~60 s later. In that window the OLD `LocalVerifyService` keeps starting runs; each run child (`runVerifyMain.js`) recomputes the verifier version from the NEW files, finds it differs from the server's, and refuses (`kind: 'crash', detail: 'verifier-mismatch: …'`). The service treated that refusal as the entry's own crash: `syntheticError(entry, 'verifier-mismatch')` → journal record → `error-auto-retry` → second refusal → second record → next entry. The whole queue burned in ~1 s three times on 2026-10-24 (audit log: 00:12:52Z — 9 PRs, 18 run-errors; 10:36:40Z — 4 PRs; 2026-10-25T02:59:55Z — 10 PRs; each burst also hit the `main` entry, inferred from a 46 ms `run-error kind:main … errorStep:crash` at the same instant — the old main branch never classified the detail), every record dequeued its entry, and the next boot restored nothing (`queue-restored restored:0` at 03:01:50Z). The bogus records were also posted to GitHub by the status reconciler as 21 `failure` statuses. Every PR had to be re-requested by hand, on every release touching the verifier's import graph.

The fix, in `onExit`: `isVerifierMismatch(result)` is handled BEFORE the main/crash branches for PR and `main` entries alike — the entry goes back to the head of the queue with `attempts` decremented (not an attempt, exactly as `shutdown()` does), no record is written, no error retry is counted, and `enterVerifierHold('run')` sets an in-memory `verifierHold` with one `verifier-changed` audit event. `pump()` returns while held (alongside `blockedBy` / `mergeHold` / the rule-(b) pause). Before any start, `verifierChangedOnDisk()` asks a new optional seam `installedVerifierVersion()` (wired to the same `computeVerifierVersion(path.dirname(mainEntry), …)` the config's version came from) and enters the hold without spawning when the files already differ; `null`/throw ⇒ unknown ⇒ no hold (the child's check still decides). `tick()` re-checks a hold: files that compute the server's version again release it (`verifier-hold-released`); a hold ≥ 15 min (`VERIFIER_HOLD_SIGNAL_MS`) raises ONE `local-verify:verifier-hold` signal (`verifier-hold-overdue`). `snapshot()` carries `verifierHold`. The hold is never persisted: the next boot computes its version from the new files and the untouched `queue.json` resumes in order.

## Decision-point inventory

- `LocalVerifyService.onExit` crash classification — **modify** — a `verifier-mismatch` crash is a hold-and-requeue, no longer an error record + auto-retry; every other crash/invalid result is unchanged.
- `LocalVerifyService.pump` start admission — **modify** — one more reason not to start (`verifierHold`), plus the pre-start `verifierChangedOnDisk()` check; the ordering of the existing refusals is unchanged.
- `LocalVerifyService.tick` — **modify** — recheck/release/overdue-signal of the hold; signal-only.
- `verifier-changed` / `verifier-hold-released` / `verifier-hold-overdue` audit events, `local-verify:verifier-hold` attention signal — **add** — observability, no authority.
- `runVerifyMain.checkVerifierVersion` (the child's refusal) — **pass-through** — unchanged; still the authority on whether a run may produce a record.

---

## 1. Over-block

The hold stops verifies from starting. It is entered on exactly two inputs: a child's `verifier-mismatch` refusal (which already produced no usable run) or the on-disk files computing a different version than the server's (a child would refuse anyway). The only "over-block" is a mismatch that would have cleared on its own without a restart — e.g. the ambient-TypeScript flip PR #2339 removes, where the hash changed with an unrelated `node_modules`: before this change such a flip burned the queue; now it holds, and the tick releases the hold as soon as the files match again. A hold with no restart coming is bounded by visibility, not time: the 15-min overdue signal names it; it does not self-expire (the alternative — resuming into guaranteed refusals — is the incident). An explicit `POST /local-verify` while held still queues (behind the held entries) and returns `queued`; nothing is refused at request time.

---

## 2. Under-block

- A verifier change the hash does not see (a dependency outside the import graph) is outside this fix as it was before: the child runs on the new code and records under the old version. Unchanged scope.
- The pre-start check runs in the server process over the OLD in-memory `computePolicyHash()`; a release that changes ONLY `policy.ts`'s computed value without changing any file byte is theoretically missed by the precheck — but `policy.js` is itself in the hashed import graph (`VERIFIER_ROOTS`), so any such change alters the file hash. The child's own check still runs after the precheck regardless.
- If `installedVerifierVersion` throws mid-replacement (a file briefly absent during `npm install`) the precheck says unknown and spawns; the child refuses; the run-path hold then catches it. One wasted spawn, no record, no cascade.
- A run that was ALREADY past its version check when the files changed runs the new code to completion and records under the server's version (as before this change; the window is the child's startup, ~100 ms).

---

## 3. Level-of-abstraction fit

Right layer. The service already owns three "do not start now" states (orphan `blockedBy`, `mergeHold`, the rule-(b) update pause) and the shutdown re-queue-at-head idiom; the hold reuses those shapes rather than adding a new mechanism elsewhere (AutoUpdater, child, routes). The child's refusal stays the authority on record integrity; the service merely stops misreading the refusal as the entry's failure. A lower-level fix (making the child "succeed" on a mismatch) would corrupt record provenance; a higher-level one (having the AutoUpdater stop the service before installing) would still leave the already-spawned child racing the install.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over agent behavior or information flow.
- [x] No — the new attention signal is a signal consumed by the existing deduped attention path.

The hold gates only the service's OWN spawning of its OWN verify children (a self-action it already paces by orphan/merge/update holds); it decides nothing about a PR's mergeability, a message, or a session. It is deterministic on a deterministic input (two hashes differ) and reversible by restart or by the files matching again.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "The files on disk compute a different verifier version than this process" is an enumerable invariant (the record-provenance rule the child already enforces); the only reaction is to wait for the restart, and the 15-min threshold decides a notification, not an action.

---

## 5. Interactions

- **Shadowing:** `isVerifierMismatch` is tested before the `main` branch and the generic crash branch in `onExit`, so a mismatch never reaches `completeMain` / `complete` / `handleErrorRetry`. All other results take exactly the paths they took. In `pump`, the hold check sits after the existing early returns and the precheck after the foreign-holder wait (so a capacity wait is still audited as before and the precheck runs only when a start is imminent).
- **Double-fire:** `enterVerifierHold` is idempotent while a hold is open (first call wins; one audit event and at most one overdue signal PER HOLD — a hold released by matching files, or a later release in a long-lived process, can open a new hold with its own event). A mismatch result arriving while a precheck hold is already set re-queues the entry and adds no second event.
- **AutoUpdater restart:** `restartHolds()` reports only an in-flight run, so a held service (nothing in flight) never delays the restart that ends the hold.
- **Races:** the hold is set synchronously in `onExit` before `pump()`; `refreshBaseThenPump` ends in `pump()`, which honours the hold. `shutdown()` still re-queues an in-flight entry at the head; after a mismatch there is no in-flight entry, so the two never both touch the same entry. `persistQueue()` writes the re-queued entry (attempts decremented) on the following `pump()`.
- **Feedback loops:** none — the hold REMOVES a loop (the refusal → record → retry → refusal → next-entry cascade). The release path depends only on the files on disk.
- **Rule-(b) update pause:** independent and complementary: rule (b) pauses while an update is PENDING (before install); this holds after the install LANDED. Both can be true; either suffices to stop starts.

---

## 6. External surfaces

`GET /local-verify` gains `verifierHold` (`null` or `{since, detail, where}`); existing fields unchanged (the e2e asserts `verifierHold: null` beside the old shape). Three new audit events in `logs/local-verify.jsonl`; one new attention key `local-verify:verifier-hold` (routed MEDIUM by the existing server hook). A GitHub write is REMOVED: the old path's error records were posted by the status reconciler as `failure` statuses on the PR heads (21 across the three bursts); a hold produces no record and therefore no status. No new GitHub write, no config key, no dashboard change, no operator action — "No operator-facing actions." Timing: the restart that clears the hold belongs to the AutoUpdater; a manual `npm install` under a running server with no restart would show the hold and, after 15 min, the signal.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the local verifier runs on the machine whose files were replaced, against that machine's own queue (`state/local-verify/queue.json`, machine-local) and its own installed dist; the hold describes THAT machine's disk versus THAT process. The verify queue was already machine-local (the status reconciler, not the queue, is what the lease governs). The one user-facing emission is the deduped attention signal, which rides the same per-machine `signal` hook as `local-verify:main-red`; no durable state is added (the hold is in memory), no URLs are generated.

---

## 8. Rollback cost

Revert the commit and ship a patch. No persistent state (the hold is in-memory; `queue.json` and the journal keep their existing shapes), no migration, no agent state. Reverting restores the cascade, so the rollback itself re-creates the incident on the next verifier-touching release.

---

## Conclusion

A deliberate child-side refusal was being read as a per-entry failure, and the retry machinery turned one release into an emptied queue. The fix names the refusal, re-queues without counting, holds for the restart the refusal already implies, and keeps the hold visible (snapshot, audit, one overdue signal) and self-releasing when the files match again. Every other crash path is byte-for-byte the same. The 10 new unit tests all fail on the previous service code. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude), 2026-10-24
**Independent read of the artifact: concur**

The reviewer read the diff and the service independently (77/77 unit tests in the worktree) and confirmed: `onExit` orders cancelled → mismatch → `main` → crash → requeue → success, so a mismatch reaches no `complete`/`completeMain`/`handleErrorRetry`/journal/`onRecord` — and, with no record, `offerMerge` is unreachable, so the change cannot produce an unintended merge; the attempts idiom matches `shutdown()` and `decideVerifyRetry('requeue')`, `errorRetries` untouched, and re-queuing a `main` entry is harmless (`persistQueue` excludes `main`; the next boot re-enqueues it via `noteMainHead`); the only road to `start()` is `pump()`, which early-returns on the hold, and `refreshBaseThenPump` ends in `pump()`; nothing but a matching on-disk version or a new process clears the hold; `queue.json`'s shape is unchanged and no restore-drop reason applies; the precheck's `?.() ?? null` + try/catch means unknown never holds, the wiring passes the identical arguments the config's version was computed with (both in-process `process.version`/`computePolicyHash()`), so a healthy boot cannot self-hold, at a measured 4.5 ms per call over the built dist; `restartHolds()` reports only an in-flight run, so a held service never delays the restart that ends the hold; the signal is latched, optional and non-blocking, and the change gates only the service's own spawns on a deterministic hash equality. Six factual corrections were raised and applied above: the burst sizes (9 / 4 / 10 PRs, not 2 / 2 / 10), the record count (46 audit events; the journal keeps 14 today), the `main` involvement being inferred from timing (the old main branch recorded `errorStep:crash`), "one audit event per process" → one per hold, the removed GitHub `failure`-status write (21 statuses), and a wrong timestamp (01:23:48Z) in the test header.

---

## Evidence pointers

- `tests/unit/localVerify/LocalVerifyService.test.ts` — "verifier changed on disk" (10 cases: classifier both sides; re-queue at head with attempts/errorRetries unchanged + nothing starts across ticks and requests + one audit event + durable queue intact; no record/journal; restart restores and runs in order on the new version; `main` entry same handling with main health untouched; precheck holds without spawn and releases on match; unknown/throwing seam never holds; overdue signal once; ordinary crash unchanged). Against `origin/main`'s service: 10 failed, 67 passed; with the fix: 77 passed.
- `tests/e2e/local-verify-lifecycle.test.ts` — production wiring carries a real `installedVerifierVersion` equal to the config's `verifierVersion`; `GET /local-verify` shows `verifierHold: null` (8/8).
- Live: `.instar/logs/local-verify.jsonl` holds 46 `record … errorStep:verifier-mismatch` events across the three bursts (9 + 4 + 10 PRs × 2 attempts) plus 3 `main-record errorStep:crash`; `.instar/state/local-verify/journal.jsonl` keeps 14 of those records today (latest per key, compacted). 00:12:52Z shape: `started` → `run-error verifier-mismatch` → `error-auto-retry` → `started attempt:2` → `run-error` → next PR, ~90 ms apart; 03:01:50Z `queue-restored restored:0 dropped:0`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in the service's crash classification). Self-action note: the change adds no new self-triggered action — it removes the refusal→retry cascade and replaces it with a hold; the single notify it adds (`local-verify:verifier-hold`) is bounded to one per hold by the `signalled` latch, and only one hold is open at a time (a new hold needs the files to match again first, or a fresh process).
