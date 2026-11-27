# A message waiting for another machine is answered instead of expiring

During the two-machine test on November 16, two Telegram messages were never answered. The conversation lived on the M5, and the Studio receives Telegram for both machines. The M5 could not yet take messages passed along to it, so the Studio held the messages in its waiting line and tried again and again. When its tries ran out, it made one last attempt, which was meant to put the conversation somewhere that works. That last attempt picked the M5 again (it was alive, and the conversation belonged there), so the messages ran out of time and were dropped. The person was then told "the session stopped running", which was not true: no session had ever started for those messages.

The second message failed for a related reason. With the shared-machines feature turned down, a message for a conversation on a machine that had gone away tries to bring the conversation back to the machine that received it. It asked for ownership in the ordinary way, and the ordinary way never takes a conversation another machine still holds. So every try failed until the message expired.

What changes:

1. The waiting line still waits first. A machine that is alive is never robbed of its conversation at the first message. Only the final attempt, after the whole wait (about 20 minutes by default), changes. If the owning machine still cannot take messages, the receiving machine takes the conversation and answers it.
2. When the owning machine has gone, its conversation is taken over directly instead of asking in a way that can never succeed.
3. Taking over is guarded: it only happens while the machine named in the record still holds it. If the conversation moved somewhere else in the meantime, nothing is overwritten and the message keeps waiting.
4. The notice is honest. While a message waits for the other machine, it says "it's waiting for the other machine that runs this conversation, which can't take messages yet", not that a session stopped.

What does not change: messages to a machine that can take them still go there, and placement rules, pins and the shared-machines stages are unchanged. A single-machine agent is unaffected. Undoing this is a plain revert, with no stored data to repair.
