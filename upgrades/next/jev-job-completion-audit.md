# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

New dark instrument: the Jev job-completion audit (spec:
`jev-job-supervision.md`, 10-round convergence). When enabled for a bounded
soak, a scrubbed evidence snapshot is captured whenever a scheduled job
completes, and a 6-hourly batch (`jev-completion-audit` built-in job →
`POST /jev-audit/batch`) asks Jev (TypeSafe) whether the evidence shows the
job's promised work happened — recording verdicts that decide nothing. Jobs
can declare `completionAudit: excluded|eligible|priority` and expected
outputs via `declaredEffects` (jailed, max 8). Ships OFF
(`intelligence.jevJobCompletionAudit`), inert without a future `soakEndsAt`
and a vault `typesafe_api_key`; enabling is the operator's explicit call
because scrubbed job output leaves the machine to TypeSafe during the soak.
Existing agents receive the dark config default and a CLAUDE.md awareness
card on update.

## What to Tell Your User

Nothing changes yet. I now carry a switched-off checker that can record
whether my scheduled background jobs actually did what they claim — we found
cases of jobs "succeeding" while doing nothing. Turning its trial on is your
decision, and even then it only records; alerting on a faking job would be a
later, separate decision.

## Summary of New Capabilities

- Evidence capture at job completion (durable, deduped, permission-hardened,
  14-day bounded retention) with deterministic + trivial-heuristic comparator
  columns beside the Jev verdict.
- Batch audit under one daily call budget (failed billed attempts included),
  stratified suspicious-first sampling, widening retry brakes.
- `completionAudit` / `declaredEffects` manifest vocabulary, wired end-to-end
  with load-time jailing.
- `POST /jev-audit/batch` trigger route (503 when not constructed); verdict
  rows in `logs/jev-job-completion-audit.jsonl` via bounded rotation.

## Evidence

- Unit `tests/unit/JevJobCompletionAudit.test.ts` (23 passing): pack dedupe under racing writers; inert when disabled/expired/excluded; never throws; burst of 8 captured; in-flight cap overflow counted; tail-preferring truncation with in-band disclosure; planted secret never in pack, wire body, or row; symlink/realpath jail (incl. the macOS /var realpath trap); confidence rule both sides + the no-declaredEffects single-noul gate; every closed not-audited reason reachable; failed attempts debit the restart-safe cap; terminal audit-failed; model-mismatch; stratified suspicious-first order; retention sweep; metering.
- Unit `tests/unit/jev-audit-wiring.test.ts` (6 passing): manifest validation + load-time jailing; the built-in job self-excludes; migrator config default + CLAUDE.md card idempotent with operator values preserved; wake-reaper structural absence.
- Integration `tests/integration/jev-completion-audit-scheduler.test.ts` (5 passing): real JobScheduler completion produces a pack with the run row unchanged; completion returns promptly under a HANGING capture; a throwing capture cannot break `notifyJobComplete`; no-audit default byte-identical; batch writes a verdict row through the real pipeline.
- E2E `tests/e2e/jev-completion-audit-lifecycle.test.ts` (3 passing): 503 when not constructed; migrator default + flag-off boot writes nothing; config flip (no restart) captures and audits through the production factory AND the real HTTP route.
- Existing JobScheduler (94) and loader/manifest (88) suites pass unchanged.
