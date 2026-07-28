# Side-effects review — Topic Operator inbound auto-bind (Know Your Principal #898, increment 2d)

## What this change does
The WRITE side of the operator binding. On the lifeline-forward inbound path
(`POST /internal/telegram-forward`), the verified operator of a topic is now
recorded automatically from the AUTHENTICATED + AUTHORIZED sender of a real user
message — so the session-start hook (#908) and the future cross-principal guard
have a populated binding instead of relying on a manual `POST /topic-operator`.

- `TelegramAdapter`: new public `isAuthorizedSender(number|string): boolean`,
  wrapping the private `isAuthorized` (number/string tolerant; blank/non-numeric
  → false). Read-only; no behavior change to the private path.
- `routes.ts` `/internal/telegram-forward`: one additive block, placed AFTER the
  a2a-hook short-circuit and BEFORE `onTopicMessage`, that binds the operator iff
  `ctx.telegram.isAuthorizedSender(fromUserId)` is true.

## The load-bearing security property
ONLY an authorized sender becomes the operator. An unauthorized party in the
bot's group is never seated — that is exactly the cross-principal ("Caroline")
bug, and the integration test proves the over-the-wire refusal (a `fromUserId`
outside the allowlist, even with `fromFirstName: "Caroline"`, binds nothing).
The uid is the platform-authenticated sender id; a content name is never the
source (`TopicOperatorStore.setOperator` enforces this by construction, #904).

## Blast radius (hot path — reviewed carefully)
- **Additive + fail-soft.** The block is wrapped in try/catch and only runs when
  `ctx.topicOperatorStore` is non-null, `fromUserId` is present, and `topicId` is
  a number. Any error is logged and swallowed — an auto-bind failure can NEVER
  break message routing. `setOperator` is a fast local JSON write, idempotent on
  the same uid (a redelivered message re-binds the same operator harmlessly).
- **a2a-safe.** Placed after the a2a short-circuit, so agent-to-agent bot messages
  return before the bind; a bot id is also not in `authorizedUserIds` anyway. The
  14 existing `/internal/telegram-forward` integration tests stay green (no
  regression to the version handshake, exactly-once, sentinel, or a2a paths).
- **No new route / class / config key / dependency.** It consumes the store +
  routes shipped in #904/#906 and the injection from #908.

## No-allowlist trust model (documented)
`isAuthorizedSender` mirrors `isAuthorized`: with NO `authorizedUserIds` allowlist
configured, every authenticated sender is accepted (the agent already serves
everyone in that mode), so the operator becomes the most-recent authenticated
sender. This is consistent with the existing trust model and is NOT a
Caroline-class bleed (the uid is Telegram-authenticated, not a content name). A
secure deployment configures `authorizedUserIds`, and then only those uids bind.

## Scope (deliberate) + the known gap
This binds on the **lifeline-forward path only** — the instar fleet's primary
inbound route. The adapter's own long-poll path (`onTopicMessage`, the
no-lifeline case) is NOT covered here, because its single shared callback is
defined in `src/commands/server.ts` (the production composition root, not
route-testable). That gap is tracked for a follow-up (Inc-2e): bind in the shared
`onTopicMessage` handler to cover both paths with one change. Until then, a
no-lifeline install simply has no auto-bind (fail-safe: no binding → no injection
→ no false identity), and `POST /topic-operator` remains the manual path.

## Migration parity
None required — server-side route behavior + an in-process adapter method reach
existing agents on the next server update (the Migration Parity Standard governs
agent-installed FILES; this touches none).

## Tests
- Tier 1 (unit): `tests/unit/telegram-isauthorizedsender.test.ts` (5) — both sides
  of the boundary, number/string ids, blank/NaN guard, no-allowlist model.
- Tier 2 (integration): `tests/integration/topic-operator-autobind-route.test.ts`
  (4) — over the wire: authorized binds, unauthorized doesn't, a2a bot doesn't,
  null store no-op. Existing telegram-forward suites (14) stay green.

## Rollback
Revert the one route block + the `isAuthorizedSender` method + delete the two
tests. The store on disk is inert without the bind.
