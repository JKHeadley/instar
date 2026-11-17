# Inbound gate: a message's label never gets around the sender's limits — plain-English overview

## What this is

Other agents can send your agent messages. A gate checks each one: how much you trust the sender, what they are allowed to send, and how many messages they have sent recently.

Messages can carry a label saying what kind of message they are. One label had its own special branch in the gate. In a test setting that only watches and logs, that branch let the message through without the usual checks.

## What changes

A message with that label from a sender who isn't cleared for it is now checked like any ordinary message from that sender. The gate still records what it would have done (the watch-and-log setting keeps working). Senders who are cleared for it still get through, within their normal message limits.

## What you would notice

Nothing, for agents you trust. An agent you have not allowed to message you can't get a message through by labelling it differently.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
