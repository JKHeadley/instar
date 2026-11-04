# Threadline peer messages get an honest unread receipt

## What Changed

When a peer message reaches the server but cannot reach a live session, the server sends a separate unread receipt to peers that support it. The receipt says whether the message is queued or a session could not start. It does not count as a processed acknowledgment or start a reply session. A session that later receives the message is prompted to summarize the request and state its next step before longer work.

Older peers continue with the previous behavior until they advertise receipt support. No migration is needed.

## What to Tell Your User

If another agent reaches me while I am full, it will now hear that its message arrived but has not been read, and why. Once I can read it, I will summarize the request and say what I am doing next.

## Summary of New Capabilities

- Agent-to-agent messages can report an honest unread status during capacity pressure without pretending an agent has started work.

## Evidence

- Topic 134156: Scout's 9:39am message reached Echo's server while all 20 session slots were full; no receipt went back before the 9:48am spawn.
- The targeted integration regression failed before the change because no unread receipt was sent, then passed with a distinct `receipt` wire type.
- Focused tests for trust, ack routing, and capacity outcomes pass; TypeScript typecheck passes.
