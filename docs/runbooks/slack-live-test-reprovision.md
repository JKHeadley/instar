---
title: Slack Live-Test App Re-provisioning
status: operator runbook
audience: agents and workspace operators
---

# Slack live-test app re-provisioning

Use this runbook when a demo-workspace Slack adapter lost or rotated its credentials. It is a re-provision path for an isolated test app, not permission to attach another agent to an existing app identity.

## Safety contract

- Use only the dedicated demo workspace. Do not connect production integrations or real effects.
- One agent gets one Slack app and bot identity. Fresh tokens for another agent's app are not a substitute.
- Start observe-only. Re-provisioning never authorizes an enforcement flip.
- Collect credentials through Secret Drop or an owner-read-only credential fixture. Never paste tokens into chat, command arguments, logs, or a plan document.
- Validate every gate below before applying config. A failed gate leaves the adapter unconfigured.

## 1. Identity gate — before minting or accepting tokens

Create a new Slack app whose display name identifies the target agent. Record its non-secret app ID and bot user ID.

Before accepting the credential set:

- call `auth.test` with the bot token and verify the returned team ID is the intended demo workspace;
- verify the returned bot user ID matches the newly created app;
- compare the app ID against every other agent app already installed in the workspace;
- refuse if the app ID or bot user ID belongs to another agent, even if both tokens are newly minted;
- open a Socket Mode connection with the app-level token and require a live `wss://` URL.

Why this is a hard gate: multiple agents attached to the same Socket Mode app can compete for inbound envelopes. The resulting replies cannot be attributed honestly, and one agent can consume traffic intended for the other. The July 2026 Codey canary caught this when a newly reinstalled bot token and a fresh app-level token still belonged to Echo's existing app.

## 2. Exact app configuration

Enable Socket Mode and create an app-level token with `connections:write`.

Subscribe to these bot events:

- `message.channels`
- `message.groups`
- `message.im`
- `app_mention`

Install the following bot scopes. The live preflight compares the response's `x-oauth-scopes` header against this matrix and refuses on any missing row.

| Scope | Required for |
|---|---|
| `app_mentions:read` | directed channel mentions |
| `channels:history` | public-channel history and recovery |
| `channels:join` | joining approved public demo channels |
| `channels:manage` | supported channel-management path |
| `channels:read` | channel discovery and identity |
| `chat:write` | outbound replies |
| `files:read` | file/snippet self-verification and ingestion |
| `groups:history` | private-channel history |
| `im:history` | DM history |
| `im:read` | DM discovery |
| `im:write` | DM replies |
| `pins:write` | supported pin operations |
| `reactions:read` | reaction-driven flows |
| `reactions:write` | processing indicators and acknowledgements |
| `users:read` | verified principal resolution |

Adding scopes is not enough: reinstall the app to the workspace so the bot token actually carries the new grants. Validate the token after reinstall; do not infer grants from the portal UI.

### Updating an existing demo app

Prefer a manifest-backed scope update when the authenticated Slack app-configuration API is available: update the app's manifest, then reinstall it to mint a bot token carrying the revised grants. A successful manifest update is configuration evidence, not token evidence; the `x-oauth-scopes` header after reinstall remains authoritative.

If the app-configuration API is unavailable, use the Slack portal while signed in as the demo workspace's verified owner test identity. A bot token, an app-level Socket Mode token, or an agent's ordinary Slack seat does not confer app-administration authority. Treat an expired owner browser session as an operator-only sign-in gate rather than trying to copy browser cookies or switch identities silently.

## 3. Scope-and-invite gate

Before adapter configuration, prove all of the following from live Slack API responses:

- the required-scope difference is empty;
- both tokens validate;
- the bot is an active member of every canary channel;
- no canary channel is archived.

Invite the bot explicitly to each private or shared-mode channel. A channel ID in config is not membership evidence. If the bot lacks membership and cannot join with its own scoped token, mark the gate operator-only; do not weaken the smoke matrix or fabricate a channel pass.

For public demo channels, a bot carrying `channels:join` can self-join through the supported API path. Re-read `conversations.info` afterward and require `is_member:true`; a successful join call without that read-back is not sufficient. Private channels still require an authorized member or workspace owner to invite the bot.

Recommended demo channels:

- an engineering/operations channel for directed inbound and threaded-session tests;
- a social/ambient channel for opt-in ambient tests.

## 4. Observe-only configuration

After the identity, scope, Socket Mode, and membership gates pass:

- store the bot and app-level tokens in the agent's encrypted SecretStore;
- put only secret placeholders in the messaging config;
- set the verified workspace/team ID;
- use shared workspace mode and mention-only response mode for the first boot;
- enable the permission gate with `observeOnly: true`;
- keep the live-test cast in `permissionGate.testCast`, set `testWorkspace: true`, and bind it to the verified team ID;
- never seed fixture principals into the production user registry;
- opt thread sessions into named demo channels only.

Restart the agent and require boot evidence for the intended workspace, Socket Mode connection, observe-only attachment, admitted test-cast seats, and adapter self-verification.

Before admitting a spawned Slack session, verify relay readiness on the adapter-owning machine:

- `.instar/scripts/slack-reply.sh` is a regular non-symlink file, mode `0755`, and its SHA matches the packaged template;
- if `.claude/scripts/slack-reply.sh` exists, record whether it is current, a known safely migrated prior copy, or a preserved customized copy with a `.new` candidate;
- a customized or invalid canonical copy is a blocking `slack-relay-not-ready` outcome; a customized compatibility copy is visible degradation but does not override a healthy canonical copy;
- on a multi-machine agent, prove the Slack session is placed on the machine with the matching local-origin conversation entry and live adapter. An off-authority or owner-dark fixture must refuse rather than post from another machine.

## 5. Live smoke and cleanup

Run a bounded canary in this order:

1. Root outbound message through the real adapter route.
2. Replay the same delivery ID; require an idempotent response and no second Slack timestamp.
3. Threaded outbound reply under the root.
4. Authenticated human mention from a registered demo principal. A bot-authored event is not a substitute because the adapter correctly ignores bots.
5. Human thread reply; verify the thread routing key resumes the same thread session rather than the channel root.
6. Confirm observe-only decision evidence resolves the authenticated principal and does not enforce a refusal.
7. Delete agent-authored canary messages and record the outcome. Never claim deletion of human-authored messages without platform evidence.
8. Spawn a non-Claude-framework session from a directed human thread reply and have it answer through `.instar/scripts/slack-reply.sh` with no channel/thread arguments. Require exactly one adapter call in the source thread and zero channel-root calls. Repeat once after compaction/recovery to prove the binding and neutral path survive.

Record non-secret evidence: team/app/bot IDs, scope difference, channel membership, connection/self-verification lines, Slack timestamps, delivery dedupe verdict, session routing keys, permission-decision summary, and cleanup results.

## 6. Named refusal outcomes

- `identity-collision`: app or bot identity belongs to another agent.
- `workspace-mismatch`: `auth.test` resolves a different team.
- `scope-incomplete`: required-scope difference is non-empty.
- `not-invited`: bot lacks active membership in a canary channel.
- `socket-unavailable`: app token cannot open Socket Mode.
- `principal-unverifiable`: no authenticated human event is available; do not substitute bot traffic.

Every refusal is retryable after the named provisioning repair. None authorizes a partial config or a fabricated green cell.
