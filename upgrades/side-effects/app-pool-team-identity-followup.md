# Side-effects review: team rules on the owner machine (follow-up to #2905)

Tier 1. A follow-up to the independent read-only review of 4887a7e43 against #2916, which found no blocking findings. Everything here is unreachable today: team phones are refused on an agent with a second machine (`AgentServer.ts`, `teamGate`), and a machine can't be added after team members (`machineRoutes.ts`). Spec: `docs/specs/app-conversations-in-the-pool.md`; ELI16: `docs/specs/app-pool-team-identity-followup.eli16.md`.

## What changed

1. **The owner fails closed on forwarded identity.** `parseAppForward` reads a forward whose signed event names a team sender as `stopScope: 'conversation'`, whatever the forward says. Every receiving path parses through it: the receiver, the exact-stop and classifier paths, and the drain. A team send with no `memoryPersonId` is refused. A team event whose signature verdict is `failed` is refused, stops included. `forwardSpeakerName` lets only the owner's own message fall back to the owner's name; another person's reads as their stored name, or "Another person".
2. **No envelope, no app forward.** `DeliverMessageHandler` answers `sender-rejected` to an app command with no sender envelope, with the usual trace. Telegram and Slack commands keep today's rule.
3. **The drain is a tested function.** The inbound queue's app tail moved from `server.ts` into `createAppDrainDeliver` in `appConversationPool.ts`, unchanged except for items 1's checks. The server wires it in one line, and a wiring test pins that.
4. **The placement read is flagged `conversationRef: true`.** Its handler already called the shared check; the allowlist coverage test now counts it.

## 1. Over-block

A team send with no person is refused. That can only come from a damaged or older forward: the route always sets the person for a non-owner sender. A team event whose signature fails is refused; `unknown` (a key not yet here) is not refused, so a new phone's first message still runs. An app command with no envelope is rejected: the router and the mesh send always carry one (`server.ts` mesh `deliverMessage`), and queued rows store it at the send. The owner's own messages are unaffected, as the tests show.

## 2. Under-block

A forward that changes the event's `senderRole` from `team` to `owner` would defeat the forced scope. The event is signed by the phone, so on a machine that can check the signature that shows as `failed`. One that can't check it yet sees `unknown`, and peers are already trusted to deliver stops. The owner's failed verdict keeps today's policy (delivered and flagged), which this change does not alter.

## 3. Level-of-abstraction fit

The forced scope sits in the parser, the one function every receiving path already uses, so no path can miss it. The refusals sit in the delivery helpers the owner and the drain share.

## 4. Signal vs authority compliance

These are refusals on a narrow, deterministic condition read from the signed event (role, person present, signature verdict). They narrow what the owner does with a message that is already outside its normal shape. Per `docs/signal-vs-authority.md`, this is a structural invariant check, not a judgement call, so it may block.

## 5. Interactions

The holder still records "intercepted" when a stop is acknowledged. If the owner then refuses a forged team stop, the owner appends "refused" too; the two delivery rows merge as they do for any later outcome. The drain keeps its "already handled" dedupe and the receipt handover unchanged; the integration tests cover both.

## 6. External surfaces

No new route or wire field. The forward's existing `stopScope` is now also inferred from the event. A rejected forward shows as `refused` on the phone, as any refused message does.

## 7. Multi-machine posture

This is all multi-machine: it is the owner's side of a forward. Both sides run the same build behind the whole-pool flag, so an older peer never reaches this code. Machine-local state: none added.

## 8. Rollback cost

Revert. No data, migration or state to repair. The feature is off for the fleet and on for development agents only.

## Tests

New: six cases in `tests/integration/team-access-guards.test.ts` (rows with no scope, no person, failed signatures, the speaker's name, the drain's outcomes), and `tests/unit/app-pool-team-identity.test.ts` (the envelope rule, the drain wiring, the placement flag). Each was made to fail by breaking the change it guards: dropping the forced scope, the person check, the signature check, the name rule, the envelope rule, or putting an unscoped stop back in the drain.
