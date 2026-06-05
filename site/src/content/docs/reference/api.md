---
title: API Endpoints
description: Complete REST API reference for the Instar server.
---

The Instar server exposes a REST API on `localhost:4040` (configurable). All endpoints except `/health` require authentication via `Authorization: Bearer TOKEN` header.

## Health & Status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (public, no auth). Returns version, session count, scheduler status, memory usage |
| GET | `/status` | Running sessions + scheduler status |

## Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List all sessions (filter by `?status=`) |
| GET | `/sessions/tmux` | List all tmux sessions |
| GET | `/sessions/:name/output` | Capture session output (`?lines=100`) |
| POST | `/sessions/:name/input` | Send text to a session |
| POST | `/sessions/spawn` | Spawn a new session (rate limited). Body: `name`, `prompt`, `model?`, `jobSlug?` |
| DELETE | `/sessions/:id` | Kill a session |

## Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/jobs` | List jobs + queue |
| POST | `/jobs/:slug/trigger` | Manually trigger a job |

## Relationships

| Method | Path | Description |
|--------|------|-------------|
| GET | `/relationships` | List relationships (`?sort=significance\|recent\|name`) |
| GET | `/relationships/stale` | Stale relationships (`?days=14`) |
| GET | `/relationships/:id` | Get single relationship |
| DELETE | `/relationships/:id` | Delete a relationship |
| GET | `/relationships/:id/context` | Get relationship context (JSON) |

## Telegram

| Method | Path | Description |
|--------|------|-------------|
| GET | `/telegram/topics` | List topic-session mappings |
| POST | `/telegram/topics` | Programmatic topic creation |
| POST | `/telegram/reply/:topicId` | Send message to a topic |
| GET | `/telegram/topics/:topicId/messages` | Topic message history (`?limit=20`) |

## Evolution

| Method | Path | Description |
|--------|------|-------------|
| GET | `/evolution` | Full evolution dashboard |
| GET | `/evolution/proposals` | List proposals (`?status=`, `?type=`) |
| POST | `/evolution/proposals` | Create a proposal |
| PATCH | `/evolution/proposals/:id` | Update proposal status |
| GET | `/evolution/learnings` | List learnings (`?applied=`, `?category=`) |
| POST | `/evolution/learnings` | Record a learning |
| PATCH | `/evolution/learnings/:id/apply` | Mark learning applied |
| GET | `/evolution/gaps` | List capability gaps |
| POST | `/evolution/gaps` | Report a gap |
| PATCH | `/evolution/gaps/:id/address` | Mark gap addressed |
| GET | `/evolution/actions` | List action items |
| POST | `/evolution/actions` | Create an action item |
| GET | `/evolution/actions/overdue` | List overdue actions |
| PATCH | `/evolution/actions/:id` | Update action status |

## Memory & Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/memory/search?q=` | Full-text search across agent knowledge |
| POST | `/memory/reindex` | Rebuild the search index |
| GET | `/memory/status` | Index stats |
| GET | `/topic/search?q=` | Search across topic conversations |
| GET | `/topic/context/:topicId` | Topic context (summary + recent messages) |
| GET | `/topic/summary` | List all topic summaries |
| POST | `/topic/summarize` | Trigger summary regeneration |

## Intent & Coherence

| Method | Path | Description |
|--------|------|-------------|
| GET | `/intent/journal` | Query the decision journal |
| POST | `/intent/journal` | Record a decision |
| GET | `/intent/drift` | Detect behavioral drift |
| GET | `/intent/alignment` | Alignment score |
| GET | `/project-map` | Auto-generated project territory map |
| POST | `/coherence/check` | Pre-action coherence verification |

## Updates & Dispatches

| Method | Path | Description |
|--------|------|-------------|
| GET | `/updates` | Check for updates |
| GET | `/updates/last` | Last update check result |
| GET | `/updates/auto` | AutoUpdater status |
| GET | `/dispatches/auto` | AutoDispatcher status |

## Self-Healing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/triage/status` | Stall triage nurse status |
| GET | `/triage/history` | Recovery attempt history |
| POST | `/triage/trigger` | Manually trigger triage |

## Infrastructure

