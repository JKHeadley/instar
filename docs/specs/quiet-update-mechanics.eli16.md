# Quiet Update Mechanics — Plain-English Overview

> The one-line version: update messages full of version numbers and restart plumbing now go to the logs instead of buzzing the user — they only hear about an update when something is genuinely new, a restart is about to interrupt them, or an update is truly stuck.

## The problem in one breath

The agent's "Updates" channel was filling up with messages the user can't use: "Just updated to v1.3.217. Restarting…", "v1.3.217 was applied but I'm still running v1.3.218, the next restart should pick it up", "rolling into the pending restart at 02:42". To the user these read as meaningless version churn — exactly the "notifications that reference things I have no clue about" they complained about. None of it is something they need to read or act on.

## What already exists

- **The maturity layer (shipped as #698)** — makes *feature announcements* silent-by-default and honest about how finished a feature is (Experimental / Preview / Stable). It only governs "here's a new capability" messages, NOT restart/version status.
- **The auto-updater + restart handshake** — the machinery that downloads an update, restarts the server to load it, verifies the new version booted, and coordinates so two updates don't cause two back-to-back restarts. Along the way it emits a dozen hardcoded status messages — and those are what leaked to the user.
- **The Agent Updates topic** — the dedicated channel all of these messages route to.

## What this adds

A single rule that sorts every update message into one of four buckets before it can reach the user: **mechanics** (version/restart churn — goes to the logs), **interruption** (a restart is hitting the user's active work right now — they hear a plain "back in a few seconds"), **actionable** (auto-updates are off, so they must say "update"), and **stuck** (an update genuinely failed after retries). Only the last three reach the user, and all the restart/interruption wording was rewritten to drop version numbers entirely.

Secondary changes: the default bucket is "mechanics" (silent), so any future update message a developer forgets to classify stays quiet instead of accidentally spamming. And there's an opt-in flag for people who'd rather get one quiet "just refreshed in the background" note than total silence.

## The new pieces

- **`updateNotifyPolicy`** — a tiny, pure decision function: given a message's bucket, it answers "does this reach the user, yes or no?" It does no I/O and holds no state, so it's easy to prove correct on every branch. It is NOT allowed to send anything itself or know anything about Telegram — it only decides; the caller sends. That line matters because it keeps the "who hears what" rule in one tested place instead of scattered across a dozen message sites.

## The safeguards

**Prevents the version-churn flood from coming back.** The opt-in "background heartbeat" flag can only ever surface ONE specific message (the post-restart "I'm current" note). Every other mechanics message stays silent even with the flag on, so the flag can't be a backdoor that reopens the flood.

**Prevents accidental future spam.** Because the default bucket is "silent mechanics," a new update message added later is quiet unless someone deliberately marks it user-facing. Forgetting is safe; the failure mode points at silence, not noise.

**Prevents losing a genuinely-important signal.** A restart that actually interrupts the user, and an update that's truly stuck after retries, still reach them — just without the version jargon. We did not silence everything; we silenced the noise.

## What ships when

One change, one PR: the policy module, the classification wired through the auto-updater and the restart handshake, the version-free message rewrites, the config flag, full unit tests, the agent-awareness note (template + migration), and the release fragment. It ships on the next npm update; existing agents get the behavior automatically and the awareness note through the migration.

## What you actually need to decide

You already decided: option A (full silence for no-op updates), which is the default this ships with — do you agree this is clear to ship?
