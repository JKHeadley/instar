# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The "include a link the operator can open" rule for spec reviews moved from the pre-send hook to the server, where messages actually reach a person.

- **The hook no longer blocks spec handoffs.** The pre-send message check (`convergence-check.sh`) loses its `SPEC_REVIEW_LINK` rule on every agent. It could not tell who a message was for, so it blocked review verdicts that agent sessions send each other over the local bus.
- **A new outbound rule, B27, on development agents.** The server's outbound check gains `B27_SPEC_REVIEW_UNLINKED`, judged by meaning. It applies only on the routes that carry a session's own reply to a person (Telegram, Slack, the app, WhatsApp, iMessage, owner email), behind `toneGate.specReviewLinks.enabled`, which is live on development agents and dark on the fleet. It is a nudge from day one. An override with a reason is checked once more against every other rule before it sends, so it can never skip a rule such as B25.
- **Owner email is checked like a chat reply,** behind `toneGate.ownerEmailCheck.enabled` (development agents first). `POST /email/send-to-owner` accepts an optional `metadata` object holding only the four tone reactions. It never compares an email against the topic's chat for duplicates, and it carries the outbound messaging timeout.

## What to Tell Your User

Nothing changes for you. Your agent's own sessions stop blocking themselves when they pass a design review to one another. When your agent hands you a design to review, it still brings a link you can open on your phone.

## Summary of New Capabilities

- Outbound rule `B27_SPEC_REVIEW_UNLINKED` (development agents): a spec handed to the person for review carries a link that opens it readably.
- Owner email (`POST /email/send-to-owner`) runs the outbound check, with the same override path as chat (development agents).

## Evidence

- Unit: the detector, the gate's B27 registration, rendering, prompt id, per-call accepted citations and capture ceiling, the hook's retired rule, and the rule-registry ratchets (`tests/unit/spec-review-handoff.test.ts`, `tests/unit/messaging-tone-gate-b27.test.ts`, `tests/unit/convergence-check.test.ts`, `tests/unit/messaging-tone-gate-b21.test.ts`).
- Integration: the route, switch and override chain through `POST /telegram/reply` (`tests/integration/telegram-reply-b27-spec-review.test.ts`), and owner email through `createRoutes` (`tests/integration/email-send-to-owner-tone.test.ts`).
