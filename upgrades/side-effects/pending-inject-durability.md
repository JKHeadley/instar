# Side-Effects Review - pending-inject durability

**Version / slug:** `pending-inject-durability`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Makes in-flight initial-message injects durable across server restarts (finding 8d300555): a JSON record per pending inject under `<stateDir>/state/pending-injects/`, written at spawn, cleared after the inject runs, swept at boot (`SessionManager.recoverPendingInjects`). Alive sessions get re-delivery through the normal readiness path; dead/expired records are reported via DegradationReporter and retired.

## Decision-point inventory

- `PendingInjectStore` (new) - file-based CRUD; record/clear never throw into the spawn/inject paths.
- `sweepPendingInjects` (new) - pure decision function: expired → report+clear; dead → report+clear; alive → redeliver (clear on success, keep on failure for next-boot retry).
- `SessionManager.spawnInteractiveSession` - modify - records before scheduling the ready-wait.
- `SessionManager.handleReadyAndInject` - modify - clears at both inject points; fallback "succeeded" log reworded to "launched (inject pending)".
- `SessionManager.recoverPendingInjects` (new public) - boot sweep wired in `server.ts` after `purgeDeadSessions`, fire-and-forget.
- `StateManager.baseDir` (new getter) - read-only path accessor.

## 1. Duplicate delivery (the chosen failure mode)

At-least-once by design: a crash between inject and clear re-delivers on the next boot. A duplicated message into an agent session is recoverable noise (agents already tolerate replays); the alternative (clear-before-inject) recreates the silent drop. Documented in code and ELI16.

## 2. Re-delivery into a moved-on conversation

A record older than 6h is expired (reported, never re-injected) — re-typing an hours-old message mid-conversation confuses more than it helps. Within 6h, the target session was spawned FOR that message and has at most been idle; re-delivery is the intended outcome.

## 3. Boot-time load

The sweep runs in the background (void + catch), after the dead-session purge, and re-uses the existing per-session readiness waits. Typical population is 0–2 records; the 90s ready-wait per alive record cannot block boot.

## 4. Blast radius

Spawn hot path gains one synchronous small-file write (try/caught, non-fatal on failure) and each inject one unlink. No routes, no config, no migrations (state dir is created on demand; absent dir = no pending injects). Existing behavioral/inject/lifecycle suites green (53 tests) plus 13 new.

## 5. Failure modes

- Record write fails → warning, spawn proceeds (no new failure mode vs today).
- Clear fails (non-ENOENT) → warning; stale record re-examined and expired by the next boot sweep.
- Redeliver fails → record kept, reported, retried next boot (bounded by the 6h expiry — no unbounded loop, P19-compliant).
- Corrupt record file → skipped with a warning, never bricks the sweep.

## 6. Security

Records contain the message text (which may be a bootstrap-file pointer or full message) — same sensitivity class and same directory tree as the existing `telegram-inbound/bootstrap-*.txt` files; no new exposure surface.

## 7. What this does NOT fix (honest scope)

The bootstrap-*.txt files themselves are still unswept (consumed implicitly by the session reading them). A dead-session loss is REPORTED but not auto-respawned — the bridge's next-message respawn remains the recovery path; auto-respawn is a candidate follow-up once this slice proves itself.

## 8. CI-found edge (mock construction)

E2e suites construct SessionManager with mock StateManager objects lacking `baseDir`; the wiring now falls back to `path.join(config.projectDir, '.instar')` instead of crashing construction. Caught by CI (shard 2/4), reproduced and fixed; the failing e2e (`secret-sync-alive`) verified green locally post-fix.

## 9. no-silent-fallbacks ratchet (+1, justified)

The subsystem's defensive catches (record/clear/list + the boot-recovery guard) tripped the no-silent-fallbacks baseline 458→459. None is a silent swallow: record/clear/list warn with full context and carry in-brace `@silent-fallback-ok`; the boot-recovery guard's real failures route to DegradationReporter via `sweepPendingInjects.reportLoss`. Baseline bumped with a precise in-test comment — the PR adds zero unjustified silent fallbacks.
