<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

`ServerSupervisor`'s startup grace was raised from 3 minutes to 10 minutes. The supervisor
restarts a server that fails its health check once the grace ends — but a heavy boot on a
loaded box synchronously loads large TopicMemory/SemanticMemory and reconciles dozens of
sessions BEFORE it binds `/health`, so a full boot can take 5-6 min. With a 3-min grace the
supervisor restarted the server mid-boot, before it ever finished → an endless
restart-before-boot loop (the 2026-06-07 "server temporarily down on every message"
incident, topic 21816). 10 min comfortably exceeds a realistic slow boot, so a legitimate
boot always completes; a genuinely hung boot is still caught after the grace. Tunable via
the existing `startupGraceSeconds`.

## What to Tell Your User

If an agent ever got stuck restarting over and over right after an update (especially on a
busy machine), with "server temporarily down" on nearly every message — that's fixed. A
slow boot now gets enough time to finish instead of being killed mid-startup.

## Summary of New Capabilities

- `ServerSupervisor.startupGraceMs` default raised 180_000 → 600_000 (10 min). A longer
  grace only ever prevents a mid-boot restart; it never causes one. Override via
  `startupGraceSeconds`.

## Scope (honest)

Contained Tier-1 change to one constant (`src/lifeline/ServerSupervisor.ts`). Fleet-wide
benefit and makes the rollout of the other stability fixes safe (agents that auto-update +
restart get the longer grace and can't loop). NOT the deepest fix — the real root is that
the server binds `/health` only AFTER the heavy boot load; the durable fix (health-first
boot) is tracked as the top post-mortem item. This grace bump is the proven immediate cure.

## Evidence

`tests/unit/supervisor-startup-grace.test.ts`: default grace >= 6 min (strictly > the old
3-min); `startupGraceSeconds` override works; a health failure inside the grace window is
not acted on. `tsc --noEmit` clean. Proven live: applied to Echo mid-incident, the restart
loop broke immediately (restarting every ~5-6 min → stable, health recovered to 6/6).
causalAutopsy: latent — the 3-min grace was always shorter than a worst-case heavy boot;
it only surfaced once boot work (memory size + session count) on a loaded box exceeded 3 min.
