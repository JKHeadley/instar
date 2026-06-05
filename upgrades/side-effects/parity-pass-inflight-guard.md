# Side-effects review — parity-pass single-flight guard + budget-derived route timeout

Live incident (2026-06-05 ~12:16Z, while feeding the migration parity window
against a degraded source): a sequential feeder fired 4 parity passes; every
POST died at the route's constant 360s budget while its handler KEPT RUNNING
(the always-logged-outcome contract from #807) — so 4 CONCURRENT full live
fetches piled onto an already ~16×-degraded Portal read path, each slowing the
others. Two distinct gaps, both closed here.

## 1. The change

- `CutoverReadiness`: a **single-flight guard over the live source fetch**,
  shared by `runParityPass()` and `runImportDryRunPass()` (both page the full
  live source). A concurrent trigger is refused IMMEDIATELY with
  `live source fetch already in flight (<op> started <ISO>)` — surfaced as the
  routes' existing 409-records-nothing contract. The guard is released in
  `finally` (a failed check can never wedge future passes).
- `buildRequestTimeoutOverrides()`: the parity-pass/import-dryrun route budgets
  now **derive from the configured source budget**
  (`feedbackMigration.paritySource.totalTimeoutMs` + 60s slack), never below
  the existing 360s floor. Widening the source budgets for a degraded source
  (the #820 knobs) now widens the response window with them — previously the
  route 408'd at the constant regardless, which is what turned a sequential
  caller into a concurrent pile-up.
- `AgentServer`: passes the configured `totalTimeoutMs` into the builder
  (single-source-of-truth map unchanged otherwise).

## 2. Blast radius

Small and behavioral-only at the two cutover-readiness trigger routes:
- A concurrent trigger that previously started a hidden second fetch now gets
  an immediate 409. No caller could ever OBSERVE two concurrent passes succeed
  (the second response was always a 408), so no working flow breaks.
- Route timeouts for the two routes grow ONLY when an operator has explicitly
  widened `totalTimeoutMs` in config; with no config the constant floor holds,
  so default installs see zero change. Unrelated routes unaffected (asserted).
- No new config keys, no migrations, no durable-state shape changes, no new
  routes. The refusal reason string is new (additive).

## 3. Test coverage

- Unit (5 new, cutover-readiness.test.ts → 20): concurrent parity pass refused
  + records nothing; guard releases after success; guard releases after a
  FAILED check (no wedge); guard shared dry-run↔parity in both directions,
  refusal names the holding op and persists nothing.
- Unit (5 new, AgentServer-outbound-timeout.test.ts → 20): derived budget =
  total+slack for both routes (the live 4200s case); below-floor configs stay
  at the floor; zero/NaN/Infinity/negative fall back to the floor; unrelated
  routes undisturbed; AgentServer wiring regex updated to the config-fed call.
- Integration (1 new, cutover-readiness-routes.test.ts → 10): full-pipeline
  concurrency — slow in-flight pass, second POST 409 'already in flight',
  cross-op dry-run 409 names 'parity-pass', release → first completes 200 with
  exactly one recorded pass.
- E2E: existing cutover-readiness lifecycle suite re-run green (no new routes).
