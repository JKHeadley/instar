# Side-Effects Review — Dashboard conversations: phone layout and title from a link

**Version / slug:** `dashboard-chats-phone-layout`
**Date:** `2026-11-08`
**Author:** `echo (M5 Pro builder, topic 134088)`
**Second-pass reviewer:** `not required`

## Summary of the change

Two client fixes to the Conversations page shipped in #2966, found by the recorded live proof (real dashboard, Playwright, 390×844). The first is in `dashboard/console/console.css`: below 900 px the open conversation gets a definite height, so the messages scroll inside it and the composer stays above the bottom tab bar. With `flex: 1` alone the list sized to its content, so in a 10-message conversation the list was 1,157 px tall and the composer sat at y=1,299 on an 844 px screen. The second is in `dashboard/console/chats.js`: a conversation opened from a link before the list loaded kept the "Conversation" placeholder title; the header is now filled in when the list paints. Test: `tests/unit/console-chats-page.test.ts`, the title case, which fails without the fix.

## Decision-point inventory

No decision-point surface. Layout and display only.

---

## 1. Over-block

No block/allow surface. Over-block does not apply.

## 2. Under-block

No block/allow surface. Under-block does not apply.

## 3. Level-of-abstraction fit

The phone rule mirrors the desktop rule already in the same file, scoped to `.chats-page`.

## 4. Signal vs authority compliance

- [x] No: this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The CSS is scoped to `.chats-page` and changes no other console page. The title fill runs only when the open view still carries the placeholder, and it clears itself after one use.

## 6. External surfaces

None beyond the page itself.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. The composer is now always on the first screen at phone width.
2. **Zero raw internals?** The header now shows the real title instead of a placeholder.
3. **Destructive actions de-emphasized?** Unchanged.
4. **Plain language + phone width?** Verified at 390×844 with a 10-message conversation: messages box 549 px, composer at y=692 above the tab bar at y=780. Re-verified in the recorded live proof.

## 7. Multi-machine posture

Client-only. No state.

## 8. Rollback cost

Revert the commit.

## Conclusion

Ready to ship. Both defects were found by the live proof the brief requires, before the operator was asked to use the page.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: not applicable.
