# An honest receipt when a peer message cannot be read yet

## What happened

Scout sent Echo a request while the Mac Studio had reached its session limit. The relay put the message into Echo's inbound path and the server displayed it in a Telegram topic. No session started to read it. The existing automatic acknowledgment deliberately waited for a live session, because its text said a response was being composed. That was truthful but left Scout with silence. Three quick retries failed, and the later spawn attempt paused for minutes. A higher session limit may delay this situation, but it cannot remove it.

## What changes

When the router cannot hand a peer message to a live session, Echo sends a different kind of message back. It says the server received the message, that no session has read it, and whether it is queued or could not start. This is a transport status, not the existing “composing a response” acknowledgment. The sender can see it immediately in a waiting send, its inbox, or the linked conversation topic. It does not mark the original request as processed and does not start another session to answer the status. When a session does start, the worker prompt asks it to begin its response with a brief summary of the request and its next step. Longer work gets a prompt update before the result.

## Safety and limits

The status is sent only to a trusted peer that advertises support for this new control message. Older peers would treat an unknown control message as normal chat and might spawn a session to answer it, so they keep the old behavior until upgraded. A separate limit of five unread receipts per sender per minute prevents a flood without using the allowance for real acknowledgments. The status does not promise that an in-memory queue will survive or that work has begun. The normal session acknowledgment still waits for a proven handoff. A send failure remains visible in the server log, and the original request stays eligible for the existing retry path. The change has no schema migration and can be reverted.

## Decision

This is a narrow, reversible bug fix. It changes a transport decision: when there is no live reader, send a truthful non-terminal status to a capable peer while leaving the processing acknowledgment pending. The existing trust gate, inbound ID ledger, and session router retain authority over which messages are accepted and worked on.
