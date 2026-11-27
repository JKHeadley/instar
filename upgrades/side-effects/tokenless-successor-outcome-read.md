# Side-Effects Review — outcome read follows token-less successor ids

**Version / slug:** `tokenless-successor-outcome-read`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Token-less re-seal successors get the id `<root>~r<hop>-<plan8>` (OriginForwardToHolder `supersedingOperationId`). Three operation-id validators did not admit `~`:
- `OriginOperationOutcome.successorOf`
- `OriginOwnerRead.parseReceiptAnswer` (the `supersededBy` field)
- `OriginPolicyVerdict.isOperationReference`

As a result the outcome read stopped at the superseded original and answered `unknown` for a delivered reply (fb-b7abf24e-6cb). The fix adds one exported `OPERATION_ID_PATTERN` (`^[A-Za-z0-9~-]{1,256}$`) used by the first two; the `op:` reference check and the `/telegram/origins/operations/:id/text` route regex (`{8,96}`, as the outcome route already is) admit `~` too.

Files:
- `src/messaging/telegram-origin/OriginOperationOutcome.ts`
- `src/messaging/telegram-origin/OriginOwnerRead.ts`
- `src/messaging/telegram-origin/OriginPolicyVerdict.ts`
- `src/server/telegramOriginRoutes.ts`
- tests

## Decision-point inventory

- Outcome read (`readOperationOutcome` / `resolveOutcome`) — pass-through. The resolution table is unchanged; it now receives the successor link it was designed to follow.
- `isOperationReference` — modify (input recognition only). A successor's own `op:` reference is recognised as self-resolved and dropped before sealing, as for any other operation.

---

## 1. Over-block

No block/allow surface. The change only widens what counts as a valid operation id, so nothing that was accepted before is refused now.

## 2. Under-block

Ids with other characters are still refused. They are not produced anywhere: operation ids are UUIDs or derived `~r` successors. A link that points to itself is still refused (unit-tested).

## 3. Level-of-abstraction fit

Right layer. The id grammar is defined once next to the classifier and reused, instead of three hand-copied regexes that drifted when the successor format was added in #3095.

## 4. Signal vs authority compliance

Not a gate. The outcome read is a signal for sessions; `safeToResend` is still produced only by the unchanged resolution table. See `docs/signal-vs-authority.md`.

## 5. Interactions

- The follow loop already guards against cycles with a visited set and `MAX_FOLLOW`, so following `~` successors cannot loop.
- `TokenlessHeldDebt` and `followSupersedeChain` already parse `~`; this aligns the readers with them.
- The advisory reference change interacts with the tone-gate decision-ref path in `routes.ts`. Before the fix, an `op:<successor>` ref was passed through as if it were a tone-gate decision ref. Now it is dropped as self-resolved, which is what an `op:` ref is meant to do.

## 6. External surfaces

- The outcome route's JSON can now carry `supersededBy`/`answeredFor` values that contain `~`. The route already admitted such ids as input.
- The `/text` route now accepts successor ids. That widens a regex only; the auth checks are unchanged (API token, author machine, conversation check).

## 7. Multi-machine posture

This is a cross-machine fix. On the authoring standby the local row's successor link is now followed. On a third machine, the author's mesh answer (`supersededBy`) is now kept, so the read also follows it remotely. There is no new state.

## 8. Rollback cost

A revert restores the old regexes. No data or migration is involved; reads become `unknown` again for successor chains.
