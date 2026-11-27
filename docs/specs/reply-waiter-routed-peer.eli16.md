# Send-and-wait: only the peer you sent to can answer — plain-English overview

## What this is

Your agent can send a message to another agent and wait for the answer. The wait was tied to the conversation, not to who answers, so on most agents another agent that could post into that same conversation could slip in an answer of its own.

## What changes

The wait now remembers which agent the message actually went to, and only a reply proven to come from that agent ends it. Everything else about the conversation is unchanged.

## What you would notice

Nothing. Replies from the agent you messaged come back as before. In the rare case a peer answers from a different identity than the one the message went to, the reply still arrives in the conversation; only the waiting tool times out instead of returning it.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
