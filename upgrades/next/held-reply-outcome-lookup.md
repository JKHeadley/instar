# A held reply no longer gets resent as a duplicate

## What Changed

- When Telegram accepts a reply but the origin store cannot save the receipt, the server no longer says "outcome unknown". It answers the new outcome `accepted-unrecorded` with Telegram's message id (`delivered: true`), keeps the receipt in a small fallback file (`state/telegram-origin-unrecorded-receipts.jsonl`), and the recovery tick folds it back into the store through the existing `reconcileReceipt` once the abandoned claim is reaped.
- New read: `GET /telegram/origins/operations/:operationId/outcome` (ordinary API auth; no operator session) answers `delivered`, `partially-delivered`, `pending`, `not-delivered` or `unknown`, with `safeToResend`, the Telegram message ids and a plain detail line. Never message content. A dispatched request with no recorded answer stays `unknown`, never `not-delivered`.
- Every held 409 now carries `checkOutcome` (the lookup path).
- `telegram-reply.sh` handles `409 telegram-origin-held`: it asks the lookup once and prints DELIVERED / HELD / MAY ALREADY BE DELIVERED / NOT SENT. Only NOT SENT says a resend is safe. It used to print "Failed (HTTP 409)" and exit 1, so sessions resent.
- An `accepted-unrecorded` reply is written to message history (`telegram-messages.jsonl`) and recorded for content and delivery-id duplicate protection, so a resend of the same text is suppressed.
- On a forwarded (cross-machine) send, the holder answers an `accepted-unrecorded` result as sent, and its receipt check reads the fallback record, so the forwarding machine never re-forwards a delivered message.
- The pre-change relay script SHA is registered so deployed agents receive the new script; a CLAUDE.md section ("Held reply outcome:") is added for new and existing agents.

## What to Tell Your User

If I ever say a message "may already be delivered", I now check whether it actually arrived before doing anything, instead of sending it again. You should stop seeing the same message from me twice after a hiccup in my message records.

## Summary of New Capabilities

- Agents can ask whether a held reply reached the chat, by operation id, and get delivered / pending / not delivered / unknown.

## Evidence

Reproduced from the 2026-10-27 08:23/08:25 duplicate (operation f659abab-…): with the store's receipt write failing after Telegram accepted, main answers `outcome-unknown` and the script prints "Failed (HTTP 409)". With the change: new unit tests (held-reply-outcome 10/10, relay-script held branch 5/5), the updated origin-service tests, and an integration test over the full reply HTTP pipeline with the real adapter (409 accepted-unrecorded with message id → lookup says delivered with only Bearer auth → message in history → identical resend suppressed, one network call).
