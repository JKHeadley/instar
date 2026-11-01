# Secret sync push timeout — Plain-English Overview

> The one-line version: when this agent copies its secrets to another of its machines, it now waits long enough for that machine to finish saving them, instead of reporting a failure that did not happen.

## The problem in one breath

The agent can copy a secret it holds (a password, an API key) to its other machines, so you never enter it twice. On 2026-10-31 the copy to the Windows machine was reported as "aborted" three times in a row. The Windows machine's own log shows it received and saved every copy. The sender simply stopped waiting after 5 seconds, which is the general limit for messages between machines, while the receiver was still decrypting and saving the whole set.

## What already exists

- Secret sync: secrets are encrypted to each machine's own key and pushed to the agent's other machines.
- A general 5-second limit on every message between machines, which is right for small messages and too short for this one.

## What this changes

The secret copy alone now waits up to 30 seconds for the answer. Nothing else changes: other messages keep the 5-second limit, the secrets themselves and their encryption are untouched, and a machine that is really unreachable still reports failure, just later.

## Safeguards

- Only one call site changes, and only its waiting time.
- The push is still started only by the operator's explicit lever or the boot-time push; nothing retries on its own.

## What you need to decide

Nothing. This makes the status honest; it does not change what gets copied or where.