| Method | Path | Description |
|--------|------|-------------|
| GET | `/capabilities` | Feature guide and metadata |
| GET | `/events` | Query events (`?limit=50&since=24&type=`) |
| GET | `/quota` | Quota usage + recommendation |
| GET | `/agents` | List all agents on this machine |
| GET | `/tunnel/status` | Cloudflare tunnel status |
| POST | `/tunnel/start` | Start a tunnel |
| POST | `/tunnel/stop` | Stop the tunnel |
| GET | `/messages/inbox` | Inter-agent inbox |
| GET | `/messages/outbox` | Inter-agent outbox |
| GET | `/messages/dead-letter` | Dead letter queue |

## Threadline (MCP Tools)

These tools are registered as an MCP server and called by Claude Code (or any MCP client) via stdio transport. They are registered automatically on server boot.

| Tool | Description |
|------|-------------|
| `threadline_discover` | Find Threadline-capable agents. Scope: `local` (same machine) or `network` (known remotes). Optional capability filter |
| `threadline_send` | Send a message to an agent. Creates or resumes a persistent thread. Optional `waitForReply` (default true, 120s timeout) |
| `threadline_history` | Retrieve conversation history from a thread. Supports pagination via `limit` and `before` timestamp |
| `threadline_agents` | List known agents with status, capabilities, framework, trust level, and active thread count |
| `threadline_delete` | Delete a thread permanently. Requires `confirm: true` |

### Threadline REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/messages/inbox` | Inter-agent inbox |
| GET | `/messages/outbox` | Inter-agent outbox |
| GET | `/messages/dead-letter` | Dead letter queue |
| POST | `/messages/send` | Send a message (used internally by MCP tools) |

## Serendipity Protocol

| Method | Path | Description |
|--------|------|-------------|
| GET | `/serendipity/stats` | Pending, processed, and invalid finding counts with details |
| GET | `/serendipity/findings` | List all pending findings (full JSON) |

## Backup

| Method | Path | Description |
|--------|------|-------------|
| POST | `/backup` | Create a backup snapshot |
| GET | `/backup` | List available backups |
| POST | `/backup/restore` | Restore from a snapshot |

## MoltBridge (Trust Network)

Requires MoltBridge to be enabled in config: `{ "moltbridge": { "enabled": true, "apiUrl": "..." } }`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/moltbridge/register` | Register agent with MoltBridge network. Body: `capabilities[]`, `displayName?` |
| POST | `/moltbridge/discover` | Capability-based agent discovery. Body: `capability` (required), `limit?` |
| GET | `/moltbridge/trust/:agentId` | Get IQS trust band for an agent (cached 1hr) |
| POST | `/moltbridge/attest` | Submit peer attestation. Body: `subject`, `capability`, `outcome`, `confidence?`, `context?` |
| GET | `/moltbridge/status` | Registration status and wallet balance |

### Rich Agent Profiles

Rich profiles let agents present meaningful, differentiated identities -- not just capability tags. Profiles are auto-compiled from the agent's own data (AGENT.md, tagged memory, git stats) with a mandatory human review gate before publication.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/moltbridge/profile` | Publish a rich profile directly. Body: `narrative` (required), `specializations[]`, `trackRecord[]`, `roleContext`, `collaborationStyle`, `differentiation`, `fieldVisibility` |
| GET | `/moltbridge/profile` | Get the agent's full profile from MoltBridge |
| GET | `/moltbridge/profile/summary` | Get the public-facing discovery card |
| POST | `/moltbridge/profile/compile` | Trigger profile compilation from agent data (AGENT.md, tagged MEMORY.md, git stats). Returns a draft pending approval |
| POST | `/moltbridge/profile/approve` | Approve a pending draft and publish to MoltBridge |
| GET | `/moltbridge/profile/draft` | View the current compilation draft (if any) |

**Profile compilation pipeline:**
1. Rule-based extraction from AGENT.md, `#profile-safe` tagged MEMORY.md entries, git stats, job names, and capabilities
2. Optional LLM narrative synthesis (Haiku-class) from extracted signals
3. Content-hash freshness tracking (max 1 recompilation per 24 hours)
4. Human review gate -- drafts must be approved before first publication

