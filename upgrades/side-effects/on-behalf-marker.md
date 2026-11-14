# Side-Effects Review — on-behalf marker for sends through the operator's account

**Version / slug:** `on-behalf-marker`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow decision; labelling only)`

## Summary of the change

Tier 1, 4 source files plus 1 test file, about 150 lines. No spec rounds. Fixes the marking half of Echo Bugs topic 10000002506 (operator request, topic 134088, 2026-11-09 17:25: "any messages you send as me should be marked appropriately ... generalize it").

- `src/messaging/shared/onBehalfMarker.ts` (new): format, parse (start or end of the message only), and the inbound label helpers.
- `src/commands/server.ts`: the Slack inbound dispatch applies `markedInboundPrefix` to the live injection tag and `markedHistoryLabel` to each thread-history line.
- `src/core/PostUpdateMigrator.ts` + `src/scaffold/templates.ts`: a new CLAUDE.md section "Before I ask my operator to check or send something", shared by `generateClaudeMd` and a heading-sniffed `migrateClaudeMd` step.

## Decision-point inventory

No decision point is added. This change only labels: it never blocks, drops or routes a message differently. Slack operator binding and authorization are untouched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest risk is mislabelling: a person who really did type the marker at the start of their own message gets labelled "not written by" them. That only happens if they choose to write the marker.

## 2. Under-block

No block/allow surface. What it still misses:
- An agent that sends as the operator WITHOUT the marker is not recognised. The sends happen in a browser, outside the server, so nothing here can intercept them. The instructions section and the session-start line (companion PR) carry the rule. Telegram's signature path covers Telegram.
- Other platforms' inbound paths (iMessage, WhatsApp) don't parse the marker yet; the format and parser are shared, ready for them. Slack is the platform reached through the operator's browser today.

## 3. Level-of-abstraction fit

Right layer. One pure shared module (format and parse) is applied at the single Slack dispatch function that both the live and mesh-forwarded paths run (`slackInboundDispatch`), so the two cannot drift.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The label is information for the session. It grants and withholds nothing.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** the app-origin mark (📱/💻) is applied first; the on-behalf note is appended inside the same tag after it. Both can coexist.
- **Double-fire:** none.
- **Races:** pure functions over already-received text.
- **Feedback loops:** none.

## 6. External surfaces

- Sessions on every agent see a longer Slack tag on marked messages only.
- Every agent's CLAUDE.md gains one section, on new installs and on update.
- No new routes, no persistent state, no change to what is sent to Slack.
- Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN, and stateless. The label is computed from message text inside `slackInboundDispatch`, which runs on whichever machine owns the conversation (live or mesh-forwarded), so every machine labels the same way. No notices, no durable state, no URLs.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Pure code change: revert and ship a patch. The added CLAUDE.md section stays in already-migrated agents' files after a revert. It is harmless text, but correcting it would need a removal migration.

---

## Conclusion

A small, labelling-only change. It generalizes the Telegram "this was the agent, not the person" outcome to Slack, using a visible marker that is safe without a signature because it can only lower trust. Clear to ship.

---

## Second-pass review (if required)

Not required: no block/allow, session-lifecycle, gate or sentinel surface.

---

## Evidence pointers

- Founding message: "[Sent by Echo on Justin's behalf, test]" in `#echo-agent-sess-test-slack`, 2026-11-09.
- `tests/unit/on-behalf-marker.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This adds a capability: inbound labelling plus awareness text.
