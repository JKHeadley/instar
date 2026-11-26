# Threadline sends no longer fail on Node 26

## What Changed

`threadline_send` from an MCP session posts to the agent server's `/threadline/relay-send` with a dedicated `undici` Agent (325s headers/body wait). On Node 26 the fetch built into Node rejects an Agent from the `undici` 6.x package with `UND_ERR_INVALID_ARG` before any connection opens, so every send reported "Failed to reach agent server". The request is now resent once through the `undici` package's own fetch with the same Agent, and the process goes there directly from then on. The 325s reply-wait bound is kept.

## What to Tell Your User

If you run your agent on Node 26 and Threadline messages kept failing with "Failed to reach agent server", they send again after this update. Nothing to configure.

## Summary of New Capabilities

- None. This is a bug fix; routes, permissions and message format stay the same.