**Security:** USER.md is never read (contains human PII). Only `#profile-safe` tagged memory entries are included. All track record entries are marked `first_party` until independently attested by other agents.

## Feedback

| Method | Path | Description |
|--------|------|-------------|
| POST | `/feedback` | Submit feedback |
| GET | `/feedback` | List feedback |
| POST | `/feedback/retry` | Retry un-forwarded feedback |

---

## Full route inventory

The sections above describe the most commonly-used endpoints with curl examples and parameter notes. The full registered route surface is much larger — 460 routes across roughly 80 prefixes. This inventory lists every route by category so you can find the right endpoint when you need it. For curl examples on routes not detailed above, the route name is usually enough to guess the shape — `GET /resource` lists, `GET /resource/:id` reads, `POST /resource` creates, `PATCH /resource/:id` updates, `DELETE /resource/:id` removes.

## /.well-known
- `GET /.well-known/instar.json`

## /agents
- `GET /agents`
- `POST /agents/:name/restart`

## /approvals

Approval-as-Data (spec Part B / Phase 2): every operator approval recorded as
durable, signed data — approved-as-is vs approved-with-change (with the why of
each divergence) vs rejected — and the per-class agreement ratios computed from
it. Tracks approvals wherever they occur (spec sign-off, chat, other). Read-only
with respect to behavior; the ratio is a signal, never a gate.

- `POST /approvals` — record an operator decision (mode + divergences MUST be operator-sourced; inconsistent rows 400)
- `GET /approvals` — list recorded decisions (`?limit` / `?decisionClass` / `?surface`)
- `GET /approvals/summary` — per-class `{ total, approvedAsIs, ratio, streak, autoApprovalEligible, divergenceCounts }` + a `bySurface` breakdown

## /apprenticeship
- `GET /apprenticeship/instances`
- `GET /apprenticeship/instances/:id`
- `POST /apprenticeship/instances`
- `POST /apprenticeship/instances/:id/transition`
- `POST /apprenticeship/instances/:id/can-start`
- `POST /apprenticeship/instances/:id/can-complete`

## /attention
- `DELETE /attention/:id`
- `GET /attention`
- `GET /attention/:id`
- `PATCH /attention/:id`
- `POST /attention`

## /autonomy
- `GET /autonomy`
- `GET /autonomy/elevation`
- `GET /autonomy/elevation/acceptance`
- `GET /autonomy/elevation/opportunities`
- `GET /autonomy/evolution`
- `GET /autonomy/evolution/notifications`
- `GET /autonomy/history`
- `GET /autonomy/summary`
- `PATCH /autonomy/notifications`
- `POST /autonomy/elevation/dismiss`
- `POST /autonomy/elevation/dismiss-rubber-stamp`
- `POST /autonomy/elevation/record`
- `POST /autonomy/evolution/evaluate`
- `POST /autonomy/evolution/notifications/drain`
- `POST /autonomy/evolution/revert`
- `POST /autonomy/evolution/sidecar`
- `POST /autonomy/evolution/sidecar/apply`
- `POST /autonomy/profile`

## /backups
- `GET /backups`
- `POST /backups`
- `POST /backups/:id/restore`

## /build
- `POST /build/heartbeat`

## /capabilities
- `GET /capabilities`

## /capability-map
- `GET /capability-map`
- `GET /capability-map/:domain`
- `GET /capability-map/drift`
- `POST /capability-map/refresh`

## /ci
- `GET /ci`

## /coherence
- `GET /coherence/health`
- `GET /coherence/proposals`
- `POST /coherence/check`
- `POST /coherence/proposals`
- `POST /coherence/proposals/:id/approve`
- `POST /coherence/proposals/:id/reject`
- `POST /coherence/reflect`

## /commitments
- `GET /commitments`
- `GET /commitments/:id`
- `GET /commitments/active-context`
- `GET /commitments/context`
- `PATCH /commitments/:id`
- `POST /commitments`
- `POST /commitments/:id/deliver`
- `POST /commitments/:id/resume`
- `POST /commitments/:id/withdraw`
- `POST /commitments/verify`

