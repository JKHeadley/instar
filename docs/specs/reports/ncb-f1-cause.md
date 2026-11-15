# NCB F1: why the first reply in topic 141868 was suppressed

Commitment CMT-057, effort native-conversation-base. Read-only investigation, run 2026-11-12 ~08:40 PST.

## Machine

- `hostname`: `DaBombs-Mac-Studio.local`, agent home `/Users/dabombstudio/.instar/agents/echo`. This is the Mac Studio, the lease holder.
- The server on port 4042 reports `currentVersion 1.3.1740`. The installed copy is `1.3.1741`, which is not running yet. Code below was read from the 1.3.1741 install; the paths I quote exist in it.

## Short answer

The reply was not dropped by a duplicate or content check. Two things happened in sequence:

1. **The tone gate held it, repeatedly (18:12 to 18:22 UTC).** Operation `ad98a42a-6756-46e8-9df5-ff0049995481` (2944 chars, "Here's how I understand it, so you can correct me before anything gets built.") got the advisory verdict `B11_STYLE_MISMATCH` three times. Each time the Studio's outbox recovery logged `recovery retained operation ad98a42a… TelegramOriginHoldError` and kept it queued, not sent.
2. **The queued-reply review then retired it as overtaken.** The operation is now in state `suppressed`. The only code path that suppresses a queued session reply on that topic is `TelegramOriginRuntime.allowQueuedRecovery`, which calls `reviewQueuedReply` (`QueuedReplySupersession.queuedReplyOvertaken`) and gets `retire`, because Justin's screenshot (message 141901, 18:35:15 UTC) and then an agent message (141903, 18:35:54 UTC) arrived after the draft time.

**Confidence: high** on the tone-gate hold and the final `suppressed` state. **Medium-high** that the overtaken review is what wrote `suppressed`. Every other suppression path is ruled out below. The direct log line for this step (`retired overtaken queued reply`) is a `console.info` that goes to stdout, and that output did not survive.

## Evidence

### Server log, `.instar/logs/server-stderr.log` (the only copy, nothing rotated)

```
21312:[tone-gate] {"t":"2026-11-11T18:12:05.860Z",...,"topicId":141868,"textLen":2944,"textHead":"Here's how I understand it, so you can correct me before anything gets built.\n\nT","pass":false,"rule":"B11_STYLE_MISMATCH",...,"advisory":true,"advisoryOverridden":false,...,"latencyMs":19840,...}
21314:[tone-gate] {"t":"2026-11-11T18:12:28.091Z",...,"topicId":141868,"textLen":2944,...,"pass":false,"rule":"B11_STYLE_MISMATCH",...,"advisory":true,...,"latencyMs":20078,...}
21315:[telegram-origin] recovery retained operation ad98a42a-6756-46e8-9df5-ff0049995481 TelegramOriginHoldError
21366:[tone-gate] {"t":"2026-11-11T18:21:59.324Z",...,"topicId":141868,"textLen":2944,...,"pass":false,"rule":"B11_STYLE_MISMATCH",...,"advisory":true,...,"latencyMs":15298,...}
21367:[telegram-origin] recovery retained operation ad98a42a-6756-46e8-9df5-ff0049995481 TelegramOriginHoldError
21435:[tone-gate] {"t":"2026-11-11T18:35:53.879Z",...,"topicId":141868,"textLen":184,"textHead":"Sorry Justin, I see now that nothing reached you. Your screenshot is on the othe","pass":true,...}
21436:[tone-gate] {"t":"2026-11-11T18:36:27.430Z",...,"topicId":141868,"textLen":3229,"textHead":"Here's how I understand it, so you can correct me before anything gets built.\n\nT","pass":true,...,"budgetExceeded":true,...}
```

Around the same window the origin layer was also struggling. `[telegram-origin] config snapshot unavailable: origin-config-reader-timeout` appears again and again, and so does `[SleepWakeDetector] Drift ~16s but this process burned 106% CPU through the gap — event-loop BLOCK`. Each tone review took 15 to 20 seconds.

Searches with no hits in 18:05 to 18:45 UTC: `overtaken`, `superseded`, `duplicate-content`, `content-check`, `recordSuppressed`, `quiet-notification-recorded`, `retired historical delivery notice`, `queued reply`.

### Origin operation outcome (lease holder's store)

`GET /telegram/origins/operations/ad98a42a-6756-46e8-9df5-ff0049995481/outcome`:

```
{"operationId":"ad98a42a-6756-46e8-9df5-ff0049995481","outcome":"not-delivered","safeToResend":true,"source":"origin-store","messageIds":[],"state":"suppressed","detail":"The server decided not to send it."}
```

