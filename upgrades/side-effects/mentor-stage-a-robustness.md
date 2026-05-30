# Side-effects review — Mentor Stage-A: surface error + harden spawn

**Spec:** `docs/specs/MENTOR-STAGE-A-ROBUSTNESS-SPEC.md`
**Changes:** `src/scheduler/MentorOnboardingTick.ts`, `src/scheduler/MentorOnboardingRunner.ts`, `src/server/AgentServer.ts` (+ unit test)
**Class:** mentor reliability + diagnosability fix.

## What changed

1. `MentorTickResult` gains `error?: string`.
2. `runMentorTick`'s bare `catch {}` around `spawnStageA` → `catch (err)` that
   captures the message into the returned result (`{…, error}`) + the finding
   title.
3. `MentorOnboardingRunner.startTick().catch` adds the same `error` field (for a
   rejected `tick()`).
4. `spawnStageA` (AgentServer.ts) wraps `spawnSession` in a single retry with a
   3s backoff; on persistent failure throws `stage-a-spawn-failed: … — <cause>`.

## Blast radius

- **`/mentor/status` consumers:** purely additive — `lastResult` may now include
  an `error` string on the failure path. No field removed/renamed.
- **Healthy mentor ticks:** unchanged — new code runs only on the catch/failure
  path or a throwing spawn.
- **Stage-A two-hats isolation:** unchanged — still spawns with the empty
  `STAGE_A_ALLOWED_TOOLS` grant; only error handling + a retry added.
- **Public API / DB schema / config:** none changed. No new route (the
  AgentServer change is inside an existing closure — E2E-PAIRING exempt).

## What could break (and why it doesn't)

- **The retry doubling spawn load?** Only on a spawn that already failed once,
  and capped at 2 attempts with a 3s gap — negligible, and only on the
  already-failing path.
- **`error` field typing:** flows through `MentorRunResult extends
  Omit<MentorTickResult,'reason'>` which keeps `error?`. `tsc` clean.
- **Masking a persistent failure:** no — a persistent failure still throws after
  2 attempts, now with the cause in the message.

## Security

No new external input / network / auth / fs surface. The surfaced `error` is an
internal spawn/timeout message (no secrets).

## Migration parity

Server-internal scheduler/server code — every agent gets it by running the new
build. No PostUpdateMigrator entry required.

## Rollback

Revert the commit. No persisted state, schema, or API contract affected.

## Tests

`tests/unit/MentorOnboardingRunner.test.ts` (+1): a throwing `spawnStageA` now
surfaces `lastResult.error` with the real message (was swallowed). Full
mentor/stage suite — 113 tests across 9 files — green; `tsc --noEmit` clean.