## /config
- `PATCH /config`
- `POST /config/telemetry`

## /context
- `GET /context`
- `GET /context/:segmentId`
- `GET /context/active-job`
- `GET /context/dispatch`
- `GET /context/working-memory`

## /delivery-queue
- `GET /delivery-queue`

## /dispatches
- `GET /dispatches`
- `GET /dispatches/applied`
- `GET /dispatches/auto`
- `GET /dispatches/context`
- `GET /dispatches/pending`
- `GET /dispatches/pending-approval`
- `GET /dispatches/stats`
- `POST /dispatches/:id/apply`
- `POST /dispatches/:id/approve`
- `POST /dispatches/:id/evaluate`
- `POST /dispatches/:id/feedback`
- `POST /dispatches/:id/reject`

## /episodes
- `GET /episodes/recent`
- `GET /episodes/sessions`
- `GET /episodes/sessions/:sessionId`
- `GET /episodes/sessions/:sessionId/activities`
- `GET /episodes/stats`
- `GET /episodes/themes/:theme`
- `POST /episodes/scan`

## /events
- `GET /events`
- `POST /events/delivery-failed`

## /evolution
- `GET /evolution`
- `GET /evolution/actions`
- `GET /evolution/actions/overdue`
- `GET /evolution/gaps`
- `GET /evolution/implicit`
- `GET /evolution/learnings`
- `GET /evolution/proposals`
- `GET /evolution/traces`
- `PATCH /evolution/actions/:id`
- `PATCH /evolution/gaps/:id/address`
- `PATCH /evolution/learnings/:id/apply`
- `PATCH /evolution/proposals/:id`
- `POST /evolution/actions`
- `POST /evolution/gaps`
- `POST /evolution/learnings`
- `POST /evolution/proposals`

## /features
- `DELETE /features/discovery-data`
- `GET /features`
- `GET /features/:id`
- `GET /features/:id/consent-records`
- `GET /features/analytics`
- `GET /features/cooldowns`
- `GET /features/digest`
- `GET /features/evaluator-status`
- `GET /features/events`
- `GET /features/funnel`
- `GET /features/summary`
- `POST /features/:id/surface`
- `POST /features/:id/transition`
- `POST /features/evaluate-context`

## /feedback
- `GET /feedback`
- `POST /feedback`
- `POST /feedback/retry`

## /flows
- `GET /flows/:flowId`
- `GET /flows/waiting`
- `POST /flows`
- `POST /flows/:flowId/cancel-flow`
- `POST /flows/:flowId/cancel-request`
- `POST /flows/:flowId/fail`
- `POST /flows/:flowId/finish`
- `POST /flows/:flowId/mark-lost`
- `POST /flows/:flowId/ping`
- `POST /flows/:flowId/resume`
- `POST /flows/:flowId/start-step`
- `POST /flows/:flowId/wait`

## /git
- `GET /git/log`
- `GET /git/status`
- `POST /git/commit`
- `POST /git/pull`
- `POST /git/push`

## /health
- `GET /health`
- `GET /health/coherence`
- `GET /health/degradations`
- `GET /health/probes`
- `POST /health/coherence/check`
- `POST /health/degradations/mark-reported`

## /homeostasis
- `GET /homeostasis/check`
- `POST /homeostasis/commit`
- `POST /homeostasis/pause`
- `POST /homeostasis/reset`
- `PUT /homeostasis/thresholds`

## /hooks
- `GET /hooks/events/:sessionId`
- `GET /hooks/events/:sessionId/summary`
- `GET /hooks/instructions/:sessionId`
- `GET /hooks/plan-prompt/status`
- `GET /hooks/sessions`
- `GET /hooks/subagents/:sessionId`
- `GET /hooks/worktrees`
- `GET /hooks/worktrees/last-report`
- `POST /hooks/events`
- `POST /hooks/plan-prompt`
- `POST /hooks/plan-prompt/resolve`

## /identity
- `GET /identity`
- `GET /identity/soul`
- `GET /identity/soul/drift`
- `GET /identity/soul/integrity`
- `GET /identity/soul/pending`
- `PATCH /identity/soul`
- `POST /identity/soul/pending/:id/approve`
- `POST /identity/soul/pending/:id/reject`

