# Promise-Beacon Escalation — a promise survives its owning session's death

## What Changed

- **When a beacon-enabled commitment's owning session dies before delivering, the PromiseBeacon
  no longer silently tombstones it** (`violated: session-lost`). It now escalates through a
  bounded ladder: **Rung 1** revives a fresh, fully-gated session bound to the topic to actually
  follow through; **Rung 2** sends the user an honest, situation-specific interim status ("my
  session ended; I'm picking it back up") when it can't revive; **Rung 3** is a bounded loud
  give-up to the operator's Attention queue. This closes the gap where a promise sat open for
  hours while the user heard nothing actionable (the 2026-06-12 CMT-1419 incident).
- **A revived session carries no new authority.** It is held `revivalMode: status-only` — every
  side-effecting external operation is BLOCKED at the operation gate until the session records a
  server-side revalidation (a deliberate "re-check before you act" step), so it can only read,
  reason, and report until it explicitly re-grounds. The revalidation fields are server-written
  only; a session cannot self-clear the gate.
- **Every brake the constitution requires is wired:** per-commitment attempt cap + exponential
  backoff (durable across restart), a global anti-swarm budget (the June-5 thundering-herd
  guard), ResumeQueue coordination so the two can't double-spawn one topic, and a double-spawn
  detection counter (the rollout hard-stop signal).
- New authed routes: `POST /commitments/:id/revalidate` and `GET /commitments/escalation-metrics`.
  `GET /commitments/:id` now surfaces the escalation fields.
- Ships **dark + dry-run-first** behind `monitoring.promiseBeacon.escalation` (`enabled` resolves
  via the developmentAgent gate — live on the dev agent, dark on the fleet; `dryRun: true` logs
  "would escalate" without spawning or messaging). Config backfilled to existing agents; the
  operation-gate hook is updated fleet-wide to carry the session id the revivalMode gate needs.

## Evidence

- Implements the approved + converged `PROMISE-BEACON-ESCALATION-SPEC` (issue #1093), the
  follow-up to the durable message queue (#1079) for the premature-session-termination arc.
- 21 feature tests green across all three tiers — 13 unit (the full ladder: Rung 1/2/3, backoff,
  cap, in-flight resolution, budget shedding, quiet-hours, double-spawn detection, golden Rung-2
  wording), 7 integration (the routes + the I13 revivalMode gate block→revalidate→allow + I11
  field-rejection), 3 e2e (feature-alive + the dry-run no-side-effect contract + the report-only
  owner-gone path). Typecheck clean; neighbor suites (commitment routes, dark-gate lint,
  ConfigDefaults, PromiseBeacon) green.
- Independent second-pass review raised one concern (the double-spawn promotion metric was
  unwired); it was fixed in the same change and re-verified.

## What to Tell Your User

Nothing changes for the fleet yet — escalation ships off everywhere except the development agent,
and even there it runs in dry-run (it watches and logs what it *would* do, but never spawns a
session or sends a message). Once it's promoted, the behavior users will feel is simple: if a
promise I made gets interrupted by my session ending, I'll either quietly pick it back up and
tell you honestly where things stand, or — if I genuinely can't resume right now — send you a
truthful "still open, here's why" instead of going silent. I will never barrel ahead on a stale
plan: a revived session has to re-check before it can take any real action.

## Summary of New Capabilities

- A promise you're owed now survives the death of the session that made it: it self-revives to
  follow through (dark/dry-run for now), or gives you an honest interim status, instead of going
  silent. `GET /commitments/escalation-metrics` exposes the escalation counters; a revived
  session is structurally held to status-only until it re-grounds.
