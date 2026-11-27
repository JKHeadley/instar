---
title: "Sign-in repair: reopen an incident that admission bookkeeping cancelled while the account is still signed out"
slug: "relogin-reopen-cancelled-incident"
author: "echo"
parent-principle: "Close the Loop"
eli16-overview: "relogin-reopen-cancelled-incident.eli16.md"
status: "converged"
parent-spec: "docs/specs/skill-driven-signin-repair.md (the repair that needs an open incident); docs/specs/relogin-unattended-agent-session-and-slow-retry.md (the slow retry that resumes)"
review-convergence: "2026-11-27T00:21:42.692Z"
review-iterations: 3
review-completed-at: "2026-11-27T00:21:42.692Z"
review-report: "docs/specs/reports/relogin-reopen-cancelled-incident-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (Subscription Management, Mac M5 Pro), 2026-11-26, after reading the three-round convergence report. The agent approves its own converged spec under 2.0 Rule 82: it touches neither the constitution nor a CODEOWNERS path and adds no authority. The Chief of Staff instructed this fix at 14:43 PT."
---

# Reopen a cancelled incident while the account is still signed out

## Problem

An automatic sign-in repair can start only from an open sign-in incident: a record in the per-machine `SubscriptionLoginLedger` that the account's login failed. The repair's admission check requires that record to be `exchange-corroborated` and directly `observed`.

`SubscriptionLoginLedger.reconcileAdmission` runs on every quota poll. When a previously admitted cell drops out of a poll's admitted set, it closes that cell's open incident with outcome `cancelled`. A cell drops out when it is missing from that scan, not eligible, or past the 64-cell limit. When the cell comes back on the next poll, nothing reopens the incident. Incidents are opened only on a status transition (`recordStatus` / a `transition-to-needs-reauth` poll outcome). An account that is still `needs-reauth` makes no transition, so it never gets a new incident. Its repair shows `no-open-incident` forever, and the slow retry of its failed repair is unscheduled ("source closed").

Live evidence: on the Mac Mini, one account's incident 32 (exchange-failed, exchange-corroborated, observed) was opened 2026-11-25 16:12Z. It was closed `cancelled` at 2026-11-26 03:55:58Z while the account stayed `needs-reauth`, and the slow retry of repair 07a05cb5 was unscheduled at 03:56:09Z. The account is still signed out. The Laptop's account A cell shows the same `no-open-incident` blocker.

## Change

1. `reconcileAdmission` cells gain an optional `needsReauth` flag. `QuotaPoller.pollAll` sets it from the pool status (`account.status === 'needs-reauth'`).
2. For each admitted cell with `needsReauth`, inside the same transaction, the latest incident is reopened only when all of the following hold:
   - the cell has no open incident;
   - its latest incident's outcome is `cancelled`, which has exactly one writer, the eviction branch of `reconcileAdmission`, so a cancelled incident always means the bookkeeping drop-out;
   - **no recovery has been seen since the cancellation.** Two signals carry this. The first is the pool status, which the caller checks: every path that sees a recovery (a clean poll, a successful repair, a manual sign-in through enrollment) sets the account `active` again, so a status still at `needs-reauth` means no recovery was seen, however long the cell was away. The second: no clean or mixed coverage row for the cell since the cancellation. Coverage `clean` also covers a failed exchange that opens a new incident, in which case the latest incident is no longer the cancelled one anyway, so the rule reads it as "something newer happened", not strictly "a recovery". "Every path that sees a recovery" means every path the system accepts as one; a clean read on a held account (an expired-login or device-limit hold) is deliberately not one. A `mixed` bucket counts as a possible recovery, the conservative reading of a bucket that straddles the cancel. A recovery seen in between means the old evidence no longer describes the account, and the next real failure opens a new incident through the normal transition. The rule does not require a failed read of any particular kind, so it does not depend on how each incident cause shows up in coverage.

   The reopen clears `closedAt` and `outcome` and keeps the original cause, corroboration and provenance. The `relogin-reopened` event records the closure it undid (`repairState: reopened-from-cancelled-at:<closedAt>`), so the history stays complete. A `resolved` incident is never reopened. A cell with no incident gets none: an account that is signed out with no incident at all is a different gap, out of this change's scope. An open incident is left alone.
