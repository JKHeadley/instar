# Reaper: a safe skip must not auto-disable the whole reaper — ELI16

> One line: the idle-session reaper had a self-destruct flaw — the first time it tried to
> clean up a session that happened to be busy, it (correctly) didn't kill it, but then
> wrongly shut ITSELF off entirely until the next restart. So on a fleet with one always-busy
> session, the reaper disabled itself every boot and never cleaned up any of the genuinely
> idle sessions. This makes a busy session a normal skip instead of a kill-switch.

## The bug (found 2026-06-07)

`performReap()` calls `terminate(session)`. If it returns `terminated:false`, the old code
ALWAYS set `this.autoDisabled = true` ("fail safe"). But `terminate` returns
`{terminated:false, skipped:'active-process'}` for a session that's busy — a deliberate,
correct refusal, not a failure. Once `autoDisabled` is set, the reaper reports `dryRun:true`
and stops killing (`killsEnabled = enabled && !dryRun && !autoDisabled`) for the rest of the
boot.

Grounded evidence on the dev box: the reaper picked the session "topic scope creep" first
each boot, it had an active process, the kill was refused, the reaper auto-disabled — 8 such
self-shutoffs logged, 0 real reaps, while 37 sessions piled up. The reaper looked configured
to reap (dryRun:false in config) but `autoDisabled` overrode it.

## The fix

Distinguish a *deliberate decline* from a *genuinely unexpected outcome*:
- `terminated:false` WITH a `skipped` reason (busy/protected/already-gone) → **normal skip**
  (`reap-skipped` audit), move on to the next candidate. Reaper stays live.
- `terminated:false` with NO reason → still fail-safe auto-disable (genuinely unexpected).
- A thrown error → still fail-safe auto-disable (unchanged).

So one busy session can no longer disable reaping of the other 36.

## Why it's safe

- It does NOT change WHAT gets reaped — candidate selection and every KEEP-guard are
  untouched. It only stops a *safe refusal* from disabling the reaper.
- The fail-safe is preserved for the cases it was actually meant for (errors, reasonless
  refusals).
- The reaper still has its rate limits (maxReapsPerTick/Hour), grace window, and dry-run.

## Evidence

`tests/unit/session-reaper.test.ts`: safe skip → no auto-disable + reaper stays live;
reasonless `terminated:false` → still auto-disables; a busy session does NOT block reaping
another idle one (both attempted, the idle one reaped). 47/47 in-file + 44/44 sibling reaper
suites green. `tsc` clean.
