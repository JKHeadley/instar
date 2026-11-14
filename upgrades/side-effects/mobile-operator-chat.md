# Side-Effects Review — Mobile operator chat

**Version / slug:** `mobile-operator-chat`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

An active paired phone can send a message into a topic from the Instar iPhone app (spec: `docs/specs/mobile-operator-chat.md`). `POST /mobile/chat/:topicId` (device-signed only) is added in `src/server/mobilePairingRoutes.ts`, with an idempotency record in the new `src/core/MobileChatRequests.ts`. The `/internal/telegram-forward` handler in `src/server/routes.ts` becomes a named function (`telegramForwardHandler`) that both the lifeline route and the chat route call; the app call passes a `trust` value and the steps that differ branch on it. `TelegramAdapter`/`MessageLogger` gain `via`/`deviceId`/`eventId` history fields and a `sendToTopic` `operatorMirror` option. `server.ts`'s `onTopicMessage` skips the operator auto-bind for app messages, and the routed/queued sender envelope carries the app mark. `GET /telegram/topics/:topicId/messages` gains `?scope=pool`. Dev-gated (`mobilePairing.chat.enabled`, following `mobilePairing`). Tier 2.

**Implementation choice versus the spec's wording.** Spec §2.2 describes moving the shared steps into `ingestTopicInbound(input, trust)` returning typed outcomes. The change keeps the existing handler body in place and calls it with a captured response instead, mapping the captured body to the typed outcomes in the chat route (`delivered`, `sentinel-kill`, `sentinel-pause`, `deduped`, `a2a-handled`). This keeps the lifeline path byte-identical (no code moved; every lifeline line runs as before when `trust` is undefined) at the cost of the outcome mapping reading the lifeline's JSON bodies. Two other deliberate choices: an app history row is recorded with `forwarded` unknown (not `false`), so no durable-evidence reader that requires `forwarded === false` (standing authorization, approval evidence) ever counts it; and only the core's early refusals (400 missing fields, 422, the boot-window 503) release the request id; every other failure answer is outcome-unknown.

## Decision-point inventory

- Chat accepted (device principal, gate, owner, lease, rate, topic, request-id age) — add, invariant.
- Repeat answered from the record / reused id refused — add, invariant.
- Invite, `/desktop` and credential-shaped text refused from the app — add, invariant (exact prefixes + the existing lexical credential wall).
- Inbound core — modify: per-trust branches (skip lifeline guard, leak scan, auto-bind, serve-progress stamp; label metadata; await delivery). Lifeline path unchanged.

## 1. Over-block

A real message is refused when: it looks like a credential (examples included, by design; Secret Drop is the channel); it starts with a pairing invite or `/desktop`; this machine is not the lease holder (409 with a plain sentence); more than 20 per minute from one phone; its request id is older than 24 h (the app makes a fresh one per tap). A topic-profile confirmation typed in the app works only where an operator is already bound (stated in the spec and CLAUDE.md).

## 2. Under-block

A process running as the agent's OS user can still forge inbound messages through the lifeline route if it can read the lifeline secret: unchanged and out of scope. A stolen-and-unlocked phone can speak as the owner until revoked (revoke is per device). Cross-machine: the forwarded envelope carries the app mark, but the receiving machine's direct inject shows the owner's name without "(from the app)".

## 3. Level-of-abstraction fit

The app message enters the same handler the lifeline uses, so every intercept (emergency stop, pause, exactly-once ledger, observers, a2a hook) runs without a second copy to drift. The chat-specific concerns (idempotency, preflight, mirror) stay in the mobile router.

## 4. Signal vs authority compliance

No detector gains authority. The only new authority is that an active device speaks with the owner's voice, established by the existing owner-confirmed device key and enforced by the signature check.

## 4b. Judgment-point check

No competing-signals decision point; nothing judgment-based is added.

## 5. Interactions

Lifeline route: unchanged behavior; three source-order wiring tests now anchor on `telegramForwardHandler` (the route's body moved into that named function). `onTopicMessage` is awaited only for app messages; a rejection there is rethrown only for app messages (lifeline keeps its 500). The mirror uses `sendToTopic` with `operatorMirror` (no outbound history row, no stall or promise tracking). The pairing-code leak scan runs in the chat preflight. `telegramMessageId` is empty for app messages, so no operator-establishment evidence is minted from a server-minted id.

## 6. External surfaces

New device-signed route (published interface with the TestFlight app). A mirror line in the Telegram topic ("📱 Justin (from the app): …"). `?scope=pool` on the history route fans out to peers with the existing credential URL guard.

## 6b. Operator-surface quality

Phone-first: type and send in the app; the reply appears there. Every refusal is a plain sentence with the next step (use Telegram, use Secret Drop, check the conversation).

## 7. Multi-machine posture

machine-local-justification: physical-credential-locality — requests are signed for one machine's hostname and accepted only on the lease holder; the idempotency record lives with them. Delivery to a session on another machine uses the existing pool routing with the app mark in the envelope; history is read across machines with `?scope=pool`.

## 8. Rollback cost

`mobilePairing.chat.enabled: false` turns off only the chat route. The handler refactor is behavior-identical for the lifeline path. Request records are inert JSON with no message text.

## Conclusion

The app gets a send path that is exactly the owner's Telegram path, without creating operator bindings or durable authorization evidence, with retries that never deliver twice.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the code: concur, with notes, all applied.** Only a signed active device reaches delivery; the lifeline path is unchanged when `trust` is undefined; the record check and reservation run with no `await` between them; no binding, serve-progress stamp, standing-authorization evidence or establishment evidence is created. Notes applied: (1) the "every ≥400 core answer is pre-effect" claim was wrong for the late 503 "no message routing available" (after the history row and ledger claim): only 400, 422 and the boot-window 503 now release the id, and every other failure answer, including a 200 with `ok:false` (`injection-failed`), is recorded as outcome-unknown (new integration test); (2) the pool history read now caps a peer answer at 512 KB, and this machine's own rows win a de-duplication key collision with a peer row; (3) a duplicated allowlist line was removed.

## Evidence pointers

- Spec and convergence report: `docs/specs/mobile-operator-chat.md`, `docs/specs/reports/mobile-operator-chat-convergence.md`.
- Tests: `tests/unit/mobile-chat-requests.test.ts` (8), `tests/integration/mobile-operator-chat.test.ts` (13), `tests/e2e/mobile-pairing-alive.test.ts` (chat route alive on production boot); existing lifeline tests green.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** No self-triggered loop. Each chat request causes at most one delivery and one mirror send, triggered by an operator tap, bounded by 20 per minute per phone and 2,000 live records per phone; nothing retries on its own.
