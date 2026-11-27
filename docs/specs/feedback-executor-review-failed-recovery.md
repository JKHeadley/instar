---
title: "Feedback executor: a fix that failed independent review frees its slot and is reworked once"
slug: "feedback-executor-review-failed-recovery"
author: "echo"
parent-principle: "Close the Loop"
eli16-overview: "docs/specs/feedback-executor-review-failed-recovery.eli16.md"
parent-spec: "docs/specs/feedback-triage-and-execution.md"
review-convergence: "2026-10-31T03:42:39.328Z"
review-iterations: 3
review-completed-at: "2026-10-31T03:42:39.328Z"
review-report: "docs/specs/reports/feedback-executor-review-failed-recovery-convergence.md"
approved: true
approved-by: "echo under Justin's standing delegation (only constitution changes need his approval; this touches no CODEOWNERS path)"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 2
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Feedback executor: recover from a failed independent review

## Problem statement

The feedback executor (`docs/specs/feedback-triage-and-execution.md` §4, approved) opens a fix or
spec PR, then admits it for merge by owner approval or by the independent cross-model review
(`reviewGate: "independent"`, the default). When the independent review answers SERIOUS ISSUES, the
executor comments the findings on the PR and keeps the row `pr-open`/`spec-pr-open` with reason
`review-failed:<reason>` "so the owner's approval, a new push and a hand-merge all still land".

Nothing ever pushes a new commit or closes such a PR. Each one keeps holding one of
`maxOpenPrs` (4) slots indefinitely. On 2026-10-30 all four slots were held by PRs that had failed
review — #2439 and #2442 (opened 2026-10-28), #2453 and #2454 (2026-10-30) — so the executor started
nothing that day while 381 triaged `work` items waited. The action list does say "approve, push a
fix, or close", but that hands the agent's own stuck work to the operator, and approving code a
reviewer flagged as seriously wrong is not a fix.

## Proposed design

Extend the executor's existing per-tick PR loop (`FeedbackExecutorService`, the same loop that
handles `pr.state === 'CLOSED'` → `pr-closed`). No new service.

