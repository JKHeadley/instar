---
title: Blocker, authorization, failure and framework-issue routes
description: The HTTP routes behind the Blocker Ledger, Self-Unblock checklist runs, operator authorization requests, the Failure-Learning Loop reads, and the framework-issue ledger.
---

Every route on this page needs the standard `Authorization: Bearer <token>` header. While a
feature is off or not running, its routes answer `503` with a short error saying so (after
authentication, so an unauthenticated caller only ever sees `401`).

## Blocker Ledger

The Blocker Ledger records "I am blocked" claims and walks each one through a fixed pipeline
(`candidate` → `authority-checked` → `access-requested` → `dry-run` → `live-run`) until it is
settled as `resolved` or as a `true-blocker`. It is signal-only: it records and structures the
work, and never holds an outbound message. Switch: `monitoring.blockerLedger.enabled`. Every
write route requires the `X-Instar-Request: 1` header (`403` without it) and is rate-limited to
30 calls a minute.

- `GET /blockers` lists entries. Query: `limit`, `offset`, and `includeArchived=1` to include archived entries.
- `GET /blockers/:id` returns one entry: its state, the full transition history, any recorded evidence, and its terminal record once settled. `404` for an unknown id.
- `POST /blockers` opens an entry. Body: `detectedText` (the blocker wording) and `origin` (who opened it), both required (`400` without them). Answers `201` with the new entry in state `candidate`.
- `POST /blockers/:id/advance` moves an entry one step along the pipeline. Body: `origin`, plus the evidence the next step needs (`authorityCheck`, `accessRequest`, `dryRun` or `liveRun`) and an optional `note`. A settled entry cannot advance.
- `POST /blockers/:id/settle` settles an entry. Body `kind: "resolved"` takes a `playbookPath`; it is refused unless the entry has a successful live run, and the playbook exists on disk inside the allowed skill and playbook folders and mentions the blocker id. Body `kind: "true-blocker"` takes a `reasonKind` from the closed list (`operator-only-secret`, `operator-only-account`, `legal-billing-authorization`, `operator-judgment`), a `rebuttal`, the `accessRequest` made to the user, and the failed attempt that came first. When the Self-Unblock checklist is on, that attempt must be a stored checklist run named by `selfUnblockRunId` (a caller-written `failedAttempt` is then ignored). The settle is judged by the outbound gate's authority before it is written. A settled true-blocker carries a `recheckAfter` date, when it is reopened and tested again.

Errors: `400` missing `detectedText` or `origin`, `403` missing intent header, `404` unknown entry, `409` settling an entry that is already settled, `422` for any other evidence or validation refusal (advancing a settled entry included).

## Self-Unblock checklist runs

While this checklist is on, no blocker can be settled as a true blocker without a stored run:
the agent runs the Self-Unblock checklist, which probes every credential source it can reach for
the target. The secret and account kinds need a `self-fetch` run; the other kinds a `dry-run` run. Switch:
`monitoring.blockerLedger.selfUnblockChecklist.enabled`. Both routes send
`Cache-Control: no-store`, and each probe's free-text detail is wrapped as data, not
instructions.

- `POST /blockers/self-unblock-run` runs the checklist now and stores the run, so a later settle can cite its `runId` as `selfUnblockRunId`. Body: `target` (a `service:scope` string, required) and optional `requiredAttemptType` (`self-fetch`, the default, or `dry-run`). Needs `X-Instar-Request: 1`. Returns the run: `runId`, `target`, `completedAt`, `exhausted`, the resulting `rung`, and one row per probe (`source`, `reachable`, `holdsRelevantCred`, `probedAt`, `matchedScopeTags`).
- `GET /blockers/self-unblock-runs` lists recent runs in the same shape, newest last; `limit` caps it (1 to 200, default 200).

## Authorization requests

An agent can propose that the operator grant a named Slack user one floor action for a set
time. The proposal confers nothing until the operator approves it. Switch: the
authorization-requests feature (`503` "authorization-requests feature not enabled" while off).
Proposable actions are `prod-deploy`, `money-movement`, `credential-access`,
`destructive-data` and `external-send`; granting authority to others is never proposable.

- `POST /authorization-requests` creates a request. Body: `proposal` (with `floorAction`, `grantedToSlackUserId`, `durationMs`), optional `reason` and `createdByAgent`. The grantee must be a registered Slack user (`400` "unknown-user" otherwise). Answers `201` with the request id and `deduped: true` when an identical pending request already existed.
- `GET /authorization-requests` lists requests; `status` filters to `pending`, `approved`, `denied`, `expired` or `withdrawn`. Each row carries the server-written `headline` and `reason`, the only text an operator screen should show.
- `GET /authorization-requests/:id` returns one request in the same shape. `404` for an unknown id.
- `POST /authorization-requests/:id/approve` is the one step that grants anything. It is PIN-gated, re-checks the action and the grantee at approval time, and issues a signed grant mandate that expires with the grant. `201` on approval, `200` if it was already approved.
- `POST /authorization-requests/:id/deny` declines a request. PIN-gated; body `denyReason` is required.
- `POST /authorization-requests/:id/withdraw` lets the proposing agent withdraw its own pending request. Body: `createdByAgent`.

The owner's phone can approve or decline the same requests with a Face ID proof instead of
the PIN.

## Failure-Learning Loop reads

The failure ledger records why features broke and which build skill they came from. Switch:
`monitoring.failureLearning.enabled` (`503` "failure-learning disabled" while off).

- `GET /failures/analysis` returns the analysis of the ledger, plus a `rollout` block naming the stage (`dark`, `capture-only` or `insight-push`). Query `sinceDays` limits the window.
- `GET /failures/insights` lists the patterns the analyzer found. Query: `status`, `before` (an ISO timestamp, for paging back) and `limit` (default 50).
- `GET /failures/:id` returns one failure record. `404` for an unknown id.

## Framework-issue ledger

The Framework-Onboarding Mentor System's record of behavioral issues found while bringing up
a framework (Codex, Gemini and so on). It is observability only and never gates anything. It has
no switch; its routes answer `503` "framework issue ledger unavailable" only if the ledger failed
to start.

- `GET /framework-issues` lists issues. Query: `framework`, `bucket`, `status`, `limit` (1 to 500, default 100). An unknown `framework` returns an empty list along with the known frameworks; a bad `bucket` or `status` answers `400`.
- `GET /framework-issues/playbook` returns the lessons that carry over to a new framework. Query `targetFramework` is required.
- `GET /framework-issues/capture-stats` shows mentor runs against observations written; runs that keep producing zero observations point at a broken writer.
- `GET /framework-issues/observability` shows how issues spread across buckets, plus the counts of suspected leaks, probable loops and lessons extracted into the playbook.
- `POST /framework-issues/observe` records an issue found during engineering work. Required: `framework`, `bucket`, `title`, `dedupKey`. Optional: `severity`, `signature`, `evidence`, `observedVersion`, `bucketPrimary`, `relatedSpec`, and `status` (with `fixedInVersion`, or `wontFixReason` for `wont-fix`) to backfill an issue that is already closed. A repeat with the same `framework` and `dedupKey` is recorded against the existing issue instead of opening a new one.
- `POST /framework-issues/:id/promote` moves an issue's playbook status. Body: `status` (`none`, `candidate`, `extracted`, `superseded`) and `promotedBy`. Promoting to `extracted` needs an attester other than Echo: the agent that proposed a lesson cannot promote it itself.
