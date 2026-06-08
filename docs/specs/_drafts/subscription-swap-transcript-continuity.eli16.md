# Account-swap conversation continuity — Plain-English Overview

> The one-line version: when a session moves to another account, it now copies the conversation history over first — so it actually picks up where it left off instead of starting blank.

## The problem in one breath

Each account's login lives in its own folder, and Claude keeps the conversation history in that same per-account folder. The quota swap switched which account a session uses, but left the conversation behind — so resuming on the new account said "no conversation found" and the session would start fresh. The whole point of the "never lose your session" guarantee was quietly broken.

## How it was missed

The automated test that ships with the feature SIMULATED the restart — it never moved a real conversation between two real account folders. So it passed while the real thing was broken. The live test caught it immediately.

## The fix

Right before a swapped session resumes under the new account, I copy its conversation history file into that account's folder. Then `--resume` finds it and the session continues exactly where it left off. It's safe: it only runs during an account swap, only copies (never deletes), and if anything goes wrong it just falls back to today's behavior (a fresh start) instead of erroring.

## Proven

- A focused test covers the copy (source→target, no-op when already there, default-folder source, not-found case).
- And end-to-end on your real accounts: a conversation started on SageMind, after the copy, resumed on the Justin account and correctly recalled its test marker.
