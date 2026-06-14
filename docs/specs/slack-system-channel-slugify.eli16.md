# Slack System-Channel Name Slugify — Plain-English Overview

> The one-line version: when an agent's Slack workspace name has spaces or capitals (like "SageMind Live Test"), the agent could no longer create its Slack Updates and Attention channels — this fixes the name it asks Slack for so those channels actually get created.

## The problem in one breath

When an instar agent connects to Slack, it tries to create two housekeeping channels at startup: an "Updates" channel (for version/feature announcements) and an "Attention" channel (for alerts that need you). It builds the channel name from the workspace name — but it forgot to clean that name up first. Slack only accepts channel names that are lowercase letters, digits, and hyphens, so a workspace called "SageMind Live Test" produced the name "SageMind Live Test-sys-updates", which Slack rejected outright. The result: the Updates channel was never created, and every server boot logged `Failed to create Slack Updates channel: Invalid channel name`.

## What already exists

- **The Slack adapter's session channels** — when the agent spins up a per-conversation Slack channel, it already cleans the name correctly: it lowercases the workspace name and replaces anything that isn't a letter or digit with a hyphen (the `<workspace>-sess-...` pattern in `SlackAdapter`). That path has always worked.
- **The channel-name validator** — `ChannelManager.createChannel` runs every requested name through `validateChannelName` (in `src/messaging/slack/sanitize.ts`) and throws if the name isn't lowercase-alphanumeric-with-hyphens. This is the gate that was correctly rejecting the bad names.
- **The two system-channel creators** — `ensureSlackUpdatesChannel` and `ensureSlackAttentionChannel` in `src/commands/server.ts` build their names directly from the workspace name. These are the two callers that skipped the cleanup step.

## What this adds

One small shared helper, `slugifyChannelName`, placed right next to the validator it has to satisfy (in `sanitize.ts`), and used by both system-channel creators. It does exactly what the session-channel path already did — lowercase, turn every non-`[a-z0-9]` character into a hyphen, collapse repeated hyphens, trim the ends, and fall back to `"agent"` if the name empties out entirely. Both `ensureSlackUpdatesChannel` and `ensureSlackAttentionChannel` now run the workspace-derived name through it before appending `-sys-updates` / `-sys-attention`.

## The new pieces

- **`slugifyChannelName(raw)`** — a pure, no-side-effect string helper. It takes a raw name segment and returns a Slack-channel-safe slug. It is deliberately co-located with `validateChannelName` so the cleanup rule and the validation rule can't drift apart over time. It is NOT a gate, a sentinel, or anything that makes a decision about agent behavior — it just produces a valid name.

## The safeguards

**No behavior change for already-valid names.** A workspace name that was already lowercase-and-hyphenated (like `echo` or `ai-guy`) passes through untouched, so existing agents whose channels already work see zero change.

**The fix is proven, not asserted.** The unit test includes the exact failing case ("SageMind Live Test") and checks both that the slug is correct AND that the full `<slug>-sys-updates` name now passes the real `validateChannelName` gate — plus a test that confirms the OLD un-slugified name would have failed, so the regression can't silently come back.

**It can never produce an empty or invalid name.** If a workspace name is all symbols (or blank), the helper falls back to `"agent"`, which is itself valid — so the channel creation can't fail a different way.

## What ships when

This is a single Tier-1 fix: one helper, two one-line caller changes, one unit test. It ships in one PR. It is single-machine behavior with no multi-machine, replication, or cross-agent surface — the Slack channel set is created locally on whichever machine fronts the Slack connection.
