# A record for each daily notification summary (ELI16)

The agent can hold back routine notices so your phone does not buzz all day. If you switch it on, it can also send you one short summary a day: "12 quiet notices since yesterday" and so on. That summary is off unless you turn it on.

Before anyone suggests keeping a feature like that, we want proof it works every day. But the only record the summary left was written when a summary was actually sent. On a quiet day with nothing to report, nothing was written, and if sending failed, nothing was written either. So there was no honest way to say "it ran every day for two weeks".

Now each day's summary run writes one small line to the log: sent, nothing to send, or the send failed. The line holds only numbers (how many notices, how many kinds), never the summary's words. The checklist that judges the feature counts those lines and treats a failed send as a problem. Nothing turns the summary on by itself; that stays your choice.