`messageIds: []` means no part reached Telegram. The response carries no hold reason. The running 1.3.1740 server's outcome route uses wording ("The server decided not to send it.") that is no longer in the 1.3.1741 source. In 1.3.1741, a `suppressed` row with no reason is reported as `unknown` / "do not resend".

### Pooled topic history (`/telegram/topics/141868/messages?scope=pool`, `pool.failed: []`)

```
2026-11-11T18:09:27Z user  141869 "Hi Echo! I'd like to dedicate this topic to an official ongoing effort"
2026-11-11T18:35:15Z user  141901 [image] (Justin's screenshot)
2026-11-11T18:35:54Z agent 141903 "Sorry Justin, I see now that nothing reached you. ..."
2026-11-11T18:46:20Z user  141910 "1) pretty close, however the process wasn't exactly applied fractally ..."
```

No agent message in this topic between 18:09 and 18:35. Neither the 2944-char version nor the 3229-char revised version of the reply appears in the pooled history.

## Which retirement path fired

Callers that write `state: 'suppressed'` (1.3.1741 `dist/messaging/telegram-origin/`):

| Path | Log line it writes | Fits? |
|---|---|---|
| `TelegramOriginService` content reservation → `duplicate-content` (OutboundContentDedup / OriginContentDedup) | `OriginSendPolicyRefusal`; outcome would read "The user already has this text" | **No.** No earlier copy of the text was ever delivered, and the outcome says not-delivered. |
| `TelegramOriginService` quiet-notification gate | `holdReason: 'quiet-notification-recorded'` | **No.** That gate is for automation, and a quiet row reads back as a quiet receipt. |
| `TelegramOriginRuntime.withholdHistoricalDeliveryNotice` | `retired historical delivery notice` | **No.** It only covers `producerId: reply-delivery-notice`. |
| `OriginMeshRelay` quiet record | `quiet-notification-recorded` | **No**, same reason. |
| `TelegramOriginService.recordSuppressed` | none | Not part of the recovery loop that was retrying this operation. |
| **`TelegramOriginRuntime.allowQueuedRecovery` → `reviewQueuedReply` → `retire` (QueuedReplySupersession)** | `console.info('[telegram-origin] retired overtaken queued reply', id)` to stdout | **Yes.** It is the session-reply path, it runs on every recovery tick for exactly this kind of held operation, and it sets `suppressed` with no hold reason. That matches the outcome row. Its trigger, a user or agent message newer than the draft time, held from 18:35:15 on. |

`queuedReplyOvertaken(preparedAt, messages)` returns true for any `fromUser` or `provenance === 'agent'` message after `preparedAt`. Justin's 18:35:15 screenshot alone is enough, whether it was checked against local or pooled history.

## Conclusion

The M5 Pro session's reply was forwarded to the Studio and queued. On every recovery tick, the Studio's tone gate gave it an advisory `B11_STYLE_MISMATCH` verdict (at 18:12:05, 18:12:28 and 18:21:59). Nobody was there to act on that advisory, because the authoring session is on another machine and the "revise or override" handback only reaches a direct sender. So the operation stayed held. When Justin posted a screenshot at 18:35:15, the queued-reply review treated the conversation as having moved on and retired the reply as overtaken (`suppressed`, no reason recorded). The reply never reached Telegram.

The real fault is the first step: **an advisory, overridable tone verdict acts as an indefinite hold on a forwarded, queued reply.** That turns a nudge into a block. The overtaken rule then permanently discards a reply the user never saw, and Justin's message at 18:35 was exactly "nothing reached me". That message is not evidence that the reply was superseded.

## What I could not find

- **The `retired overtaken queued reply` line itself.** It is `console.info` (stdout). The server's stdout goes to the `echo-server` tmux pane, and that session was created Thu Nov 12 00:22 PST, after the event, so the output is gone. No other log on the Studio mentions `ad98a42a`.
- **The full operation audit** (hold reason, hold detail, attempts, `preparedAt`). `GET /telegram/origins/operations?topic=141868` returns `403 operator-audit-scope-required`, because it needs an `X-Instar-Operator-Session`. I did not get around that, since the task is read-only. I also could not find a local SQLite file holding the live origin store among the server's open files.
- **What happened to the revised 3229-char version.** It passed the tone gate at 18:36:27, but it is not in the pooled topic history. It needs its own trace, probably also overtaken (by the 18:35:54 agent message) or held on the M5 side. I have no operation id for it.
- **The M5 Pro side** (the forward request, the original draft's `preparedAt`, any 409 or advisory handback to the authoring session). I did not check it. The task scoped this run to the lease holder.
