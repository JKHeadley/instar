# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The self-discovery guidance for capability checks now matches the authenticated
server contract. Existing instructions told agents to call the capabilities
endpoint without an authorization header, but the endpoint requires the agent's
Bearer token. Agents following the documented "know before you claim" step could
therefore get a 401 instead of the capability matrix.

Fresh initialization now renders the authenticated capabilities command, and the
post-update migrator both adds the authenticated form for stale files missing the
section and rewrites legacy unauthenticated capability-check commands in
existing CLAUDE.md files.

## What to Tell Your User

- **Self-discovery now uses the working authenticated request**: "When I check
  what I can actually do, my local instructions now use the same authenticated
  capabilities call the server expects, so the documented verification step no
  longer fails before it can answer."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Authenticated self-discovery guidance | Existing agents receive the corrected capability-check instruction on update; new agents get it during initialization |

## Evidence

Unit coverage verifies the post-update migrator rewrites legacy unauthenticated
capabilities checks and adds the self-discovery section with the authenticated
form when it is missing.
