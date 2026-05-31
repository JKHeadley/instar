---
title: "Framework-issue playbook: auto-seed none→candidate on terminal resolution (§13.6)"
slug: "playbook-candidate-autoseed"
author: "echo"
status: "converged"
review-convergence: "2026-05-31T18:55:00Z"
review-iterations: 1
review-completed-at: "2026-05-31T18:55:00Z"
approved: true
approved-by: "echo"
approved-date: "2026-05-31"
approval-note: "Implements §13.6's specified-but-missing none→candidate auto-suggestion so the onboarding playbook actually populates for the NEXT framework. Self-approved under the standing autonomous-dev mandate (Justin's 2026-05-31 directive: log all codex issues so the lessons reach future-framework onboarding); flagged in the PR. Low-risk, additive, deterministic; the candidate→extracted non-Echo attestation guard is untouched."
eli16-overview: "PLAYBOOK-CANDIDATE-AUTOSEED-SPEC.eli16.md"
---

# Framework-issue playbook: auto-seed none→candidate on terminal resolution (§13.6)

## Problem

The Framework-Onboarding Mentor System logs every observed framework issue into
`FrameworkIssueLedger` (SQLite), tagged by bucket. The whole point of that ledger
(spec §6, §13.6) is that **generalizable lessons from PRIOR frameworks feed the
NEXT framework's onboarding** — when Cursor/Aider/Gemini is onboarded, its Stage A
"draws its first checks from the existing playbook." That playbook is served at
`GET /framework-issues/playbook?targetFramework=X` and is defined as:

```
framework != X  AND  bucket ∈ {framework-limitation, instar-integration-gap}  AND  playbook_status ∈ {candidate, extracted}
```

Every issue is created with `playbook_status = 'none'` (the SQL default). §13.6
defines the lifecycle `none → candidate → extracted → superseded` and states:

> **`none → candidate` may be auto-suggested by Stage B** (any actor). But
> `candidate → extracted` — the step that puts a lesson into the reusable
> onboarding checklist — REQUIRES a non-Echo attestation.

**The `none → candidate` auto-suggestion was never implemented.** Nothing in the
codebase moves an issue off `'none'` except the manual `POST
/framework-issues/:id/promote` route. As a result, on a live ledger with 18
generalizable codex lessons (11 of them terminal-resolved), **the playbook returns
`[]`** — the lessons are logged but never surface. Logging worked; learning did
not. The next framework would onboard with an empty playbook despite a full
ledger of hard-won codex lessons.

This was found by reading the live ledger (`GET .../playbook?targetFramework=cursor
→ { playbook: [] }`) while verifying Justin's directive that codex issues feed
future-framework onboarding.

## Fix

Two additive, deterministic changes in `FrameworkIssueLedger`, both confined to
the `none → candidate` step (which §13.6 explicitly allows any actor to automate):

### 1. Auto-suggest on terminal resolution (`updateIssue`)

When an issue transitions to a **terminal-resolved** status (`fixed` or
`wont-fix`) AND it is **generalizable** (bucket ∈ {framework-limitation,
instar-integration-gap}) AND its current `playbook_status` is `'none'`, promote it
to `'candidate'` in the same write transaction.

- **Only on terminal resolution.** `open` / `spec'd` are in-flight — the lesson is
  not yet proven, so they stay `'none'`.
- **Only generalizable buckets.** `generic-agent-mistake` is never a portable
  lesson and never enters the playbook.
- **Never downgrades.** The bump acts only on `'none'`; `candidate` / `extracted`
  / `superseded` are left as-is.
- **Caller override respected.** If the caller passed an explicit
  `playbookStatus`, the auto-bump is skipped (the explicit value wins).
- This is the "Stage B auto-suggest" of §13.6, realized as a deterministic
  write-path rule rather than an LLM call — always-on, testable, and independent
  of whether the (dark) mentor loop is running.

### 2. Idempotent backfill on construction (`backfillPlaybookCandidates`)

A self-limiting `UPDATE` that promotes every already-terminal generalizable issue
still stuck at `'none'` (i.e. resolved before this auto-suggestion existed) to
`'candidate'`. Called once from the ledger constructor (after the DDL migrations),
wrapped so a failure can never block construction. After the first run its WHERE
clause matches nothing, so re-running on every boot is harmless. This is how every
agent's existing ledger picks up the seeding on its next server start — no
dedicated `PostUpdateMigrator` entry, because the change is runtime data, not an
agent-installed file.

## What is explicitly NOT changed

- **The `candidate → extracted` attestation guard** in `promotePlaybook()` is
  untouched: extraction — putting a lesson into the canonical reusable checklist —
  still REQUIRES a non-Echo attester (`promoted_by !== 'echo'`). Auto-seeding only
  populates the *candidate* tier (proposed lessons); a human/peer still curates
  what becomes canonical. The integrity model is preserved end-to-end.
- The playbook query, route, ranking (impactScore), and all read shapes are
  unchanged — they already filter `playback_status ∈ {candidate, extracted}` and
  `bucket ∈ generalizable`; they simply had nothing to return.

## Testing (3-tier)

- **Unit** (`tests/unit/FrameworkIssueLedger.test.ts`): fixed→candidate;
  wont-fix→candidate; generic-agent-mistake stays none; non-terminal stays none;
  explicit-playbookStatus override respected; never-downgrade-extracted; end-to-end
  the auto-candidated lesson appears in another framework's `playbook()`;
  `backfillPlaybookCandidates` promotes only eligible rows + is idempotent +
  never downgrades; **the constructor self-seeds an existing on-disk ledger**.
- **Integration** (`tests/integration/framework-issues-routes.test.ts`): the real
  HTTP path — `POST /framework-issues/observe` with `status: 'fixed'` →
  `issue.playbookStatus === 'candidate'`, and `GET
  /framework-issues/playbook?targetFramework=cursor` now contains the lesson with
  **no manual promote call**.
- **E2E**: the playbook/observe routes' "feature is alive" lifecycle test
  (`tests/e2e/framework-issue-ledger-lifecycle.test.ts`) remains green; this change
  is behavior on those already-alive routes.

## Risk

Additive and deterministic. Worst case is an over-eager candidate (a generalizable
fixed issue surfaces as a *proposed* lesson) — which is exactly the intended
behavior and is gated by the unchanged extraction-attestation step before anything
becomes canonical. No new routes, dependencies, network, or migrations.
