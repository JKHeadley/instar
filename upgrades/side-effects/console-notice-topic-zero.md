# Side-Effects Review — notifications: no "topic 0"

**Version / slug:** `console-notice-topic-zero`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. `dashboard/console/display-identity.js` `plainReferenceText` gains one replacement: `topic <one or two digits> (name unresolved|name unavailable)` becomes "a conversation". Found by the pre-release page audit (topic 127504). One unit test added. Also `needs-strip.js`: the open list's heading is "Needs you" and the badge alone carries the count, so it no longer reads "16" beside "16+" (Chief of Staff request after the live check on 1.3.1947).

## Decision-point inventory

No decision-point surface. Display text only.

## 1. Over-block

No block/allow surface — not applicable. Prose such as "topic 2 of the guide" is unchanged because the marker is required (tested).

## 2. Under-block

No block/allow surface — not applicable.

## 3. Level-of-abstraction fit

Right layer: the shared helper that already owns plain wording for notices, promises and Home.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added or changed.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point.

## 5. Interactions

Covers only the one- and two-digit numbers that the existing three-digit topic rule skips, so longer ids still resolve to their names through that rule (pinned by the existing held-reply test).

## 6. External surfaces

Wording on console pages that use the helper. No route, config or outbound message.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Unchanged.
2. **Zero raw internals as primary content?** This removes one.
3. **Destructive actions de-emphasized?** None touched.
4. **Plain language + phone width?** Yes, shorter text.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-independent display logic. No state.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit.

## Conclusion

A safe one-line wording fix.

## Second-pass review (if required)

Not required: no gate, block, session lifecycle or watchdog.

## Evidence pointers

- `tests/unit/console-live-check-fixes.test.ts`: short topic number removed, ordinary prose untouched.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