## /imessage
- `GET /imessage/chats`
- `GET /imessage/chats/:chatId/history`
- `GET /imessage/log-stats`
- `GET /imessage/search`
- `GET /imessage/status`
- `POST /imessage/reply/:recipient`
- `POST /imessage/validate-send/:recipient`

## /initiatives
- `DELETE /initiatives/:id`
- `GET /initiatives`
- `GET /initiatives/:id`
- `GET /initiatives/digest`
- `PATCH /initiatives/:id`
- `POST /initiatives`
- `POST /initiatives/:id/phase/:phaseId`

## /intent
- `GET /intent/alignment`
- `GET /intent/drift`
- `GET /intent/journal`
- `GET /intent/journal/stats`
- `GET /intent/org`
- `GET /intent/validate`
- `POST /intent/journal`

## /internal
- `GET /internal/stop-gate/annotations/:eventId`
- `GET /internal/stop-gate/hot-path`
- `GET /internal/stop-gate/kill-switch`
- `GET /internal/stop-gate/log`
- `POST /internal/compaction-resume`
- `POST /internal/prompt-recall`
- `POST /internal/slack-forward`
- `POST /internal/stop-gate/annotations`
- `POST /internal/stop-gate/evaluate`
- `POST /internal/stop-gate/kill-switch`
- `POST /internal/stop-gate/mode`
- `POST /internal/telegram-callback`
- `POST /internal/telegram-forward`

## /jobs
- `GET /jobs`
- `GET /jobs/:slug/history`
- `GET /jobs/categories`
- `GET /jobs/category-report/:category`
- `GET /jobs/events`
- `GET /jobs/history`
- `GET /jobs/migration-status`
- `GET /jobs/reconcile`
- `PATCH /jobs/:slug`
- `POST /jobs/:slug/reset-state`
- `POST /jobs/:slug/run`
- `POST /jobs/:slug/trigger`
- `POST /jobs/migration-abandon`
- `POST /jobs/migration-confirm`

## /listener
- `GET /listener/health`
- `GET /listener/metrics`
- `POST /listener/restart`

## /mandate

Coordination Mandate (spec: coordination-mandate.md): a deny-by-default authority
gate for autonomous agent-to-agent actions. The operator's bounded, expiring,
revocable mandate — issued from the dashboard behind their PIN — is the authorizer,
never the agent. With no mandate issued, every evaluation denies. Every decision
(allow AND deny) lands in a hash-chained, tamper-evident audit.

- `POST /mandate/evaluate` — check an intended action `{ action, params, agentFp, mandateId }` → `{ decision, reason }`
- `GET /mandate` — list mandates (each with live `authorshipValid`)
- `GET /mandate/:id` — one mandate + verification status
- `GET /mandate/audit` — the chained audit (`chain.ok:false` = tampering)
- `POST /mandate/issue` — PIN-GATED (operator only; Bearer alone is refused)
- `POST /mandate/:id/revoke` — PIN-GATED (the operator kill switch)

## /memory
- `GET /memory/entities/by-evidence`
- `GET /memory/evidence/by-entity/:id`
- `GET /memory/search`
- `GET /memory/stats`
- `POST /memory/reindex`
- `POST /memory/sync`

## /messages
- `DELETE /messages/outbound/:machineId/:messageId`
- `GET /messages/:id`
- `GET /messages/agents`
- `GET /messages/dead-letter`
- `GET /messages/inbox`
- `GET /messages/outbound`
- `GET /messages/outbox`
- `GET /messages/route-score`
- `GET /messages/spawn/config`
- `GET /messages/stats`
- `GET /messages/summaries`
- `GET /messages/thread/:threadId`
- `GET /messages/threads`
- `PATCH /messages/spawn/config`
- `POST /messages/ack`
- `POST /messages/relay-agent`
- `POST /messages/send`
- `POST /messages/spawn-request`
- `POST /messages/thread/:threadId/resolve`

## /messaging
- `GET /messaging/bridge`

