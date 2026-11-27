# Side-Effects Review — Session Link Rendered Regression

Tier1: test-only correction preserving runtime behavior.

## Summary of the change

console-conversation-session.test.ts replaces an exact whole-rule CSS assertion with computed-style checks using the real full stylesheet in JSDOM. No runtime CSS or renderer changes. The exact retainedaff14 failure and focused reproduction agree at line78.

## Decision-point inventory

Only the regression oracle changes: it verifies centering, alignment, no underline, spacing, sizing and wrapping prerequisites. It does not alter access, session selection, rendering or action decisions.

## 1. Over-block

The old test rejected current main's valid richer inline-flex rule. The new test accepts the real rule only when the required computed properties hold; formatting and unrelated extra declarations no longer cause rejection.

## 2. Under-block

Centering, text alignment, decoration, box sizing, full-width min-height/auto-height/padding and inline auto width are explicitly asserted. Browser geometry separately checks actual label containment and wrapped growth. No failed assertion is skipped or weakened to an arbitrary regex.

## 3. Level-of-abstraction fit

The regression belongs at rendered behavior, not at the byte spelling of a declaration. Full stylesheet loading exercises the real cascade; actual browser layout covers the geometry JSDOM cannot supply.

## 4. Signal vs authority compliance

No new block/allow surface. Existing test-gate authority continues to reject incorrect layout. See docs/signal-vs-authority.md.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Required visual properties are enumerable regression invariants.

## 5. Interactions

Shadowing: the real full cascade is tested rather than copied CSS. Double-fire: no runtime action is added. Races: the local DOM instance closes in finally and does not mutate test globals. Feedback loops: none. The coordinator's failure hold remains until a new exact head is handed over.

## 6. External surfaces

No new external or operator surface. The original PR's existing links remain unchanged. No API, schema, configuration, awareness or migration changes. No external messages or persistent effects from this test.

## 6b. Operator-surface quality

No operator surface is changed. Existing session-link layout is preserved and checked in actual phone/laptop Chrome geometry; the correction must not roll back current main's centering or padding.

## 7. Multi-machine posture

Test-only, machine-local by design: a DOM verifies platform-independent CSS behavior. Existing pooled session links and machine names remain unchanged. No notices, durable state or generated URLs. No status, health, capabilities or channels response changes.

## 8. Rollback cost

Revert the test correction if necessary; runtime behavior remains identical. That restores the known stale assertion failure, so any alternate correction still needs to verify actual behavior. No migration or state repair.

## Conclusion

Independent SMALL review concurred that behavior coverage is stronger. Focused tests and browser geometry evidence are recorded before push. No full-pass, merge or live claim is made for the corrected candidate until normal gates complete.

## Second-pass review

Not required for Tier1; one independent SMALL reviewer concurred. The reviewer explicitly required real browser geometry in addition to JSDOM, which is included in development validation.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. No self-triggered controller was added or modified.
