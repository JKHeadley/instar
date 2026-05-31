---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; Justin directive to track all codex onboarding issues for next-framework onboarding)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — a durable write path for the framework-onboarding issue ledger

The Framework-Onboarding Mentor System keeps a bucket-tagged ledger of issues found while
onboarding a non-Claude agent framework (Codex now; Cursor/Aider/Gemini next). Until now it
was fed by ONE source — the automated mentor tick's own forensics — so issues discovered the
other way (an engineer auditing and fixing the code) never reached it. The generalizable
buckets that feed the next-framework playbook stayed empty of exactly the deepest lessons.

This adds `POST /framework-issues/observe` — a small authenticated write path over the
ledger's already-validated `recordObservation` (+ an optional status transition, so an
already-fixed issue can be backfilled in one call). New framework strings are intentionally
allowed (onboarding the next framework introduces one); the write is idempotent on `dedupKey`.
A reusable importer script (`scripts/framework-issue-backfill/`) bulk-loads a findings JSON.

## Summary of New Capabilities

- `POST /framework-issues/observe` records an engineering-discovered framework issue:
  `{ framework, bucket, severity?, title, dedupKey, evidence?, observedVersion?, status?,
  fixedInVersion?, wontFixReason?, bucketPrimary?, signature?, relatedSpec? }`. bucket /
  severity / status enums are validated by the ledger (400 on bad input). Idempotent on
  `dedupKey`. Returns `{ issueId, created, recurrenceCount, issue }`.
- The two generalizable buckets (`framework-limitation`, `instar-integration-gap`) feed the
  existing `/framework-issues/playbook?targetFramework=X` for the next framework onboarded.
- Agents learn the write path via CLAUDE.md (template registry row + migrator section), with a
  proactive trigger: log a framework-compat issue the moment you fix or won't-fix it.

## What to Tell Your User

When you are onboarding a non-Claude agent and you find a compatibility issue by fixing the
code, you can now record it in the durable onboarding ledger, not just the ones the automated
mentor loop happens to trip over. Those records carry forward as a playbook for the next
framework you bring onto Instar. Nothing to configure.

## Evidence

- New route in src/server/routes.ts (thin wrapper over the existing recordObservation +
  updateIssue; both already enum-validate and throw, surfaced as HTTP 400).
- Tier-2 integration: tests/integration/framework-issues-routes.test.ts — records a new issue,
  backfills an already-fixed issue in one call, idempotent re-record, allows a new framework
  string, 400 on missing field / invalid bucket / wont-fix-without-reason (23 tests pass).
- Tier-3 E2E: tests/e2e/framework-issue-ledger-lifecycle.test.ts — the write route is alive on
  the production init path (POST returns 200 not 503; the finding surfaces through the live GET).
- Agent Awareness + Migration Parity: templates.ts registry row + a content-sniffed,
  idempotent migrateClaudeMd paragraph for existing agents (feature-delivery-completeness
  allowlist updated; 235 PostUpdateMigrator tests pass).
- tsc --noEmit clean; npm run lint clean.
- Spec: docs/specs/framework-issue-observe-write-path.md (+ .eli16.md).
- Side-effects: upgrades/side-effects/framework-issue-observe-write-path.md.