3. Nothing else changes. Once reopened, the existing paths take over, as read in `SubscriptionReloginService.slowRetryDue`. A failed repair row whose slow retry was unscheduled is eligible again when its source incident is open, its retry count is under the limit, and it has not been challenged since admission. Its next try is computed from its own failure time (`finishedAt + delay`, or now plus delay and a per-cell offset when overdue), never from the reopen. So a cell that drops out and returns does not keep pushing its retry later. The retry count and history stay on the same repair row.

## Why reopen rather than open a new record

A new record opened from the pool status alone would carry weaker evidence (`status-preexisting`, not `observed`), and the admission check would rightly refuse it. The cancelled record's evidence was real: an exchange that failed, observed on this machine. It was closed only by bookkeeping, and nothing has shown the account recovered since. Reopening restores the true state without inventing evidence.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Reopen the latest incident when it was cancelled and the account is still needs-reauth | invariant; basis: enumerable-domain; evidence: the incident outcome is one of open, resolved or cancelled, and the pool status is needs-reauth or not | Reopens only a record closed by bookkeeping; never a resolved one |
| Which repair rows recover after a reopen | invariant; basis: enumerable-domain; evidence: a failed row resumes through the slow retry; a row cancelled by source-incident-closed is re-admitted; an operator-cancelled, refused or succeeded row is unchanged | Operator intent is never overridden |
| No clean or mixed read since the cancellation | invariant; basis: enumerable-domain; evidence: the coverage authResult per bucket is clean, mixed, credential-absence or null; mixed is read as a possible recovery | A recovery in between blocks the reopen |
| Re-admit a source-closed cancelled repair at most once per row | invariant; basis: irreversible-consequence; evidence: each re-admission can start a helper that types a password; once bounds a flapping cell to one extra drive | A second cancel stays cancelled |

## Frontloaded Decisions

1. Reopen the existing record, not open a new one, for the evidence reason above.
2. Keyed on the pool status the poller already reads. No new signal, setting or route.
3. No age, gap or read-type rule. Each was tried in review and rejected, because the pool status already carries continuity (see Change 2) and a fixed window has no derivation. The live Mac Mini cell qualifies: cancelled at 03:55:58Z, still needs-reauth, and nothing has read it clean since.
4. Reopen after the fact, not only prevent the cancel. Not cancelling on a single missed poll (a debounce) is the better root fix, and it is tracked as CMT-040. But it would not repair cells already stuck today (the Mac Mini), so the reopen is needed either way. If the debounce lands, the reopen remains as a backstop for any other drop-out.

## Open questions

*(none)*

## Risks

- **A loop of reopen and repair.** Two paths, two bounds. A failed repair resumes only through the slow retry: at most 3 retries per incident, 6 hours then 24 hours apart, none after a challenge, none in quiet hours. A repair cancelled mid-run by a drop-out is re-admitted directly, with fresh budgets, which skips those limits, so it is allowed only once per repair row. A cell that keeps flapping therefore gets at most one extra drive from this change. Reopening by itself starts nothing.
- **The re-admission resets an earlier challenge on that row, once.** `candidate-readmitted-source-reopened` is an admission marker. So a row that hit a challenge, was resumed by the operator and was then cancelled by a drop-out no longer counts that challenge toward a later slow retry. This is accepted: it happens at most once per row, the provider's challenge would stop the run again, and the existing `candidate-readmitted-inputs-changed` path already behaves the same way.
- **Reopens of the incident itself are not limited** (only repair re-admission is); each flap adds one `relogin-reopened` event, which is the churn signal in the graduation criterion and CMT-040.
- **Cells this does not reach, tracked:** a signed-out cell with no incident at all, and a repair row whose second source-closed cancel stays cancelled. Both are tracked as CMT-041 on the Mac M5 Pro, decided together with the CMT-040 debounce that stops the cancel at its source. <!-- tracked: CMT-041 (origin m_a804869356b259820b3236e7c5a2ae7d) -->
- **A stale `needs-reauth`.** If the account recovered without the pool noticing, the repair's own checks (the live login check, identity verification) find it signed in. The repair then ends `resolved-elsewhere`, and the first poll that reads the account cleanly resolves the incident.
- **Not reopened alongside:** the credential read window that the same drop-out cancelled stays closed (window 6 on the Mac Mini; window 7 is a new one opened afterwards). The incident is what admission reads.
- **Cancels leave no ledger event, reopens do:** a flapping cell therefore shows reopen events without matching cancels. CMT-040 covers adding a cancel event.
- **Unknown cause of the drop-out.** Why the Mac Mini cell left the admitted set at 03:55Z is not established (a scan missing the account, or a brief status change). This change makes that harmless, whatever the cause, and it does not hide it: the `relogin-reopened` event marks every case. Finding the cause is tracked separately as CMT-040 on the Mac M5 Pro (due 2026-12-01), using the Mac Mini server log and the reopen events. That includes the deeper question of whether bookkeeping should cancel an incident for a cell that drops out of a single poll at all. Reopening stays correct either way: an incident should be open while an account is signed out, whichever path closed it. <!-- tracked: CMT-040 (origin m_a804869356b259820b3236e7c5a2ae7d) -->

