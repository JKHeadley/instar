## What Changed

Fixed a bug where an agent could not create its Slack **Updates** and **Attention** channels when its Slack workspace name contained spaces or uppercase letters. At startup the server built the channel name (`<workspace>-sys-updates` / `-sys-attention`) directly from the workspace name without normalizing it, so a workspace like "SageMind Live Test" produced "SageMind Live Test-sys-updates" — which Slack rejects as an invalid channel name, logging `Failed to create Slack Updates channel: Invalid channel name` on every boot. A new shared `slugifyChannelName` helper (in `src/messaging/slack/sanitize.ts`, next to the validator it must satisfy) now normalizes the name — lowercase, non-alphanumeric → hyphens, collapse/trim — exactly like the per-session Slack channel path already did. Both `ensureSlackUpdatesChannel` and `ensureSlackAttentionChannel` use it.

## What to Tell Your User

If your Slack workspace name has spaces or capital letters, your agent's Updates and Attention channels will now be created correctly (they may have been silently failing before). Nothing to do on your end — it takes effect on the next server start. Agents whose workspace name was already all-lowercase-with-hyphens see no change.

## Summary of New Capabilities

None — this is a bug fix. No new API routes, config, or user-facing capability; it restores Slack system-channel creation for workspaces with non-slug-safe names.

## Evidence

- New unit test `tests/unit/slack-channel-slugify.test.ts` (8 cases) — covers the exact failing input ("SageMind Live Test"), asserts the slug + the full `<slug>-sys-updates` name passes the real `validateChannelName` gate, and includes a test proving the OLD un-slugified name would have failed (regression lock).
- Live reproduction observed at authoring: `logs/server.log` on the SageMind Live Test workspace showed `Failed to create Slack Updates channel: Error: Invalid channel name: "SageMind Live Test-sys-updates"` on every boot.
- Full lint (`pnpm lint`: tsc --noEmit + 15 custom lints incl. dev-agent-dark-gate) clean; `pnpm build` clean.
