# Side-Effects Review — ServerSupervisor startup grace 3min → 10min

**Version / slug:** `supervisor-startup-grace`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (one constant; no API/route/config-default/migration surface)
**Second-pass reviewer:** `Echo (self) — Tier-1; the boot-time-vs-grace analysis below is load-bearing, and this was PROVEN live on Echo`

## Summary of the change

`ServerSupervisor.startupGraceMs` raised from `180_000` (3 min) to `600_000` (10 min).
The supervisor probes the server's `/health` and, after the startup grace elapses,
treats failures as "unresponsive" and restarts. But a heavy boot on a loaded box
synchronously loads large TopicMemory (tens of thousands of messages) + SemanticMemory
and reconciles dozens of sessions BEFORE the server binds `/health`, so a full boot can
take 5-6 min. With a 3-min grace the supervisor began restarting the server mid-boot,
before it ever finished → an endless restart-before-boot loop (the 2026-06-07
"server temporarily down on every message" incident, topic 21816). 10 min comfortably
exceeds a realistic slow boot. File: `src/lifeline/ServerSupervisor.ts`. Already tunable
via the existing `startupGraceSeconds` option (unchanged).

## Decision-point inventory

- The single decision: how long to wait for a booting server before treating health
  failures as a hang worth restarting. Lengthened from 3 → 10 min.
- No message block/allow surface. No new route/config-default/migration. The existing
  `startupGraceSeconds` override is unchanged.

## 1. Over-wait (a genuinely hung boot waits longer before restart)

A boot that is truly hung (not just slow) now waits 10 min instead of 3 before the
supervisor restarts it. That is the deliberate tradeoff: the 3-min value was demonstrably
too short (it restarted *legitimate* slow boots → the loop, a far worse outcome — a
permanent outage). A genuine hang is rare; waiting 10 min for it is acceptable, and other
backstops (the out-of-process fleet watchdog) still exist. Net strictly safer than a
3-min grace that loops on every slow boot.

## 2. Under-wait (still restarts before boot completes)

10 min was chosen to exceed the observed worst-case boot (~5-6 min under heavy load on
Echo) with margin. If a deployment's boot ever exceeds 10 min, `startupGraceSeconds` can
raise it further without a code change.

## 3. Level-of-abstraction fit

Correct: a single duration constant on the component that owns the restart decision. No
LLM, no new dependency. The deeper durable fix (bind `/health` BEFORE the heavy boot
loads, so the grace barely matters) is tracked separately as the top post-mortem item;
this grace bump makes restarts safe in the meantime and is independently correct.

## 4. Blast radius

Fleet-wide benefit (every agent's supervisor): a longer grace only ever *prevents* a
mid-boot restart; it never causes one. Agents on fast/unloaded machines are unaffected
(their boot finishes well within both 3 and 10 min). This makes the fleet rollout of the
other stability fixes SAFE — agents that auto-update + restart get the longer grace and
cannot loop on the restart.

## 5. Rollback

Pure code revert (one constant). No state/config/format change.

## 6. Tests

`supervisor-startup-grace.test.ts`: default grace >= 6 min (and strictly > the old
3-min); `startupGraceSeconds` override works; within the grace window a health failure is
not acted on. tsc clean. PROVEN LIVE: applied to Echo during the incident, the restart
loop broke immediately (server went from restarting every ~5-6 min to stable; health
recovered to 6/6).