## Testing

- Unit, `tests/unit/relogin-reopen-cancelled-incident.test.ts`:
  - records the undone closure on the event; refuses after a clean read since the cancellation; reopens after a long gap when nothing showed a recovery; reopens an incumbent on a later poll (the live case);
  - a repair cancelled by `source-incident-closed` is re-admitted once with unchanged inputs, and not a second time; an operator-cancelled one stays cancelled;
  - reopens the same incident with the original fields;
  - is idempotent across later scans;
  - never reopens a resolved incident;
  - never reopens when the account is no longer signed out, or when the field is absent;
  - does nothing for a cell with no incident.
- The existing ledger and quota-poller tests are expected to pass unchanged. They run in Local Verify, because the M5 is reserved for the shared test line.
- Live proof after update: account A on the Mac Mini shows `relogin-reopened`, and its repair then runs by itself. Its incident 32 was cancelled on 2026-11-26 03:55:58Z. The reopen and the following repair attempt are recorded as separate observations. The Laptop is conditional: its `no-open-incident` blocker does not show its latest incident is a recent cancellation, so its ledger is checked before any claim (tracked as CMT-039 on the Mac M5 Pro). <!-- tracked: CMT-039 (origin m_a804869356b259820b3236e7c5a2ae7d) -->

## Maturation plan

- **test-agent-live:** the unit test drives the real ledger on a real SQLite file, the same as a throwaway agent would.
- **dev-agent-live:** from the release that carries it, on every machine of this agent. The Mac Mini account A cell is expected to show relogin-reopened on the first poll after the update; the Laptop cell only if its ledger shows its latest incident was cancelled, which is checked first.
- **fleet:** the same release, ungated (Frontloaded Decision 2). It restores state that existing rules already depend on, and adds no authority.
- **graduation criterion:** within 48 hours of the update, at least one cell shows relogin-reopened followed by a repair attempt that the unchanged admission check accepted. Reopen counts per cell are read alongside admission drop-outs: more than one reopen per cell per day is a signal of admission churn, reviewed under CMT-040, not a repair failure.
- **dark-window:** none. If the criterion is not met within 7 days, the reason is recorded on CMT-039.
- **ladder:** not applicable: a correctness fix with no setting, live on release

## Rollback

Revert the PR. A reopened incident stays open until a poll resolves it, or until a later drop-out cancels it again (the old behaviour), which is the correct state for a signed-out account either way. No data migration.

## Multi-machine posture

The pool status the poller passes is this machine's own: the same account shows `needs-reauth` on one machine and `active` on another in `GET /subscription-pool?scope=pool` today (account A on 2026-11-26), so a peer's status does not set it. If a stale status ever reached this check, the repair's own live login check would end it `resolved-elsewhere`.

machine-local, physical-credential-locality: the ledger records sign-in incidents for the logins on that machine's own disk, and each machine reopens only its own cells.

## Carriers

> **Carrier (frozen excerpts: the work the tracked markers in this spec point at, commitments on the Mac M5 Pro):** <!-- tracked: CMT-039, CMT-040, CMT-041 -->
>
> **CMT-039** — "A account A repair (Mac Mini or Laptop) that ran by itself with its audit trail, via this fix, by 20:00 PT Friday 2026-11-27; tell the Chief of Staff by noon Friday if the test line slips."
>
> **CMT-040** — "Find why the Mac Mini account A cell left the poller's admitted set at 2026-11-26 03:55:58Z, and decide whether admission bookkeeping should cancel an incident for a cell that misses a single poll at all (a debounce)."
>
> **CMT-041** — "Close two gaps left by this fix: a signed-out cell with no incident at all, and a repair row whose second source-closed cancel stays cancelled; decide each with the CMT-040 debounce."
>
> (Regenerate `docs/specs/carriers/relogin-reopen-cancelled-incident.json` with `node scripts/refresh-carrier-ledger.mjs relogin-reopen-cancelled-incident CMT-039 CMT-040 CMT-041`.)

