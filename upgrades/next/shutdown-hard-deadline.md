# Graceful shutdown has a hard deadline

## What Changed

The server's SIGTERM/SIGINT teardown awaited ~10 subsystem stops with no overall bound, so one hang kept the process alive until SIGKILL (instar#2122: Luna's Studio standby ignored SIGTERM).

- `src/core/shutdownDeadline.ts`: `armShutdownDeadline` arms an unref'd timer at teardown start (default 20 s; `INSTAR_SHUTDOWN_DEADLINE_MS` override, floor 2 s); on expiry it logs the step in flight, closes SQLite handles, releases the single-instance lock and exits 1.
- A second signal during teardown exits at once with the same cleanup.
- The awaited steps are labelled in the log (`telegram-origin`, `notification-flush`, `tunnel`, `threadline`, `telegram`, `http-server`, `sqlite`).

## What to Tell Your User

When my server is asked to stop, it now always stops within about 20 seconds, even if one part of it is stuck, and the log says which part. Updates and restarts no longer have to force-kill it.

## Summary of New Capabilities

- `INSTAR_SHUTDOWN_DEADLINE_MS` sets the teardown bound.

## Evidence

`tests/unit/shutdown-deadline.test.ts`: the deadline fires with the in-flight step name at exactly the bound, a cancelled timer never fires and is unref'd, and the env override/floor/default resolve as documented.
