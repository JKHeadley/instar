# Side-Effects Review — Readable Notification Previews

Tier1: narrow, reversible presentation change. No authority or persistent schema changes.

## Summary of the change

notifications.js renders bodies over320 code points with a220-codepoint preview and native full-text disclosure after plainReferenceText resolves display names. Short text stays open. console.css supplies a44px disclosure target and wrapping. Removes the raw original-text hover tooltip.

## Decision-point inventory

Adds an enumerable display-length boundary only. No source selection, severity, unread status, access or permission decision changes.

## 1. Over-block

No block/allow surface. Full text remains available at both sides of the display boundary. Short notices need no extra tap.

## 2. Under-block

No security gate is added. Quoted HTML remains text through el(). Names are humanized before either rendering. Removing the old raw tooltip avoids displaying identifiers through a second path.

## 3. Level-of-abstraction fit

The shared notice renderer is the correct presentation layer. It uses the existing plainReferenceText primitive and native details rather than a second API, summary generator or state controller.

## 4. Signal vs authority compliance

No block/allow surface. The length threshold controls only disclosure; every notice and all its existing actions remain. See docs/signal-vs-authority.md.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Text length is an enumerable presentation boundary, never a proxy for importance or action eligibility.

## 5. Interactions

Shadowing: the full text uses the already-humanized message, preserving existing name fixes. Double-fire: no network requests are added by opening a notice. Races: an open disclosure uses the existing data-interaction-open refresh hold, preserving reading position through the30-second refresh; closing it releases the hold. No new persistent state. Feedback loops: none; existing feed refresh and mark-read behavior are unchanged.

## 6. External surfaces

Only the dashboard's existing quiet-notice cards change. No new routes, settings, schema, notices to other users or external operations. Native disclosure works on phone and keyboard. No new agent capability or migration is introduced; ordinary asset updates carry the layout to existing installs.

## 6b. Operator-surface quality

1. Leads with the primary action: category and preview lead each card, followed by the full-text disclosure and the existing Mark read action. Nothing is marked read by previewing or expanding.
2. Zero raw internals as primary content: both bodies use plainReferenceText; original raw hover text is removed.
3. Destructive actions de-emphasized: no destructive action is added. The secondary Mark read action retains its existing role and is never automatic.
4. Plain language and phone width: “Read full notice” describes the action directly. Summary has a44px target and full text wraps. Four actual Chrome cases at390/1280 pixels in light/dark passed: collapsed card stays bounded, summary is44px, no horizontal overflow, keyboard expansion retains the full16k text and holds refresh.

## 7. Multi-machine posture

Pool-merged through the existing /notifications/quiet?scope=pool read. Each notice retains its owning machine for Mark read. The display holds no new durable state, emits no messages and generates no URLs. Existing unavailable-machine notes remain. No status, health, capabilities or channels answer changes.

## 8. Rollback cost

Revert the renderer and CSS in a patch release. Every body returns to its previous expanded presentation. No state repair, migration or owner action is required.

## Conclusion

This bounds the initial reading burden without removing evidence or changing who can act. Complete verification and release remain separate gates. Independent review concurred and focused browser evidence passed. Targeted30 unit checks passed across Notifications, display identity and existing live-check regressions. No full verification or live clearance is claimed.

## Second-pass review

Not required for Tier1. One independent SMALL review concurred after the refresh-hold fix; a DOM regression covers open/closed states and humanized references.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. No self-triggered controller was added or modified.


## Main Merge Conflict Repair — 2026-11-23

Merged current main aa1f50b67876c8f66621c85df1bdbf145c0d66af normally after the coordinator confirmed a supported hold with no active run or reservation. The CSS conflict contained only independent additions after an identical base. Both complete additions are retained: this candidate's styles and main's Needs you grouping styles. Any Git directory-rename suggestion for this candidate's release fragment was corrected by preserving its original bytes under upgrades/next. No action, eligibility, permission or source model was changed by the resolution. Independent review concurred. Focused checks and browser evidence are recorded separately before the new exact-head handoff; earlier full results do not clear this new candidate.

Current repaired-candidate evidence: 179 focused checks and 4 browser width/theme cases passed; independent SMALL review concurred. These are supporting checks; the new exact head still requires normal complete verification.
