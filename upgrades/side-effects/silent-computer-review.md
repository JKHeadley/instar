# Silent Computer Review Side Effects

Tier1: reversible dashboard rendering and reminder dismissal. The dependent security server owns phone authority and eligibility; this branch neither grants nor duplicates either owner action.

Reads: adds GET /pin-budget/silent-machines on Machines and the Needs composer. The source is pool-merged signed-contact evidence. Unreadable source reports could-not-check; incomplete evidence remains explicit. No local date inference is used.

Writes: only the existing server's fingerprint-bound reminder dismissal. Dismissal changes reminder visibility, not pairing, confirmation or PIN authority. A stale list reloads; failures preserve the review. Late navigation responses are ignored.

Migration: no new configuration or persistent schema. An awareness fragment joins the existing generated template and update pipeline. Installations without the dependent route receive an honest could-not-check state; dependency ordering prevents releasing that interim state.

Rollback: revert this UI candidate to remove the source, panel and awareness entry together. It does not revert server security state or revive dismissed reminders. Keep server PR3672 and its independent security rollback plan separate.

Validation: 220 targeted unit tests, six Needs HTTP composition tests and one existing production Needs lifecycle test passed. Three independent reviewers concurred after fixes for partial evidence and refreshed keyboard focus. Four actual-browser cases at390 and1280 pixels in both themes passed, including dismissal focus and status. Private evidence: .instar/dashboard-makeover/silent-review/geometry.json in the agent checkout. No full-suite or release clearance is claimed here.

## Decision-point inventory

Adds response-shape validation and reminder visibility rendering; passes server show and eligibility through. Modifies Needs completeness reporting for this source only. Adds fingerprint-dismiss result handling and navigation guards. Does not add authority over either phone action.

## 1. Over-block

Malformed data produces an unknown notice, not a security denial. Disabled server short responses remain supported. No eligibility is inferred from client dates. A missing display name uses a plain fallback.

## 2. Under-block

This UI cannot establish pooled contact truth or phone presence. The dependent server enforces both. Explicit success is required before reporting reminder dismissal; malformed success and rejected requests preserve the review.

## 3. Level-of-abstraction fit

The shared read model prevents the panel and Needs adapter from disagreeing about readable data. The server remains the authority for silence, dismissal fingerprints and phone action eligibility. Existing verifiedDisplayName supplies safe names.

## 4. Signal vs authority compliance

No block/allow surface. This change displays server evidence and reminder state. It never transforms missing evidence into approval or applies either owner choice. See docs/signal-vs-authority.md.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Response validation checks enumerable API shapes; server show and evidenceComplete remain authoritative inputs. Client time never decides eligibility.

## 5. Interactions

Shadowing: the review precedes ordinary machine cards and survives an unavailable pool. Double-fire: one source and one reminder represent the whole agent; double taps send one pending dismissal. Races: the rendered fingerprint binds dismissal to the displayed list, list-changed refreshes, and lifecycle checks ignore replies after navigation. Feedback: incomplete source reads mark Needs partial while retaining known requests; dismissal changes only reminder visibility.

## 6. External surfaces

Machines and the console/phone Needs read gain the source. Existing agents receive its awareness through the generated awareness pipeline. No direct Telegram, Slack or external service sends are introduced. Reminder dismissal reaches the dependent server's persistent reminder state; no local schema changes. The phone completes both owner choices using the security dependency and Apple's separate screen work; this dashboard directs the owner there and cannot substitute for Face ID.

## 6b. Operator-surface quality

1. Leads with the primary action: the review is expanded at the beginning of Machines, with the phone instruction immediately below its title and the reminder dismissal above the computer list. The deep link scrolls to it even when the ordinary pool is unavailable.
2. Zero raw internals as primary content: only verified display names and plain fallback names appear. Fingerprints and computer identifiers never appear as labels. HTML-like names use text nodes.
3. Destructive actions de-emphasized: the dashboard has no retirement or gone-for-good action. Its quiet reminder-dismiss button cannot perform those choices; the phone owns their secure confirmation.
4. Plain language and phone width: four real Chrome cases at390 and1280 pixels in both themes had no horizontal overflow. Long names wrap, confirmed status stays readable, and dismissal has a full tap target. Empty status decoration is hidden; result text is announced and focus returns to the review or heading.

## 7. Multi-machine posture

Pool-merged: one agent-wide source uses the server's merged signed contact records. An unreadable computer is explicitly unknown through evidenceComplete and Needs couldNotCheck. This UI emits no notices, holds no independent durable state and uses a relative Machines URL that follows the serving agent across machines. Dismissal state and replication belong to the server dependency. No status, health, capabilities or channels answer is changed.

## 8. Rollback cost

Revert the source, adapter and awareness together in a patch release. No local migration or agent reset is needed. The reminder disappears from this UI until restored. Server pairing, confirmations and reminder state are untouched by rollback.

## Conclusion

Review corrected partial evidence propagation and keyboard focus after dismissal. Three independent reviewers concurred. The UI is ready for dependency-ordered complete verification, not a live-release claim. Server PR3672 and the separate phone UI remain prerequisites for the complete owner flow.

## Second-pass review

Not required for this Tier1 UI change; three independent code review angles were completed through the build workflow.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. No self-triggered controller was added or modified.


## Main Merge Conflict Repair — 2026-11-23

Merged current main aa1f50b67876c8f66621c85df1bdbf145c0d66af normally after the coordinator confirmed a supported hold with no active run or reservation. The CSS conflict contained only independent additions after an identical base. Both complete additions are retained: this candidate's styles and main's Needs you grouping styles. Any Git directory-rename suggestion for this candidate's release fragment was corrected by preserving its original bytes under upgrades/next. No action, eligibility, permission or source model was changed by the resolution. Independent review concurred. Focused checks and browser evidence are recorded separately before the new exact-head handoff; earlier full results do not clear this new candidate.

Current repaired-candidate evidence: 221 focused unit checks, 6 HTTP composition checks, 1 production Needs lifecycle check and 4 browser width/theme cases passed; independent SMALL review concurred; phone server remains separate dependency. These are supporting checks; the new exact head still requires normal complete verification.
