<!-- bump: patch -->

## What Changed

The boot helpers that auto-create the Slack "Updates" and "Attention" channels
(`ensureSlackUpdatesChannel` / `ensureSlackAttentionChannel` in
`src/commands/server.ts`) passed a raw, workspace-derived name straight into
`SlackAdapter.createChannel`. When the workspace name contained spaces or
uppercase (e.g. "SageMind Live Test"), that produced an invalid Slack channel
name like `SageMind Live Test-sys-updates`, which `createChannel` rejects via
`validateChannelName` — so the channel never got created and the boot logged
`Failed to create Slack Updates channel: Invalid channel name`.

Both callers now slugify the name first through a new shared
`slugifyChannelName` helper in `src/messaging/slack/sanitize.ts` (lowercase,
collapse non-`[a-z0-9]` runs to a single hyphen, trim edge hyphens, clamp to
Slack's 80-char limit) — mirroring the per-session channel slug logic the
adapter already used on its `-sess-` path. The `createChannel` /
`validateChannelName` contract other callers rely on is untouched.

## What to Tell Your User

If your Slack workspace name has spaces or capital letters and your agent failed
to create its Updates or Attention channel (an "Invalid channel name" error on
startup), that's now fixed — the channel name is cleaned into a valid Slack
slug before creation. Workspaces whose name was already lowercase-and-dashes see
no change at all.

## Summary of New Capabilities

- New `slugifyChannelName(name)` helper in the Slack sanitize module — a single
  source of truth for turning an arbitrary name into a valid Slack channel name.
- The Slack Updates and Attention boot channels now create reliably regardless
  of workspace-name casing or spaces.

## Evidence

- `tests/unit/slack-channel-slug.test.ts` — the exact failing name
  ("SageMind Live Test-sys-updates") now slugifies to a name `validateChannelName`
  accepts; covers lowercasing, space-collapse, punctuation stripping, edge-hyphen
  trim, already-valid passthrough, 80-char clamp, and a regression assertion that
  the raw un-slugified name is rejected.
- `npx tsc --noEmit` clean; 9/9 new unit tests green.
