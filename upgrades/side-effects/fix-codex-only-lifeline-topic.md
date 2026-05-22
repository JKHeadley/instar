# Side-effects review — Codex creates only Lifeline

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: OVER-creation. The Codex flow created all 4 system topics
AND the server created 3 of them on boot, yielding duplicate
Dashboard (and latent duplicate risk for Updates/Attention).

After: precisely scoped. Codex creates only Lifeline (which the
server reuses by persisted ID). Server creates the other 3.
Single creator per topic. No duplicates.

## 2. Level-of-abstraction fit

Prompt-content change only — steps 13 + 14 of
`buildTelegramAgenticPrompt`. No new functions, no signature
change, no server-side change. Follows the existing ownership
boundary (server owns Dashboard/Updates/Attention; Lifeline is
shared via `config.lifelineTopicId`).

## 3. Signal vs Authority compliance

- The server's `ensureDashboardTopic` / `ensureAgentUpdatesTopic`
  / `ensureAgentAttentionTopic` remain the single AUTHORITY for
  those three topics.
- `config.lifelineTopicId` remains the coordination AUTHORITY
  between the Codex flow and the server's `ensureLifelineTopic`.
- The Codex flow no longer emits create-SIGNALS for the three
  server-owned topics.

## 4. Interactions with adjacent systems

- **Server `ensureDashboardTopic` / `ensureAgentUpdatesTopic` /
  `ensureAgentAttentionTopic`**: unchanged. They now run without
  a Codex-created duplicate to collide with.
- **Server `ensureLifelineTopic`**: unchanged. Still reuses
  `config.lifelineTopicId` written by the Codex flow.
- **`runSendLifelineGreeting`** (post-server greeting): unchanged.
  Still reads `lifelineTopicId` from config and posts the
  agent's first hello.
- **`broadcastDashboardUrl`**: unchanged. Posts the dashboard
  link to `config.dashboardTopicId` (set by the server's
  `ensureDashboardTopic`) once a tunnel is up.
- **Tests**: one test rewritten (was "creates the 4 canonical
  system topics" → now "creates ONLY the Lifeline topic"); the
  other 80 wizard tests unchanged.

## 5. Rollback cost

Trivial. Prompt-content change in two steps. `git revert`
restores the 4-topic creation (and the duplicate).

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Existing agents already set up: unaffected — their topics
  already exist; the server's ensure functions are idempotent on
  their stored IDs.
- New Codex installs: get exactly 4 topics, one creator each, no
  duplicates.
- Claude wizard path: untouched.
- No config schema change. No agent-installed-files change.

Drift surface reduced: the Codex prompt no longer hard-codes the
Dashboard/Updates/Attention names + colors, so it can't drift
from the server's TOPIC_STYLE constants. Only Lifeline's color
(9367192) remains in the prompt, matching SYSTEM.

## 7. Authorization / Trust posture

No change. Same Codex spawn flags, same Bot API access.

## Outcome

Ship. Closes the duplicate-Dashboard bug by restoring the natural
ownership boundary: server owns its three system topics; Codex
owns only Lifeline (the shared coordination point). The
no-dashboard-link issue is separate (Cloudflare rate-limit) and
addressed by two tracked follow-ups (tunnel-failure user
notification + backup tunnel pool).
