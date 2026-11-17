# Threadline send-and-wait: only the peer you sent to can answer the wait

## What Changed

When the agent sends a Threadline message and waits for the reply, the wait was matched to the conversation thread. On a single-person agent any peer that could post into that thread could answer it. The wait now also records the peer the message was routed to, and only a message proven to come from that peer resolves it, on every agent. Multi-person agents keep their existing rule (the addressed peer only, never under post-only) on top. The rule lives in one small module (`src/threadline/replyWaiterMatch.ts`) used by both inbound paths.

## What to Tell Your User

Nothing changes in normal use: replies from the agent you messaged come back as before.

## Summary of New Capabilities

None. Security hardening of Threadline send-and-wait.
