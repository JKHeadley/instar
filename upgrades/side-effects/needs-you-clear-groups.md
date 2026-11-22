# Side-Effects Review — Clear Needs You Groups

Date: 2026-11-22. Author: echo. Tier 1, reversible display repair.

## Summary
Group the expanded Needs-you list by structured source/severity, bound its height and preserve keyboard position. A tracking-only project with autoAdvance:false and no scheduled launch does not create a first-launch ask. Unacknowledged advances, scheduled launches and explicit owner asks remain. No state mutation. One review round found incorrect group wording and keyboard focus/refresh issues; these were corrected and re-reviewed.

## Decision-point inventory
The projectNeedsOk display predicate consumes explicit project settings and scheduled-launch state. No approval authority changes. needGroups only labels received rows; it neither filters nor deduplicates them.

## 1. Over-block
No action block/allow surface. Tracking projects with a scheduled launch remain visible. An unknown autoAdvance setting retains existing conservative behavior. Explicit needsUser and awaiting-user asks still appear.

## 2. Under-block
No action block/allow surface. A tracking record may still contain an explicit stale ask; resolving its authority is outside this presentation logic and remains visible.

## 3. Level-of-abstraction fit
Pure console models are already loaded by the Needs route. Display grouping lives in the strip, not source permissions. No second inbox or count is introduced.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. This is a read-only signal display. ProjectRoundRunner retains first-launch and advancement authority. No text heuristics judge whether an ask is legitimate.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. An explicitly unscheduled tracking project has no requested first launch; the enumerable display condition does not authorize one.

## 5. Interactions
All received actions, card links, page cursors and incomplete-read notices remain. Successful polling preserves a focused action or scroll region; access denial still clears it. Unknown sources receive Other requests.

## 6. External surfaces
The expanded web dashboard list changes visually. The shared /needs model no longer counts unscheduled tracking launches as owner tasks, so other clients receive the corrected count too. No API schema changes.

## 6b. Operator-surface quality
Compact line stays the entry point. The expanded list has descriptive headings and bounded scrolling. Work-board rows say Work that needs you, covering approvals, questions and completion checks. No technical identifiers added.

## 7. Multi-machine posture
Presentation ships in dashboard assets. Needs routes load the same console model per agent server; source replication and pool reads are unchanged. No machine-local state or links are added.

## 8. Rollback cost
Revert the code and redeploy normally. No migration, source-state edits or approval repair is required.

## Validation and review
68 focused tests passed across console-plans, console-needs-pages and needs-read. Includes a real server composer test with tracking, scheduled and explicit owner requests, mixed-source grouping, paging, denied reads and scroll-position preservation. Three independent reviewers checked correctness, gaps and missing tests. Correctness and accessibility reviewers re-read corrections and concurred. Complete verification will run through the throughput coordinator; targeted checks are not a full-green claim. Browser previews use captured live /needs data and current source assets, not a released deployment.
