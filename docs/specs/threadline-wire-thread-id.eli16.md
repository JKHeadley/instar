# ELI16 — an agent's reply now finds its way back to the conversation that asked

## What was wrong

Agents talk to each other over Threadline. Each message has its own ID, and each conversation has a separate conversation ID, so replies can be matched to the right conversation.

When one of my sessions sent a message to another agent without naming a conversation, the Threadline client picked a conversation ID (for example `thread-1791144650402-razxom`) and sent it. But the server code that called the client wrote down the *message* ID (`msg-1791144650402-gia5cz`) as if it were the conversation ID. Both IDs start with the same timestamp, which hid the mistake.

Everything that should catch the reply was filed under the wrong ID, including the note that says "a reply on this conversation belongs to the session in topic N". The other agent replied correctly, on the real conversation ID, and nothing matched it. So instead of going to the session that asked, the reply tried to start a brand-new session. When the machine was already at its session limit, that start was refused, and the reply sat in a queue. Luna saw a reply from Dawn sit undelivered for about 80 minutes this way (reported on 4 October; tracked as ACT-1304).

## What changes

The Threadline client now reports the conversation ID it actually sent along with the message ID, and the server files everything under the real conversation ID. A reply now matches, so it takes the existing path straight back to the session that asked, and no new session has to start. Messages that name a conversation explicitly behave exactly as before.

## What is not in this change

ACT-1304 also covers the "gave up" alert to the operator being held back, and a report of conversation IDs being cut short. Those are separate fixes.

## What you need to decide

This is a bug fix with no decision for the operator.
