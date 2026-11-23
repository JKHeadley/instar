# Side-Effects Review — Responsive Detail Page Grids

Date: 2026-11-22. Author: echo. Tier 1, reversible presentation change.

## Summary
Use available content width on informational detail pages. Shared auto-fit grids use a26rem card minimum, which responds to content width and text size. Accounts have one card per account inside provider groups; Health, machine care, Ideas, Notifications and Maturation use the same grid where their custom structures previously bypassed section grids. Dedicated workspaces remain isolated. No server routes or source reads change.

## Decision-point inventory
The route identifies informational details versus dedicated workspaces for layout only. No authorization, execution or information-filtering decision changes. Card order remains DOM order.

## 1. Over-block
No block/allow surface. Controls retain their handlers, focus keys and source actions. Narrow screens wrap content rather than withholding it.

## 2. Under-block
No block/allow surface. The grid does not validate source data, permissions or account usage. Existing models remain responsible.

## 3. Level-of-abstraction fit
The shell selects the detail layout; shared CSS owns card sizing. Custom page wrappers opt repeated records into that layout. This avoids viewport thresholds that forget sidebar width.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. Presentation only, no blocking authority or heuristic approval judgments.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Choosing columns from available width is an enumerable layout calculation, not an action policy.

## 5. Interactions
Shared page-sections keep non-card headings, controls and marked owner-action sections across the full row. Single-record grids fill their row. Account meter resets move beneath their own percentage line to fit a card; meter value order and source data are unchanged. Health request cards retain their leading DOM positions and can share the first grid row; no informational card is moved before a request. Dedicated chat/file/session/board/document workspaces are excluded, including normalized phone aliases.

## 6. External surfaces
The web console detail pages use more of a wide window. Native Apple implementation is separate and coordinated around the same available-content-width principle; its numeric minimum is not imposed on web. No API schema change.

## 6b. Operator-surface quality
Multiple meaningful records appear side by side where readable. Each retains a name and its original actions. Small screens use one column. Paragraphs remain readable inside wider surfaces. No new technical labels are added to user flows.

## 7. Multi-machine posture
Dashboard assets ship to each server through normal releases. Each page reads exactly the same pooled or local sources it did before. No durable state, machine-local workflow or cross-machine URL changes.

## 8. Rollback cost
Normal code revert and release; no migration or data repair.

## Review and validation
Three independent reviewers checked correctness, layout/accessibility and missing wiring/tests. Reviews found Ideas, Notifications and Maturation custom layouts outside the first grid pass; these were included. A route regression verifies detail pages and canonical/phone-alias workspace exclusions. Focused tests and browser geometry evidence are recorded in the PR. Complete verification remains with the throughput coordinator; preview and targeted tests are not a full-green or release claim.

Final source validation:135 unique focused tests across8 files passed (Accounts, shell, Machines, Health, machine care, Ideas, Notifications and Maturation); the final Notifications-only rerun also passed2 tests after moving its heading outside the repeated-card grid. All3 reviewers found no remaining material issue after corrections. Browser geometry passed53 cases: Accounts, Machines, Health, Allowed and Plans at390/980/1280/1600/2200 pixels in light/dark; two1600px larger-text cases; one single-account fill case. No horizontal page overflow. Plans owner-action sections span the whole grid. The single account fills1254px of available grid width. Accounts has1 column at390 and980,2 at1280 and1600,4 at2200; larger text reduces its record grid to1 at1600. Private source-preview geometry/screenshots are at .instar/dashboard-makeover/detail-grids under the agent home, using captured read-only data. These are not released live checks.


## Main Merge Conflict Repair — 2026-11-23

Merged current main aa1f50b67876c8f66621c85df1bdbf145c0d66af normally after the coordinator confirmed a supported hold with no active run or reservation. The CSS conflict contained only independent additions after an identical base. Both complete additions are retained: this candidate's styles and main's Needs you grouping styles. Any Git directory-rename suggestion for this candidate's release fragment was corrected by preserving its original bytes under upgrades/next. No action, eligibility, permission or source model was changed by the resolution. Independent review concurred. Focused checks and browser evidence are recorded separately before the new exact-head handoff; earlier full results do not clear this new candidate.

Current repaired-candidate evidence: 284 focused checks and 23 browser geometry cases passed; independent SMALL review concurred. These are supporting checks; the new exact head still requires normal complete verification.