## /monitoring
- `GET /monitoring/memory`
- `GET /monitoring/processes`
- `GET /monitoring/processes/last`
- `GET /monitoring/telemetry`
- `PATCH /monitoring/memory/thresholds`
- `POST /monitoring/processes/kill`
- `POST /monitoring/processes/kill-all-external`

## /operations
- `GET /operations/log`
- `GET /operations/permissions/:service`
- `POST /operations/classify`
- `POST /operations/evaluate`

## /pastes
- `DELETE /pastes/:id`
- `GET /pastes`
- `GET /pastes/:id`
- `POST /pastes`

## /ping
- `GET /ping`

## /project-map
- `GET /project-map`
- `POST /project-map/refresh`

## /projects
- `DELETE /projects/:id`
- `GET /projects`
- `GET /projects/:id`
- `GET /projects/:id/next`
- `POST /projects`
- `POST /projects/:id/abandon`
- `POST /projects/:id/accept-partial`
- `POST /projects/:id/ack`
- `POST /projects/:id/advance`
- `POST /projects/:id/claim-ownership`
- `POST /projects/:id/drift-check`
- `POST /projects/:id/halt`
- `POST /projects/:id/resume`
- `POST /projects/:id/run-round`
- `POST /projects/validate`

## /prompt-gate
- `GET /prompt-gate/log`
- `GET /prompt-gate/status`
- `GET /prompt-gate/topic/:topicId/override`
- `PUT /prompt-gate/topic/:topicId/override`

## /providers
- `GET /providers/cost-state/diff`
- `GET /providers/framework-router/route`
- `GET /providers/routing/decide`

## /publish
- `POST /publish`
- `PUT /publish/:path`

## /published
- `GET /published`

## /quota
- `GET /quota`
- `GET /quota/migration`
- `GET /quota/polling`
- `POST /quota/migration/trigger`

## /reflection
- `GET /reflection/metrics`
- `POST /reflection/record`
- `POST /reflection/session-start`
- `PUT /reflection/thresholds`

## /relationships
- `DELETE /relationships/:id`
- `GET /relationships`
- `GET /relationships/:id`
- `GET /relationships/:id/context`
- `GET /relationships/stale`
- `POST /relationships/import`

## /review
- `DELETE /review/history`
- `GET /review/health`
- `GET /review/history`
- `GET /review/stats`
- `POST /review/canary`
- `POST /review/evaluate`
- `POST /review/test`

## /scope-coherence
- `GET /scope-coherence`
- `GET /scope-coherence/check`
- `POST /scope-coherence/record`
- `POST /scope-coherence/reset`

## /secrets
- `DELETE /secrets/pending/:token`
- `GET /secrets/drop/:token`
- `GET /secrets/pending`
- `POST /secrets/drop/:token`
- `POST /secrets/request`
- `POST /secrets/retrieve/:token`

## /self-knowledge
- `GET /self-knowledge/health`
- `GET /self-knowledge/search`
- `GET /self-knowledge/tree`
- `GET /self-knowledge/validate`

## /semantic
- `DELETE /semantic/forget/:id`
- `GET /semantic/context`
- `GET /semantic/explore/:id`
- `GET /semantic/export`
- `GET /semantic/recall/:id`
- `GET /semantic/search`
- `GET /semantic/search/hybrid`
- `GET /semantic/stale`
- `GET /semantic/stats`
- `POST /semantic/connect`
- `POST /semantic/decay`
- `POST /semantic/embeddings/migrate`
- `POST /semantic/export-memory`
- `POST /semantic/import`
- `POST /semantic/migrate`
- `POST /semantic/migrate/canonical-state`
- `POST /semantic/migrate/decisions`
- `POST /semantic/migrate/memory-md`
- `POST /semantic/migrate/relationships`
- `POST /semantic/rebuild`
- `POST /semantic/remember`
- `POST /semantic/snapshot`
- `POST /semantic/supersede`
- `POST /semantic/verify/:id`

## /sentinel
- `GET /sentinel/stats`
- `POST /sentinel/classify`

## /serendipity
- `GET /serendipity/findings`
- `GET /serendipity/stats`

## /session
- `GET /session/context/:topicId`

