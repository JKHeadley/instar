# A reply held because the lead's own lease renewal lapsed is retried within seconds, named and counted

<!-- bump: patch -->

## What Changed

On the machine that holds the multi-machine lead, a Telegram send is refused at the network boundary when the machine does not hold the lease at that moment. Until now every such refusal was filed as `credential-capacity-unavailable` (the name for the ten-sends-per-second cap), nothing was logged, the reply waited 30 seconds and then a growing ladder before the recovery pass tried again, and the conversation received a "reply needs delivery attention" notice that was itself held by the same refusal and landed stale (post-mortem N71, topic 145840, fb-20393429-c92: eight such refusals on 2026-11-21 at one send per second). Now the lease coordinator reports which of its checks answered, and the refusal is recorded as `lease-freshness-lapsed` when its own renewal fence refused (more than one lease lifetime since the last confirmed renewal) or `lease-not-held-at-send` when the lease was lost another way or nothing could be measured; the other causes keep the old name, which stays accepted everywhere it was matched. One server log line per lease refusal names the operation, the coordinator's verdict and the renewal gap, with no token, chat or text. The held reply's durable row is due again in 2 seconds, a small bounded timer (2 s, 5 s, 10 s, 30 s; at most four wakes per lease lifetime) runs the existing recovery pass only when the lease is held again, the pass skips such a reply while the lease is away instead of spending a review-ladder step on it, and a replay refused again at the boundary moves its schedule row to the same 2 seconds. The two lease reasons join the sticky lease-held set, so the existing 30-minute hand-back covers them, and they no longer post the first-detection delivery notice; a hold that persists is reported by the existing five-minute scan. Each held reply is counted in the never-silent record as a `sendHolds` row (`GET /never-silent/incidents`, `counts.openSendHolds`), closed with the delivery time when Telegram accepts it. The fence is untouched: no send leaves a machine whose lease check says no.

## What to Tell Your User

- **Replies held by a brief lead hiccup go out in seconds, not minutes**: "If my computer briefly doubts it still holds the lead, a reply it was about to send is held for a few seconds and then sent, instead of waiting minutes. You will no longer get a stale 'reply delayed' warning for one of those blips."
- **The cause is on record now**: "When that happens I can tell you exactly why, from my own log, instead of guessing."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Lease refusals named and logged | Read the server log for `lease-freshness-lapsed` / `lease-not-held-at-send` lines with the lease verdict and renewal gap |
| Seconds-scale retry once the lease is held | Automatic; nothing to turn on |
| Send holds counted | `GET /never-silent/incidents` → `sendHolds` and `counts.openSendHolds` (503 while never-silent is off) |

## Evidence

Unit tests with the real origin runtime, worker and store and a fake lease reader: a boundary refusal with verdict `renewal-lapsed` is held as `lease-freshness-lapsed` with a 2 s next attempt and no transport attempt charged, one log line carries the verdict and gap and no token, the send-hold record is called and the live notice is not; a verdict `superseded` or no reader gives `lease-not-held-at-send`; the recovery pass skips the row while the lease is away (no reservation, no network call) and sends it once when the lease returns, closing the count with the delivery time; the armed timer delivers by itself once the lease is back; a replay refused at the boundary has its review-schedule row moved to 2 s; an episode whose lease never returns ends after its last step with no item. `LeaseCoordinator.holdVerdict()` is tested on both timelines (a renewal landing at 35 s holds; a gap past 60 s is `renewal-lapsed`). The never-silent send-hold list is tested for idempotency, delivery close, the unobserved close at the deadline, an older file shape and its own retention cap.
