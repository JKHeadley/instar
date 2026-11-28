---
title: Report eligibility for merged worktree release
approved: true
approved-by: Chief of Staff, offline report-only decision of 2026-11-24
review-convergence: "2026-11-25T01:00:47.754Z"
review-iterations: 7
review-completed-at: "2026-11-25T01:00:47.754Z"
review-report: "docs/specs/reports/merged-worktree-release-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Report eligibility for merged worktree release

The first build is an offline report. Read one JSON snapshot assembled by the stewardship evidence collector and print one verdict and all hold reasons per checkout. Accept an explicit evaluation time for replay. The reporter does not fetch, start a scheduler, alter legacy reaper custody, create archives, modify Git or remove paths.

Report “would release” only where the snapshot attests all of the following for the same checkout generation and exact HEAD: registered path, trusted merged PR evidence, at least 24 hours since merge and at least 24 hours of verified idle time, clean status including untracked and hidden tracked edits, and no lock, owner hold, live use, dependency or nested checkout. Missing, stale or mismatched evidence produces a hold. An archive-needed flag is informational and never asserts an archive exists. A report is an advisory snapshot, not permission to remove.

Use the observed 24-hour policy for automatic reports; this has no effect on separately authorized manual disposition. Checkout-specific evidence is host-qualified and must not be used to authorize work on another host.

## Decision points touched

- Report eligibility — invariant; basis: enumerable-domain; evidence: this report only reflects the explicit predicates of the owner-directed merged checkout policy, and ambiguity is a hold.
- Read-only scope — invariant; basis: irreversible-consequence; evidence: an advisory verdict must not authorize deletion or change checkout custody.

## Multi-machine posture

The report reads an explicit host-qualified snapshot and can run anywhere. It preserves the evidence host and does not offer a fleet-wide view or transfer authority.

## Open questions

*(none)*

## Verification

Run the normal command against eligible, recent, stale, mismatched and missing evidence. Verify the input remains byte-identical and output has no deletion or archive effects.

## Maturation plan

- **test-agent-live:** replay controlled positive and negative snapshots through the CLI.
- **dev-agent-live:** replay a Studio audit snapshot and compare its holds against source evidence.
- **fleet:** ship as a manually invoked report command, with no scheduler or mutation capability.
- **graduation criterion:** controlled verdicts match their fixtures and the Studio replay identifies unknown inputs as holds.
- **dark-window:** no runtime enablement. Report verification precedes shipment.
- **ladder:** fixture replay, development-agent evidence replay, then manual CLI availability.

## Running the report

Run `node scripts/report-merged-worktrees.mjs SNAPSHOT.json [ISO_TIME]`. The snapshot has a `host` string and `worktrees` array. Each row carries a unique `path`, full lowercase `head` SHA, and `generation` identity. Its optional `evidence` repeats the head and generation, supplies `observedAt`, `validUntil`, `mergedAt` and `verifiedIdleMs` in milliseconds, and explicitly asserts `trustedMergedPr` and the seven guards named in the command. The supplying collector owns those attestations. A legacy audit that lacks them can still be replayed and produces hold reasons. Use a fresh trusted snapshot when interpreting a positive verdict.
