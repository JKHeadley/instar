# Side-Effects Review — A sign-in that needs you says why on a phone

**Version / slug:** `signin-reason-wraps`
**Tier:** 1 (one style rule; a revert fully undoes it)
**Second-pass reviewer:** not required (no gate, sentinel, session lifecycle or messaging decision)

## Summary of the change

Live verification of #2876 found the "Needs you" row's explanation cut off at phone width ("This slot holds echo@sagemind..."). `dashboard/console/console.css` adds `.need-card .row-sub { white-space: normal; }`, with a unit test holding the rule.

## Decision-point inventory

None. This changes how text is laid out, not what is decided or shown.

## 1. Over-block

No issue identified. Nothing is blocked.

## 2. Under-block

Home's short list still cuts its rows to one line. That is deliberate: Home is a summary and each row opens the full page, where the reason now reads in full.

## 3. Level-of-abstraction fit

Right layer. The rule belongs on the card, so every operator-facing need card behaves the same, rather than a special case on the Accounts page.

## 4. Signal vs authority compliance

Not applicable. No detector or authority. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The rule applies to any `.row-sub` inside a `.need-card`. Those rows can now be taller when their text is long; the row layout already handles a tall middle column (seen live with the button still aligned). `.feat-main` and `.setup-main` already use the same override.

## 6. External surfaces

Dashboard look only. No route, data or wording change.

## 6b. Operator-surface quality

Improves it: the reason a sign-in needs the operator is readable at phone width. Checked on the live page at 390x844 with the new stylesheet: full sentence on three lines, no sideways scroll. Sign in opens its sheet at both sizes.

## 7. Multi-machine posture

Machine-local by design: a static stylesheet served by each machine's install. Machines pick it up with their next update.

## 8. Rollback cost

Revert the one line. No stored state.
