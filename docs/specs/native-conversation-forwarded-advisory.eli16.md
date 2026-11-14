# A style nudge should reach the writer, and never cause a double message: the plain-English version

For Justin. This goes with `native-conversation-forwarded-advisory.md`, slice 3g of the native conversation effort. It is a draft, revised after the first round of review.

## What went wrong

On 11 November I wrote you a long reply in the effort topic from the M5 Pro. Only the Studio is allowed to post to Telegram, so the M5 Pro passed the reply to the Studio. Before posting, the Studio ran its usual check on how the message was written. The check said, in effect, "this could be worded better". That is a suggestion. The writer is meant to either improve the message or say "send it anyway, and here is why".

The suggestion never got back to the session that wrote the reply, because that session was on a different machine. So nobody answered it. The Studio asked the same question again and again and kept the reply waiting. Twenty minutes later an older rule threw the reply away. You saw nothing, and told me so.

Review also found a second problem that exists today: when the Studio turns a reply down straight away, it tells the writer "not sent" but keeps its own copy in the queue. The writer sends a better version, and the old one can still go out later. You would get both.

## What this changes

1. **The suggestion goes back to the writer.** The Studio saves the suggestion and lets go of its copy of the reply. The machine that wrote the reply keeps the only copy and tells the writing session in one line: what the suggestion is, how to send a revised version, and how to send it as it is.
2. **The reply waits for its writer.** Nothing sends it except the writer's answer. If the writer sends a new version, it replaces the waiting one in a single step, so you can never get both. If nobody answers, the reply ends at its normal deadline and the writer is told it was not delivered.
3. **Real blocks are reported at once.** If the check finds a password or key, or finds me quitting on a task, the reply is not sent and the writer is told straight away instead of hours later.
4. **A check that could not run is not a verdict.** If the checker is down or overloaded, the reply stays in the queue and is checked again. It is not thrown away.
5. **The check runs once per reply**, not on every retry. Each run took 15 to 20 seconds on a busy machine.

## What changed from the first draft

The first draft sent the reply as written after three minutes of silence. I removed that. The Studio cannot tell whether a new message from the writer is a revised version of the waiting one or something else, so a timer could send you the old text after the new one. A late reply is better than a duplicate.

## What it costs

If the writing session has gone away, its reply now waits and then ends undelivered, with a note left for the session. On 25 November I will count how often that happened and how long writers took to answer, and decide whether silence should ever release a reply.

## What you need to do

Nothing. This changes no rule you approved, so I approve it myself once it has been reviewed. It will be tested on a throwaway agent with two machines, plus one Slack check, before it reaches any real conversation. Slack does not have this problem: Slack replies are checked and posted on the same machine, so the answer always comes straight back to the writer.
