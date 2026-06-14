# WS4.3 role-guard-at-spawn — a state-writing scheduled job is refused on a read-only standby machine (dark)

<!-- bump: patch -->

<!--
  NOTE: internal multi-machine substrate, dark by default
  (multiMachine.seamlessness.ws43RoleGuard, default false). The change touches
  runtime src/ (the JobScheduler spawn-boundary re-check + server wiring +
  config/migrator/awareness + JobDefinition.writesState), so the tests/docs-only
  lane does not apply. The user-facing section honestly states the capability
  only matters on a multi-machine setup with the flag on, and is a no-op on a
  single-machine agent.
-->

## What Changed

The **role-guard-at-spawn** closes the deferred follow-up to the merged WS4.3 jobs read-side (PR #1104, CMT-1416). The scheduler only starts on the in-charge (lease-holding) machine — but it is never torn down if that machine loses the lease mid-run, so its cron timers keep firing. That left a window where a STATE-WRITING scheduled job could spawn on a machine that has since become a read-only standby (the double-writer corruption the standby rule exists to prevent). Now `JobScheduler.triggerJob` re-checks the lease at the spawn boundary — read LIVE, not cached — and refuses a job marked `"writesState": true` when this machine does not hold the lease. The cron fires on every machine, so the lease-holder's pass runs the job; the refusal re-routes by construction, and raises one calm deduped heads-up. Ships behind `multiMachine.seamlessness.ws43RoleGuard` (default false) per `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md`; a single-machine or flag-off agent is a strict no-op.

## What to Tell Your User

None while dark — internal multi-machine plumbing. The user-visible behaviour, once an operator turns it on across more than one machine: a scheduled job that writes shared data will no longer accidentally run on the standby machine if the in-charge machine hands off control while that job's timer is ticking — it runs on whichever machine is actually in charge, and you get one quiet note if a job had to be redirected. On a single-machine setup nothing changes.

## Summary of New Capabilities

None user-facing while dark. One new opt-in job field: `writesState` in `.instar/jobs.json`. One new scheduler injector: `setRoleGuard`. Migration parity: the `ws43RoleGuard` config default and the Job-Scheduler awareness bullet reach already-deployed agents on update (config add-missing + idempotent migrateClaudeMd splice), so existing agents receive the capability and its prose, not just new installs.

## Evidence

- `tests/unit/job-scheduler-role-guard.test.ts` — 8/8: refuses on standby + raises attention; records role-guard skip; ALLOWS on lease-holder; ignores non-state-writing jobs; strict no-op when flag off / no provider; degrades to spawn-proceeds on a throwing provider; refusal survives a throwing attention callback.
- `tests/integration/scheduler-role-guard-integration.test.ts` — 4/4: full triggerJob pipeline with a config-flag-driven provider + real SkipLedger/StateManager — refusal lands a role-guard skip + job_skipped event; re-route-by-construction (lease-holder spawns the same job); flag-off no-op; live re-read of a mid-run demotion.
- `tests/e2e/scheduler-role-guard-alive.test.ts` — 2/2: the Phase-1 "feature is alive" E2E — a REAL MultiMachineCoordinator.holdsLease() (no mock) drives a real refusal when the flag is on; strict no-op when off.
- Gate suite green: tsc 0, dark-gate 24/24 (golden line-map recomputed), no-silent-fallbacks 5/5, feature-delivery-completeness 97/97, all 15 lints clean.
