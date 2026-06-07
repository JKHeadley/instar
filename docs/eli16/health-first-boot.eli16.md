# Health-first boot (boot health beacon) — Plain-English Overview

> One line: the watchdog asks the server "are you alive?" by calling `/health`. But the server only starts answering that *after* it finishes a 5–6 minute startup (loading a huge pile of memory). So during startup it looks dead, and the watchdog restarts it — over and over. This adds a tiny stand-in that answers "yes, I'm alive (still starting)" from the very first second of boot, so the watchdog waits instead of killing it.

## The problem this fixes (the deepest root)

In the 2026-06-07 "server temporarily down" incident, the real root cause was the *order* of startup: the server loads ~18k messages of memory, the knowledge graph, and reconciles dozens of sessions **before** it opens the port that answers `/health`. On a busy machine that's 5–6 minutes of looking dead. The watchdog's patience ran out mid-boot and it restarted the (perfectly fine, still-booting) server — forever. We already widened the watchdog's patience (the "grace bump", #979) as an interim fix; this is the durable cure: make the server answer "I'm alive" from the start, so the loop is impossible regardless of patience.

## What this adds

A **boot health beacon**: a tiny HTTP listener that comes up instantly at the start of boot and answers `/health` with "ok (still booting)". It stays up through the heavy loading, then hands off — it's closed the instant before the real server takes over the port. To the watchdog, `/health` answers the whole time, so a slow boot can never look like a dead process.

## The safeguards

- **Off by default.** It ships dark behind `monitoring.bootHealthBeacon.enabled`. Until that's turned on, nothing changes at all. Rollout is dark → try it on Echo → fleet.
- **Clean handoff.** The beacon force-closes its connections and fully releases the port *before* the real server binds it, so there's no "address already in use" clash. A test proves the real server can grab the port immediately after the beacon lets go.
- **Never blocks boot.** If the beacon fails to start (or to stop), it's caught and ignored — the server boots anyway. The beacon can only ever help, never hold up startup. (Those two guards are deliberately marked `@silent-fallback-ok` — they log the error, and a best-effort beacon must not block boot.)
- **Right place in a tricky boot.** The server has a foreground/daemon split; daemon mode actually re-launches itself in "foreground", so the beacon is placed in that shared path — it runs no matter how the server was started.

## Honest scope

This is the durable fix; the grace bump is the belt-and-suspenders that already stopped the live loop. It's additive (a small new module + two guarded lines in the boot + an off-by-default flag), not a risky reordering of the whole startup. Live verification (watch `/health` answer during a real boot with the flag on) is the canary step of the rollout.

## Evidence

`tests/unit/BootHealthBeacon.test.ts` (4 tests): answers /health 200 while booting; 503 for everything else; releases the port cleanly for the real server (the handoff); idempotent start/stop. `tsc --noEmit` clean. causalAutopsy: latent — the boot-order (health bound after the heavy load) was always present but only became harmful once memory/session volume on a loaded box pushed boot past the watchdog's window.
