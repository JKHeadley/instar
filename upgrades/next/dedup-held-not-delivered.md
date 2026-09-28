# A held Telegram reply no longer counts as "already delivered"

## What Changed

The origin send path reserves a content fingerprint just before it dispatches a
Telegram message, so two identical sends can't race. Only a platform-accepted
send settled that reservation. A held send (`destination-not-authorized`), a
refused one (`telegram-4xx`) or an outcome-unknown one
(`transport-acceptance-unknown`) left it live for the operation's whole deadline
plus 15 minutes. So the agent's resend of the same text came back
`suppressedDuplicate`, and `telegram-reply.sh` printed "NOT SENT — … an identical
message was already delivered". That happened at least four times on 2026-09-27
(Mac Studio, topic 102965), and none of those messages had been delivered.

Now, when an operation ends with no platform acceptance, it releases its own
reservation. The release is owner-fenced (`SqliteOutboundDedupStore.releaseOrigin`)
and wired through `TelegramOriginService.releasePreparedContent` for both the bot
and browser transports. A send the platform accepted, even partly, and even if
its receipt could not be saved, keeps its reservation. So a genuinely delivered
identical message is still suppressed. Nothing is resent automatically. If the
outbox later retries the held operation, the retry looks back to when that
operation was prepared (`record.createdAt`), not just the last 15 minutes. So it
finds the fresh send's delivery however late it runs, and is recorded as
suppressed.

## Evidence

- `tests/unit/telegram-origin/origin-service.test.ts` ("content dedup counts
  only platform-accepted sends as delivered") covers both sides. A confirmed
  send suppresses its repeat. An accepted send whose receipt could not be saved
  suppresses its repeat. A held send lets the fresh send go out, and the held
  retry is then suppressed with no second Telegram call. An outcome-unknown send
  and a 429 both let the fresh send go out. The "goes out" cases fail on the
  previous code.
- `tests/unit/telegram-origin/content-dedup.test.ts` covers the owner-fenced
  release, and shows an accepted fingerprint is never un-suppressed.
- `tests/integration/dedup-held-not-delivered.test.ts` covers the full
  `/telegram/reply` path. A 409 hold, then the identical resend is sent (200).
  Then a real repeat is suppressed. An outcome-unknown 409, then the resend is
  sent.

## What to Tell Your User

If one of my replies gets held up on the way to you, I can now simply send it
again. Before, a retry of the exact same words could be wrongly refused as
"already delivered", even though you never got it.

## Summary of New Capabilities

- No new capability. The duplicate guard now counts only confirmed deliveries.
