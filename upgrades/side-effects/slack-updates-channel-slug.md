# Side-Effects Review — Slack Updates/Attention channel name slugify

## Change summary
Caller-side fix in `src/commands/server.ts`: the `ensureSlackUpdatesChannel` and
`ensureSlackAttentionChannel` boot helpers now slugify the workspace-derived
channel name before calling `SlackAdapter.createChannel`, via a new shared
`slugifyChannelName` helper in `src/messaging/slack/sanitize.ts`. Mirrors the
existing per-session channel slug logic in `SlackAdapter` (`-sess-` path).

## Tier
Tier 1 — small, low-risk, single-machine Slack-adapter boot-path bugfix. No
converged spec required.

## Files touched
- `src/messaging/slack/sanitize.ts` — adds exported `slugifyChannelName(name)`.
- `src/commands/server.ts` — imports the helper; wraps both `-sys-updates` and
  `-sys-attention` channel names with it before `createChannel`.
- `tests/unit/slack-channel-slug.test.ts` — new focused unit test.

## Behavioral side-effects
- **Channel names on FRESH creation**: a workspace name containing spaces or
  uppercase now yields a slugified channel (e.g. "SageMind Live Test" →
  `sagemind-live-test-sys-updates`) instead of a hard failure. For workspaces
  whose name was already slug-clean (lowercase, no spaces), the produced name is
  byte-identical to before — no change.
- **No change to `createChannel` / `validateChannelName`**: the validate-and-throw
  behavior other callers depend on is untouched; the fix only ensures these two
  callers never hand it an invalid name.
- **Idempotent at the state layer**: both helpers early-return when their
  `slack-*-channel` state key is already set, so this only affects the one-time
  creation path; existing installs that already created a channel are unaffected.

## Migration parity
- No agent-installed file changed (no `.claude/settings.json` hooks, no
  `.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no
  built-in skills). This is server-side runtime code shipped in the normal
  build — existing agents receive it on their next update with no migration.

## Rollback
- Revert the squash commit. The change is self-contained (one helper + two call
  sites + one test); no data migration, no state schema change, nothing to undo.

## Blast radius
- Limited to the Slack adapter boot path. Telegram / WhatsApp / iMessage and all
  non-Slack code paths are untouched. Dark-gate config line-map unchanged (no
  ConfigDefaults edit).
