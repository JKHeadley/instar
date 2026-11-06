## What Changed

The Linux systemd unit now sets `Environment=INSTAR_SUPERVISED=1`, the same as the macOS launch file, and an update migration adds it to existing units, with a backup beside them. The unit starts the bash boot wrapper, so before this the lifeline never saw systemd as its parent, and every self-restart was skipped: watchdog, planned upgrade and version skew. The setting takes effect at the service's next start.

Watchdog self-restarts are also bounded on every platform:
- at most 6 per rolling 24h;
- the restart-storm alarm now counts the restart being decided, so it can fire;
- a malformed entry in the restart history reads as a corrupt file;
- two new degradations report when self-restart gives up (`TelegramLifeline.selfRestartExhausted`) or the history file is corrupt (`TelegramLifeline.restartStateCorrupt`).

## What to Tell Your User

If I run on Linux, I can now restart myself when I get stuck, the way I already do on a Mac, and I pick up new versions after big updates without waiting for a reboot. This starts after my next restart. On any machine, if restarting myself doesn't fix a problem after a few tries in a day, I stop retrying and tell you instead of looping.

## Summary of New Capabilities

Degradation features `TelegramLifeline.selfRestartExhausted` and `TelegramLifeline.restartStateCorrupt`. Opt a Linux machine out with a systemd drop-in setting `INSTAR_SUPERVISED=0`.

## Evidence

Two-server takeover drill (topic 137054), 2026-11-06: the lifeline logged `would restart (trigger=conflict409Stuck) but unsupervised; skipping exit` every 30s for 20+ minutes. Luna's history on 2026-10-12 shows 21 watchdog restarts in four hours that the storm alarm could not report. Tests: `tests/unit/linux-lifeline-supervised.test.ts`, `tests/unit/lifeline/rateLimitState.test.ts`.