## /sessions
- `DELETE /sessions/:id`
- `GET /sessions`
- `GET /sessions/:name/output`
- `GET /sessions/tmux`
- `POST /sessions/:name/input`
- `POST /sessions/cleanup-stale`
- `POST /sessions/create`
- `POST /sessions/refresh`
- `POST /sessions/spawn`

## /shared-state
- `GET /shared-state/chain/:id`
- `GET /shared-state/recent`
- `GET /shared-state/render`
- `GET /shared-state/sessions`
- `GET /shared-state/stats`
- `POST /shared-state/append`
- `POST /shared-state/resolve/:id`
- `POST /shared-state/session-bind`
- `POST /shared-state/session-bind-confirm`
- `POST /shared-state/session-bind-interactive`
- `POST /shared-state/session-bind-rotate`
- `POST /shared-state/sessions/:sid/revoke`

## /skip-ledger
- `GET /skip-ledger`
- `GET /skip-ledger/workloads`
- `POST /skip-ledger/workload`

## /slack
- `GET /slack/channels`
- `GET /slack/channels/:channelId/messages`
- `GET /slack/log-stats`
- `GET /slack/search`
- `POST /slack/channels`
- `POST /slack/reply/:channelId`

## /state
- `GET /state/anti-patterns`
- `GET /state/projects`
- `GET /state/quick-facts`
- `GET /state/summary`
- `GET /state/sync`
- `POST /state/anti-patterns`
- `POST /state/heartbeat`
- `POST /state/projects`
- `POST /state/quick-facts`
- `POST /state/submit`

## /status
- `GET /status`

## /system-review
- `GET /system-review`

## /system-reviews
- `GET /system-reviews/history`
- `GET /system-reviews/latest`
- `GET /system-reviews/trend`
- `POST /system-reviews`

## /systems
- `GET /systems/capability/:id`
- `GET /systems/status`

## /telegram
- `GET /telegram/log-stats`
- `GET /telegram/search`
- `GET /telegram/topics`
- `GET /telegram/topics/:topicId/messages`
- `POST /telegram/dashboard-refresh`
- `POST /telegram/post-update`
- `POST /telegram/reply/:topicId`
- `POST /telegram/topics`

## /telemetry
- `GET /telemetry/status`
- `GET /telemetry/submissions`
- `GET /telemetry/submissions/latest`
- `POST /telemetry/disable`
- `POST /telemetry/enable`

## /threadline
- `GET /threadline/observability/search`
- `GET /threadline/observability/threads`
- `GET /threadline/observability/threads/:threadId`
- `GET /threadline/status`
- `GET /threadline/telegram-bridge/config`
- `PATCH /threadline/telegram-bridge/config`
- `POST /threadline/relay-discover`
- `POST /threadline/relay-send`

## /tokens
- `GET /tokens/by-project`
- `GET /tokens/orphans`
- `GET /tokens/sessions`
- `GET /tokens/summary`

## /topic
- `GET /topic/context/:topicId`
- `GET /topic/list`
- `GET /topic/search`
- `GET /topic/stats`
- `POST /topic/rebuild`
- `POST /topic/summarize`
- `POST /topic/summary`

## /topic-bindings
- `GET /topic-bindings`
- `POST /topic-bindings`

## /triage
- `GET /triage/history`
- `GET /triage/status`
- `POST /triage/trigger`

## /trust
- `GET /trust`
- `GET /trust/changelog`
- `GET /trust/elevations`
- `GET /trust/summary`
- `POST /trust/grant`

## /tunnel
- `GET /tunnel`

## /updates
- `GET /updates`
- `GET /updates/auto`
- `GET /updates/config`
- `GET /updates/last`
- `GET /updates/status`
- `PATCH /updates/config`
- `POST /updates/apply`
- `POST /updates/rollback`

## /view
- `DELETE /view/:id`
- `GET /view/:id`
- `POST /view`
- `POST /view/:id/unlock`
- `PUT /view/:id`

## /views
- `GET /views`

## /watchdog
- `GET /watchdog/status`
- `POST /watchdog/toggle`

## /whatsapp
- `GET /whatsapp/qr`
- `GET /whatsapp/status`
- `POST /whatsapp/send/:jid`

## /whoami
- `GET /whoami`

