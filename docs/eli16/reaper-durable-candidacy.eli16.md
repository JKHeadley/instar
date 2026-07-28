# Durable reaper candidacy — ELI16

> The one-line version: the reaper waits until a session has been idle for 45 minutes before reclaiming it, but that 45-minute timer lived only in memory — so every server restart wiped it back to zero. On a box that restarts every ~10 minutes, the timer never reached 45, so the reaper never reclaimed anything. This saves the timer to disk so it survives restarts.

## The problem (found 2026-06-07)

After fixing the reaper's idle-detection (#969), it correctly flagged 11 idle sessions as reapable — but still reaped 0. Root: the reaper requires a session to be continuously idle for 45 min (a safety, so a momentarily-quiet session is never killed), and that candidacy clock is an in-memory map. The server was restarting every ~10 min (SleepWake-under-load churn), and each restart reset the clock — so it never reached 45 min.

## What this adds

Persist the candidacy map to disk after each tick and restore it on startup, so the idle clock survives restarts. The save/load is injected (the server writes `.instar/state/session-reaper-candidacy.json`).

## Why it's safe

- On restore, `reapPendingSince` (the "about to kill" flag) is DROPPED — so a stale pending state can never insta-kill a session on boot; the two-phase reap re-confirms fresh.
- Every tick still re-checks the session is genuinely idle (all-clear) AND its screen is unchanged (render-stasis, comparing the live frame to the restored one) before reaping. If a session changed during the restart gap, candidacy resets. The durable part is only the *elapsed-idle* clock.
- Best-effort: a missing/corrupt state file just means the clock starts fresh (the old behavior). Reaper stays opt-in + dry-run-first.

## Honest scope

This is fix A of the A+B pair the operator requested. It makes the reaper actually reclaim despite the restart churn. B (fixing the restart churn itself — the SleepWake-under-load misfire) is the companion and the deeper root.

## Evidence

`tests/unit/session-reaper.test.ts`: candidacy persisted after each tick; a restored long-idle session reaps immediately (clock survived) while a fresh reaper would NOT reap it yet (proving the restore mattered); `reapPendingSince` dropped on load (no insta-kill). 45/45 green. `tsc --noEmit` clean.
