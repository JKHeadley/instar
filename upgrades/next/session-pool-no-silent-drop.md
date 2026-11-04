<!-- bump: patch -->

## What Changed

A machine that receives a forwarded message it cannot serve now hands it back instead of acknowledging it and dropping it, and a retry of a message it already took stays a duplicate. No new message type, so older peers understand the answer.

## What to Tell Your User

Nothing to do. On an agent with several machines, a message can no longer vanish because it reached a machine that could not answer it.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| No silent drop on forwarded messages | automatic |
