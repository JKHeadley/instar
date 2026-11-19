# A promise reminder actually reaches the person

When the agent promises something by a set time and the time passes, the agent is supposed to tell the person "this is late". We tested it live this morning. The agent's records said the message went out, but the person never got it.

Why: the agent has a filter called Quiet by Default. It keeps routine automatic reports out of the chat and puts them in a Notifications list instead. The promise reminder was labelled as one of those routine reports, so the filter held it. The part that sends the reminder didn't check whether the message was really sent or only held. It saw no error, wrote down "told the person", and told the agent's session the same thing.

What changes:

1. Promise reminders get their own label, "Promises made to you". The filter always lets that label through, because it is the agent keeping its word in the person's own conversation, not a report. A small limit (6 per conversation per 10 minutes) stops a runaway loop from flooding anyone.
2. If a reminder is ever held instead of delivered, it now counts as a failure. It is retried. If it keeps failing, it is marked undelivered and raises an alert. It is never recorded as "told".

Nothing to set up. Reminders still only send when the reminder feature is switched on.
