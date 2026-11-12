# A check-in no longer throws away a held reply (plain-English overview)

## What happened

On the evening of November 10, Justin asked a question in Telegram. The agent wrote two replies on one Mac and handed them to the other Mac (the Studio), which does the actual sending. The Studio was busy and could not send them right away, so it held them to try again shortly.

Twenty minutes later, Justin wrote "Checking in here". On its next try, the Studio threw both held replies away. It has a rule: if the conversation has moved on since a reply was written, the reply is probably out of date, so drop it. Justin's check-in counted as the conversation moving on. Nothing recorded that the replies were dropped, and the agent had been told "don't resend, it may have gone through". The answer Justin was waiting for never arrived.

## What already exists

The rule was added on November 4 for a real problem. Sometimes a held reply arrived 30 or 40 minutes late, after the user had already got a newer answer, and it read as confusing and out of order. Dropping stale replies fixed that. The rule also already ignores the agent's own automatic notices ("a reply is delayed").

## What changes

1. **Only a newer reply from the agent makes a held reply out of date.** A message from the user alone never does. If the user writes while a reply is held, they are usually waiting for exactly that reply. The November 4 case still works, because there the agent had also sent a newer answer, and that alone is enough to retire the old one.
2. **A dropped reply is never silent.** When a held reply is dropped, the record now says why ("overtaken-reply"), and it appears as a dashboard item: "A held reply was not sent because a newer reply reached the conversation first." Nothing is posted into the chat, because the conversation already has a newer reply.

## Safeguards

The change only ever makes Instar more likely to deliver a reply, never less. A reply that arrives late still carries the existing "this arrived late" label. If Instar cannot read the conversation history from every machine, it still waits rather than guessing, exactly as before.

## What you need to decide

Nothing beyond reviewing the change. It is small, a revert fully undoes it, and the tests reproduce the November 10 failure.