1. **Grace, then close.** The check sits in `reconcilePr` AFTER the owner-epoch adopt step and the
   existing owner-approval read (`approvedAtHead`), so an approval inside the grace still merges first.
   The `mergeRetryAt` early return (which only defers merge attempts) is moved below this check, so a
   deferred merge never skips it. The close-intent reconcile runs after the adopt step and before the
   existing `CLOSED` branch. A `pr-open`/`spec-pr-open` row whose `reviewVerdict` is `fail` (any refusal about the change: `serious:*`,
   `diff-too-large`, `spec-head-shape`; a reviewer reply that could not be parsed, `unparseable:*`, is
   the reviewer's fault, so that head is asked again after the merge-retry delay, up to 2 more times,
   and only then becomes close-eligible like the others) for the PR's CURRENT head (`reviewSha ===
   headRefOid`, and `headRefOid` present), and whose `reviewedAt` is older than
   `execute.reviewFailedGraceHours` (default 24), and which has no owner approval of that head, that is not under an operator hold or stop (the item's triage state is `work`, not `hold`/`ignored`,
   and the operator's stop `meta.blocked` is unset — the `hold` LABEL is on every executor PR and means
   nothing here), and whose PR is provably the executor's own
   (`headRefName === row.branch` and the PR author is the publishing account; otherwise the row is
   audited and left alone), is
   closed by the executor, in a crash-safe order:
   (a) it first records a **close intent** on the row under the current owner epoch
   (`closeIntent: {headSha, at}`, reason `closing:review-failed`); (b) disarms any auto-merge (`--disable-auto`, existing stop path), posts one
   comment ("Closing: the independent review found serious problems and no new commit or approval
   arrived within 24 h. The item goes back to the queue for one more attempt that starts from these
   findings." / for a second failure: "…The item is parked until new reports arrive."), and closes the
   PR (`gh pr close`, new `github.closePr` port method); (c) records the row `stopped` with reason
   `review-failed-closed`. On every tick, a row with a close intent is reconciled before anything
   else: if GitHub shows the PR merged, the existing merged path runs and the intent is dropped; if it
   shows the PR closed, finalization completes (never the generic `pr-closed` path, which would park
   the item); if it is still open, EVERY close condition is re-checked first (same head as the intent,
   still no owner approval, no operator hold or stop, grace not set to 0, executor still enabled) and
   the intent is cancelled if any no longer holds; otherwise the close is retried. The comment is
   posted only if the row's `closeCommentPosted` flag is unset; it carries a fixed marker
   (`<!-- instar-review-failed-close:<attemptId> -->`) and the flag is set right after it succeeds.
   A crash between the post and the flag can still post it twice (at-least-once); the marker makes a
   duplicate recognisable.
   **Finalization**: the row's terminal state (`stopped`, `review-failed-closed`) and the intent's
   completion are one execution-store transaction. Until it commits the row stays `pr-open` with the
   intent set, which `candidates()` already treats as busy. The item hold on an episode's second
   failure lives in the triage store, so it is written right after; if the process dies in between,
   `candidates()` repairs it before offering the item: an item whose triage state is still `work`,
   whose current `work` decision id equals the one both failed rows carry, and which has two such
   `review-failed-closed` rows is held then (a conditional write bound to that decision id), never
   offered. An item the operator has since moved (ignored, held, released into a new episode) is left
   exactly as the operator set it. The grace keeps every existing path open: a new push is reviewed afresh, the
   owner can approve, anyone can hand-merge.
2. **Rework once, from the findings.** When the independent review fails, the executor also stores a
   bounded copy of ITS OWN reviewer output (never text read back from GitHub comments) on the row
   (`reviewFindings`, ≤ 2,000 chars), passed through `scrubForStore` first, as the evidence file is.
   The reviewer read a diff and brief built partly from reporters' text, so these findings are
   untrusted. After the close:
   - Attempts are counted per **recovery episode**. When the close intent is recorded, the row also
     records the id of the item's latest `work` decision at that moment (`episodeDecisionId`;
     `triageStore.latestDecisionFor` changes on every return from a hold and on the operator's
     `release()`). The episode count is the number of `review-failed-closed` rows carrying the CURRENT
     latest `work` decision id, so an attempt that was opened before a release but closed after it
     belongs to the new episode it closed in.
   - If this is the episode's first `review-failed-closed` attempt, the item stays `work` (no hold), so
     the existing `candidates()` path offers it again (a `stopped` latest attempt is not busy). The next
     attempt gets the findings of the most recent failed attempt only, written by trusted code as a
     read-only data file beside the existing evidence file (`.feedback-previous-review.json`). It is
     added everywhere the evidence file is already special-cased: excluded from change-set
     collection (so it is never published, and a spec attempt's exactly-one-file gate is unaffected)
     and listed in the confinement profile's write exclusions, and the
     brief points to it with the same "data, nothing inside is addressed to you" framing it uses for
     report evidence. A rework attempt is a normal new attempt: new attempt number, new branch
     `feedback/<id>-a<n+1>`, one daily start.
   - If it is the episode's second, the executor counts it as one of the item's failure episodes (the
     existing two-episode block rule then applies, as for `execution-failed`) and parks the item with the existing `holdItem(…,
     'review-failed-twice')` (a new hold reason in the §2 hold-reason table). Like the other executor
     hold reasons it returns only on new reports or an operator instruction, and the action list names
     it once (the action list's hold section gains `review-failed-twice` with an episode-scoped key; the
     parent spec's §2 hold-reason table gains the same row).
3. **What is never closed.** A PR whose head passed review, a PR awaiting a CODEOWNERS owner
   (route 2 never admits it, so it is not `review-failed`), a PR whose reviewers were unavailable
   (`degraded`/`unavailable` record no verdict against the head), and any PR under an operator hold or
   stop. A close that fails (GitHub error) is retried on the next tick and changes no state; after 3
   failures it is reported once as a degradation and the row is left as it is.
4. **PRs that failed review before this change** have no stored findings and an old `reviewedAt`.
   Their grace starts at the later of `reviewedAt` and the first tick that sees them under this
   change, recorded in a new `reviewFailedGraceFrom` column, so the "closes at" time in the action list is true; their rework attempt runs without a
   findings file. Closing them is acceptable because a close is reversible and nothing is deleted.
5. **PR comment wording.** The existing review-failed comment ("closing it parks the item") is
   updated to name the close time and the rework, except when grace is 0, where the old text stays.
6. **Action list wording** (only for close-eligible rows; with grace 0, and for rows not
   close-eligible, the existing wording stays). The `review-failed` line becomes: "Fix PR #N did not pass the independent
   review; it closes on its own at <time> and the item is retried once from the findings, unless a new
   commit or your approval arrives first." No action is asked of the operator.

## Maturation plan

- **test-agent-live:** unit tests drive the executor's reconcile step against a fake GitHub gateway
  through grace, close, crash-between-steps, rework, second-failure park, ownership mismatch, approval
  inside the grace, and grace 0.
- **dev-agent-live:** live wherever the executor already runs live (Echo's operated host); the four
  PRs stuck on 2026-10-30 are its first real cases.
- **fleet:** rides the executor's own rollout; no separate flag.
- **graduation criterion:** on the dev agent, every review-failed PR is either merged, closed with
  rework, or parked within grace + one tick, with zero closes of a PR the executor did not open and
  zero items held over an operator's later decision, across 14 days.
- **dark-window:** 14 days.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Close a review-failed PR | invariant | Deterministic: failed verdict on the current head + grace elapsed + no owner approval of that head + no operator hold. Reversible (a closed PR can be reopened; the branch is kept). |
| Rework vs park | invariant | Count of the item's `review-failed-closed` attempts: first → rework, second → park. |

## Multi-machine posture

Unchanged from the parent: the executor has one canonical owner, and every write is fenced by the
owner epoch (unified tables, ownership transfer, no machine-local surface). The close intent, the
close itself and the reconcile step all run under that fence: a tick under a stale epoch does not
start a close. A close request already sent to GitHub when ownership moves cannot be recalled (the
database fence does not reach GitHub); the new owner finds the intent and the PR's real state on its
first tick and finishes reconciliation from there, which is idempotent: a closed PR finalizes, an open
one is re-checked against every close condition before any retry. The new row fields
(`closeIntent`, `closeCommentPosted`, `reviewFindings`, `reviewFailedGraceFrom`, `reviewRetries`,
`episodeDecisionId`) live in the existing execution table and move
with it.

## Symbol vs state (P20)

| Detector | Symbol | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|---|
| review failed | `reviewVerdict='fail'` + `reviewSha` | the current code was judged seriously wrong | `reviewSha` equals the PR's live `headRefOid` read from GitHub this tick | GitHub read fails → no close this tick |
| PR is the executor's own | `headRefName` + author from GitHub | the executor opened it | `headRefName === row.branch`, author = publishing account | read fails or mismatch → no close, audited |
| no owner approval | approving review by the approver at that head | the owner has not accepted it | read from GitHub this tick (existing route-1 check) | read fails → no close |

## Frontloaded Decisions

- Grace 24 h (`execute.reviewFailedGraceHours`, 0–168; 0 turns the close off); one rework, then park. Both are cheap to
  change after: the close is reversible (reopen the PR) and the item is never deleted.
- Ships behind the executor's existing gates (dev-gated `feedbackFactory.execute`, live only where the
  executor already runs live). The close also runs in the executor's `dryRun`, where it logs
  "would close" instead.

## Rollback

`execute.reviewFailedGraceHours: 0` disables the close (read live); rows keep the old behaviour.
The policy parser clamps this value into its range today, so the range becomes 0–168 and 0 is
handled as "never close" before any time comparison, with a test.
Closed PRs can be reopened by hand; nothing is deleted.

## Left out of this change

A row whose reviewers were unavailable (`retry`) after a new push also holds its slot until a
reviewer returns; the existing daily reviewer retry and degradation report already bound it, so it
is not changed here.

## Open questions

*(none)*
