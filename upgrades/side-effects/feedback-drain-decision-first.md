# Side-Effects Review — Feedback Drain tab leads with the decision (ACT-003)

## Summary of the change

The Feedback Drain dashboard tab now opens on a decision headline (new module
`dashboard/feedback-drain-headline.js`): one sentence saying whether anything needs the operator,
one supporting line, and at most one button that reveals the matching existing approval card.
The approval cards move into a closed "Approvals and settings" drawer; the drain counters
(posture, backlog, progress, source integrity) move into a closed "More detail" drawer. The
headline reads the same five GET routes the existing cards read and refreshes on the existing
15-second poll (it has no PIN field, so a refresh cannot wipe input).

## Decision-point inventory

None added or changed. The headline's "what needs you" list is a display ordering over data the
server already computed (`approveAction`, `execute.reason`, held attempts, open fix PRs). It
gates nothing.

## 1. Over-block

No issue identified — nothing is blocked. Worst case for a wrong headline: the operator sees
"Nothing here needs you" while a card in the drawer is approvable. Covered by the inverse rule:
the headline says "needs you" whenever any card's own `approveAction` is set, which is the same
field the card uses to show its Approve button.

## 2. Under-block

Not a gate. Known display gap: if one of the five GET calls fails, its item is treated as absent
(for example, a failed readiness read shows the "drain not running here" calm line). The cards
in the drawer still show their own load failure text.

## 3. Level-of-abstraction fit

Right layer: pure presentation in the dashboard, mirroring Process Health's headline + "More
detail" drawer. No server change was needed; every fact shown is already computed server-side.

## 4. Signal vs authority compliance

Compliant. The headline holds no authority. It cannot approve, revoke or commit anything. The
only action it can trigger beyond scrolling is clicking the existing
`plan-accept-approver-dependence` / `plan-publish-secret-shape` preview button, which renders the
server's plan text; committing still requires the operator's PIN in the existing card.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The priority order of headline
items is a fixed display order, not a decision about agent behaviour.

## 5. Interactions

The cards still render on tab open and after actions, never on the poll (existing test kept).
After a successful card action the headline is refreshed too. The reveal step opens the
`<details>` drawer first, so the card is visible before scroll/focus. Element ids `fdPosture`,
`fdBacklog`, `fdProgress`, `fdSource`, `fdAuthority`, `fdTriage`, `fdStamp` are unchanged, so
`loadFeedbackDrain` and the card loaders are untouched.

## 6. External surfaces

Visible only to the dashboard operator. Five extra GET requests every 15 s while the tab is open
(the same routes the cards already call once). No other agent, user or system sees a change.
The tab button label and the agent-awareness text ("Feedback Drain tab", "Who decides which
feedback becomes work" card, "Triage section") all stay accurate.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes — that is the change. The first thing under the title
   is the decision box with the one button; the counters are collapsed below it.
2. **Zero raw internals as primary content?** Yes. The "state: reason" posture code and the
   lag/checksum counters moved into the closed "More detail" drawer; the headline is plain words.
3. **Destructive actions de-emphasized?** Unchanged cards: Revoke stays the quieter button after
   Approve, now also inside a closed drawer. The headline never offers a destructive action.
4. **Plain language + phone width?** Verified at 390×844 in headless Chromium: the box wraps
   cleanly, the button is a full-width 44px tap target, no horizontal scroll.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, the same as the cards it summarizes: it reads this machine's drain and
triage routes. On a machine that does not run the operated drain the routes are unavailable and
the headline says the drain is not running on this machine, which is true.

## 8. Rollback cost

Revert the commit. No state, config, migration or route involved.

## Conclusion

Presentation-only, no authority. Safe to ship.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging decision is touched.

## Evidence pointers

- `tests/unit/feedback-drain-headline-ui.test.ts` (12 tests): calm vs action, every pending item
  type, priority + "after that" count, non-GitHub links refused, HTML never parsed, page order and
  closed drawers, headline on open and on the poll.
- Existing `tests/unit/feedback-readiness-authority-ui.test.ts` and
  `tests/unit/feedback-triage-ui.test.ts` still pass, plus all 42 dashboard unit test files.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
