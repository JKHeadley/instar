# Side-Effects Review — the startup-grace ceiling no longer carries over from a healthy run

**Version / slug:** `supervisor-grace-ceiling-reanchor`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (session lifecycle: restart path)`

## Summary of the change

Tier 1. Two files of substance: `src/lifeline/ServerSupervisor.ts` (one condition plus a comment, in `runHealthTick()`) and a new test file `tests/unit/supervisor-grace-ceiling-reanchor.test.ts` (4 tests). The Fix C ceiling anchor `firstSpawnedAt` was re-set on every tick from the running server's old `spawnedAt` after a healthy tick had cleared it, so a server healthy for more than 3 × `startupGraceMs` (30 min) met its first outage with the ceiling already exceeded; each respawn reset `spawnedAt` but not `firstSpawnedAt`, so each respawn got only the ~60 s `processAliveThreshold` allowance (feedback fb-6b354765-24a, Echo Laptop 2026-11-21 03:00 PST, five kills of 75–150 s boots). The anchor now happens only when the current spawn has not answered healthy yet (`lastHealthy < spawnedAt`), the same "this spawn never went healthy" test `handleUnhealthy()` already uses for bind-failure tracking. Effort: one implementation attempt, no spec review rounds (Tier 1, revert fully undoes it).

## Decision-point inventory

- `ServerSupervisor.runHealthTick()` startup-grace / Fix C ceiling — **modify** — when the ceiling anchor is set. The grace check itself, the ceiling arithmetic, the boot-beacon "starting" bound and the failure thresholds are unchanged.

---

## 1. Over-block

No block/allow surface on messages. In restart terms, the change makes the supervisor *more* patient in exactly one situation: the first respawn after a healthy run now gets the full 10-minute grace instead of ~60 s. A server that hangs right after such a respawn is therefore restarted after up to 10 minutes rather than ~1 minute. That is the documented intent of the startup grace and matches what a fresh lifeline start already gives.

## 2. Under-block

- A server that never answers after a respawn is still bounded: the anchor is set at the first respawn of the episode and is not moved by later respawns (test "within one unhealthy episode the anchor is not moved by a later respawn"), so the 30-minute ceiling clips a later respawn's grace (test "...still bounded by the ceiling across respawns": a respawn lands less than one grace after its predecessor, between `anchor + ceiling` and `anchor + ceiling + 2 min`).
- A healthy server that fails with no respawn yet opens no episode (`firstSpawnedAt` stays 0); its `spawnedAt` is old, so it is outside the grace window anyway and failures count normally. No case found where failures are now ignored that were acted on before, other than the intended first-respawn grace.

## 3. Level-of-abstraction fit

Right layer: the defect is in the supervisor's own episode bookkeeping, and the fix reuses the supervisor's existing `lastHealthy < spawnedAt` definition of "this spawn has not gone healthy" rather than adding a new state field.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The supervisor's restart authority is existing and deterministic by design (a process supervisor acting on liveness). This change adds no new authority and no new detector; it corrects which timestamp an existing bound is measured from.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The condition is an invariant about the episode definition ("an unhealthy-boot episode starts at a spawn that has not answered healthy").

---

## 5. Interactions

- **Shadowing:** Fix A (missing tmux session → immediate `handleUnhealthy()`) runs before the ceiling code and is untouched. Existing tests pass (`server-supervisor-respawn-guarantee`, 18).
- **Sleep/wake:** both wake paths still set `spawnedAt = firstSpawnedAt = now` explicitly; the starved-gap path still leaves both alone (tests in `server-supervisor-respawn-guarantee` and `ServerSupervisor-sleep-wake` pass).
- **Boot beacon "starting" bound:** uses `min(firstSpawnedAt, bootingSince)`; with the fix `firstSpawnedAt` is the episode's first respawn rather than the old original spawn, so a slow post-outage boot answering "starting" is also no longer cut off immediately. Existing listen-early tests pass.
- **Circuit breaker / restart backoff / cooldown:** untouched; they live in `handleUnhealthy()`, and the new timeline tests exercise the real `handleUnhealthy()` and `spawnServer()`.
- **Adopted server at lifeline start** (`start()` sets `lastHealthy` then `spawnedAt`): the anchor may be set for a moment and is cleared on the first healthy tick, same as before.
- **Legacy planned-restart flag path** (sets `spawnedAt = now` on a failure): the anchor is set at that moment as before.
- **Hard-sleep wake** (`checkWakeRequest()`): ticks while slept return before the anchor code, so the wake respawn now anchors fresh at the wake instead of inheriting the original spawn's anchor (an improvement noted by the second-pass reviewer).

## 6. External surfaces

No new routes, no state files, no config, no user-facing messages. Timing changes only in the scenario above. No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's lifeline supervises its own server process, and the episode timestamps are in-memory per process. No notices, no durable state, no URLs. No status surfaces changed.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state, no migration, no agent repair.

---

## Conclusion

The failing-first tests reproduced the incident shape exactly before the fix (5 respawns about 65 s apart for a 150 s boot after 40 healthy minutes; anchor pointing at the original spawn) and pass after it, alongside the 75 existing supervisor tests in the related files. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact:** see the appended review below.

---

## Evidence pointers

- Before fix: `npx vitest run tests/unit/supervisor-grace-ceiling-reanchor.test.ts` → 4 failed (respawns length 5 instead of 1; second respawn 65000 ms after the first instead of ≥ 600000; anchor 1795248000000 = original spawn instead of 1795250455000 = first respawn).
- After fix: 4 passed. Related files (`server-supervisor-respawn-guarantee`, `supervisor-startup-grace`, `ServerSupervisor-sleep-wake`, `supervisor-health-check`, `supervisor-cpu-starvation-defer`, `server-supervisor-inflight-marker-defer`, `supervisor-kickstart-race`, `cpu-starvation`, plus the new file): 9 files, 79 tests passed.

---

## Class-Closure Declaration (display-only mirror)

- `defectClass`: `unbounded-self-action` (context only). This change adds no new self-triggered emit; it corrects the anchor of an existing bound on the supervisor's restart loop. The loop remains bounded per unhealthy episode by the 3 × grace ceiling measured from the episode's first respawn, by the restart backoff and cooldown, and by the circuit breaker, all exercised by the new timeline tests.
- `closure`: n/a — no new self-action emit in the added diff (the commit gate's detector agrees), so no trace-level declaration is required.

### Appended second-pass review
**Reviewer:** independent reviewer subagent
**Verdict:** Concur with the review

- Correctness: every write of `firstSpawnedAt = 0` happens alongside `lastHealthy = Date.now()` (grace-window probe and the main healthy branch), so after any healthy tick `lastHealthy >= spawnedAt` and the new guard keeps the anchor at 0 for the rest of the healthy run. The next `spawnServer()` sets `spawnedAt` past `lastHealthy`, so the first tick after a respawn anchors at that respawn and the respawn gets the full `startupGraceMs`. Confirmed independently of the duration of the healthy run.
- Boundedness: within an unhealthy episode, nothing clears `firstSpawnedAt` except a healthy probe or the two non-starved wake paths (which set it to now, deliberately). Later respawns only move `spawnedAt`, and `lastHealthy` stays older than every new `spawnedAt`, so the anchor is set once and held. A server that never answers healthy is acted on by `anchor + 3 x grace`. I found no path that resets the anchor on every respawn. The only way to leave it unset is a backward wall-clock step that puts `lastHealthy` ahead of a new `spawnedAt`; then each respawn gets plain grace, still bounded by restart attempts, cooldown and the circuit breaker. Low risk, and the code before this change had the same kind of clock sensitivity.
- Other paths: Fix A runs before the anchor code and is unchanged. Starved-gap handling still leaves both timestamps alone. The wake detector and the gap-wake path still set both timestamps to now. The "starting" bound now measures from the episode's first respawn rather than the original spawn, which is the intended improvement. `start()` adoption sets `lastHealthy` and then `spawnedAt`, which can open an anchor for a moment; it is cleared on the first healthy grace tick. The legacy planned-restart path, which keeps resetting `spawnedAt` while the server is unhealthy, now anchors at its first reset and is bounded by the ceiling. `checkWakeRequest()` (hard-sleep wake) is not covered in section 5, but it also improves: the ticks while asleep return before the anchor code, so the wake respawn anchors fresh instead of inheriting the original spawn's anchor. Circuit-breaker retries long into a never-healthy episode still get no fresh grace because the ceiling has passed. That behaviour existed before this change and was not introduced by it.
- Tests: the tests drive the real `runHealthTick()`, `handleUnhealthy()` and `spawnServer()` under fake timers. Only tmux, the probe and the request-file readers are stubbed. Both sides of the boundary are covered: a full grace is given after a healthy run (test 1, and test 3's `respawns[1]-respawns[0] >= grace`), and the ceiling still clips (test 3 requires a clipped respawn inside `[anchor+ceiling, anchor+ceiling+2min)`, and test 4 checks that the anchor holds). Each assertion would fail on the old code, which is consistent with the recorded failing-first evidence. I re-ran the file here and all 4 tests passed.
- Artifact accuracy: the artifact matches the code. One small gap: section 5 could mention the `checkWakeRequest()` improvement described above. No change is required.

### Follow-up commit (CI green-up, 2026-11-21)

Three red checks on the first head, none caused by the supervisor change. (1) `Docs Coverage` failed on the job class (`83% < 85%`, 29 documented + 12 partial of 42): the `gemini-payg-reconcile` default job template is mentioned nowhere under `site/src/content/docs`, and `main` fails the same floor by the same number (checked by running `scripts/docs-coverage.mjs --check` against an export of `origin/main`). This commit adds the same two documentation entries PR #3597 adds (the default-jobs reference table and the routing-spend control-room page, byte-identical so the two merge cleanly), lifting the class to 86%. Documentation only; no runtime surface. (2) `eli16` failed because the PR description carried no `## ELI16 — …` heading; the overview from `docs/specs/supervisor-grace-ceiling-reanchor.eli16.md` (2473 chars, above the 800 floor) is now in the description. No file change. (3) `Unit Tests (node 20, shard 1/4)` failed in `npm install` (`connect ENETUNREACH` / `ETIMEDOUT` to the registry) before any test ran: a runner network flake, re-run by the push.
