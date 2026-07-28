---
title: Framework-issue ledger durable write path (POST /framework-issues/observe)
slug: framework-issue-observe-write-path
status: approved
review-convergence: 2026-05-31T03:20:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h autonomous deploy mandate (topic 13435) in
  direct response to Justin's explicit directive: "make sure we're tracking all of the issues
  and changes we make to Codex during the Codey mentoring... critical to onboarding the next
  agentic framework and for identifying the generic gaps." The FrameworkIssueLedger existed
  with exactly the right taxonomy but had only ONE feed (the automated mentor tick's Stage-B
  forensics), so engineering-discovered codex issues never reached it. This adds the missing
  write path. Signal-only/observability surface (the ledger never gates); the change is a thin
  wrapper over the already-shipped, already-validated recordObservation + updateIssue.
second-pass-required: false
second-pass-status: n/a-non-lifecycle
---

# Framework-issue ledger durable write path

## Problem

The Framework-Onboarding Mentor System's `FrameworkIssueLedger` is the purpose-built,
bucket-tagged record of issues found while onboarding a non-Claude framework. Its two
generalizable buckets (`framework-limitation`, `instar-integration-gap`) feed
`/framework-issues/playbook?targetFramework=X`, which hands forward lessons when the NEXT
framework is onboarded.

The ledger had exactly one feed: the automated mentor tick's Stage-B forensics
(`captureRun`). Issues discovered the OTHER way — an engineer (Echo) auditing and fixing the
code during mentoring — had no path into the ledger. Confirmed live: the codex-cli ledger held
181 runs / 63 observations, but only 2 deduped issues (both about the mentor harness's own
plumbing); `framework-limitation` count was 0 and `playbookExtracted` was 0, while a dozen
real codex-compat fixes (jsonlExists, SessionWatchdog, the two sentinels, the autonomous-loop
driver) lived only in PRs + private memory. The generalizable record was missing its deepest
lessons.

## Design

Add `POST /framework-issues/observe` — a thin HTTP wrapper over the ledger's existing,
already-validated `recordObservation(input)`:

- Required body: `framework`, `bucket`, `title`, `dedupKey` (non-empty strings; missing → 400).
- Optional: `severity`, `signature`, `evidence`, `observedVersion`, `bucketPrimary`,
  `relatedSpec` — passed straight through.
- Optional terminal-status transition: when `status` is present and not `open`, the route
  calls `updateIssue(issueId, { status, fixedInVersion, wontFixReason })` after recording, so a
  backfill of an already-fixed (or won't-fix) issue lands in one call.
- bucket / severity / status enums are validated INSIDE the ledger (`assertEnum`), which throws;
  the route maps any throw to HTTP 400. No new validation logic is introduced.
- New framework strings are intentionally allowed — onboarding the next framework introduces a
  new one. (Contrast the GET list route, which allowlists against known frameworks to bound
  reads; a write is what first introduces a framework.)
- Idempotent on `dedupKey` (recordObservation dedups/episodes); re-running a backfill updates
  rather than duplicates.

A reusable importer (`scripts/framework-issue-backfill/import-findings.mjs`) POSTs each entry
of a findings JSON; `codex-session-findings.json` carries this session's codex issues.

## Safety

- The ledger is observability-only — it never gates a job, blocks a message, or constrains a
  session. Adding a write path does not change that.
- Bearer-auth'd like every non-/health route (the existing GET/POST framework-issues routes
  already rely on the same middleware).
- No new enum/validation surface: the route delegates to recordObservation/updateIssue, which
  already enum-validate and throw. Worst case of bad input is a 400.
- Echo self-recording is allowed (recordObservation is not the §13.6-gated step); the
  playbook candidate→extracted promotion still requires a non-Echo attester via the separate
  `/promote` route, unchanged.

## Test plan (3-tier)

- **Tier-2 integration** (`framework-issues-routes.test.ts`): 503-when-unavailable; record →
  listable; status:fixed + fixedInVersion in one call; idempotent re-record; new framework
  string accepted; 400 on missing field / invalid bucket / wont-fix-without-reason.
- **Tier-3 E2E** (`framework-issue-ledger-lifecycle.test.ts`): the write route is alive on the
  production AgentServer init path (POST 200 not 503; finding surfaces through the live GET).
- **Tier-1**: the wrapped logic (recordObservation/updateIssue) is covered by the existing
  `FrameworkIssueLedger.test.ts`; consistent with how the sibling GET routes are tested.
- **Agent Awareness + Migration Parity**: templates.ts registry row + idempotent,
  content-sniffed migrateClaudeMd paragraph; feature-delivery-completeness allowlist updated.
