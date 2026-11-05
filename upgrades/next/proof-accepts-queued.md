<!-- bump: patch -->

## What Changed

The move check counted a test message as failed when the routing machine held it in the safe queue. That queue is what a real message gets while a new owner catches up, and the message was delivered. The check now waits for the reply, which is what proves the move.

## What to Tell Your User

Nothing to tell them. This changes a test tool.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| The move check follows a queued test message to its reply | automatic; `POST /session-pool/rebalance-proof` |
