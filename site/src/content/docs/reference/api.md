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
| GET | `/orphaned-work` | Worktrees holding uncommitted work whose owning session died (the `OrphanedWorkSentinel` findings). 503 when the feature is dark, 200 when live |

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

## EXO 3.0 Governance

The endpoints behind the [EXO 3.0 Alignment](/features/exo3/) capabilities. See the [Meridian](/features/exo3-case-study-meridian/) and [Ironwood](/features/exo3-case-study-ironwood/) case studies for the controlled proof.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/intent/org/test-action` | Run the refusal + endorsement tests on a proposed action against the org intent |
| POST | `/intent/tradeoff-resolve` | Resolve a value tradeoff via the org's tradeoff hierarchy |
| GET | `/passport` | The agent's digital passport (identity, trust level, forbidden actions) |
| POST | `/passport/verify` | Verify a peer's proposed action against its passport |
| POST | `/agent-readiness/score` | Score a task or workflow on its coordination-vs-judgment ratio |
| GET | `/metrics/learning-velocity` | Learning-velocity metric (the EXO 3.0 KPI inversion) |

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
- `POST /attention/:id/remote-ack` — durable operator-bound ack for a pooled attention item owned by ANOTHER machine (WS4.1 follow-up). Delivers immediately when the owner is reachable, else persists the intent (bound to the authenticated operator) and re-delivers when the owner returns; the owner revalidates at apply time and rejects a stale resolve against a since-escalated HIGH/URGENT item. Ships dark behind `multiMachine.seamlessness.ws41DurableAck`.
- `GET /attention/_remote-ack/pending` — list still-pending durable remote-acks (observability).
- `POST /attention/_remote-ack/drain` — manually drain pending durable remote-acks to their owning machines.

## /autonomous
- `POST /autonomous/register` — server-side start snapshot for an autonomous run (scope-accretion R30): the server mints the runId, snapshots the `scopeAccretion` config + sweep base-root start-SHAs, and clamps `endAt` to `now + maxDurationMs`. One registration per active run (409 while the existing record is active).
- `POST /autonomous/:topic/run-end` — every exit surface reports here (scope-accretion R44): runs the non-blocking advisory sweep and enumerates any unbuilt accreted work loudly; marks the run record ended.
- `POST /autonomous/:topic/ratify-deferral` — dashboard-PIN-gated operator ratification of deferred accreted artifacts (`{"artifacts": [...]}` or `{"all": true}`; the response echoes exactly what was ratified).
- `POST /autonomous/:topic/scope-accretion-override` — dashboard-PIN-gated live mid-run lever (`{"enabled": false, "reason": "…"}`): overrides the registration-time snapshot for the running session; audited.

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

## /cutover-readiness

Cutover-READINESS (coordination-mandate spec §7 G2.4, decision 1A): everything UP
TO the cutover door, never the door. The two objective conditions resolve from
REAL durable state — the persisted import IntegrityReport and the durable
zero-divergence parity window (with a readiness-layer freshness bound). The flip
itself is the operator's manual click; there is no fire-cutover route by design.

- `GET /cutover-readiness` — `{ ready, door: "manual-operator-click", integrity, parity, importDryRun }` (read-only)
- `POST /cutover-readiness/parity-pass` — trigger a server-side live parity check; the request contributes nothing to the result; a failed check records nothing
- `POST /cutover-readiness/import-dryrun` — trigger a server-side import REHEARSAL (live source fetch → AS-IS import into an in-memory target → integrity gate over what the target reads back); zero durable data writes; persists to a separate dry-run report and never greens the canonical integrity condition
- `GET /cutover-readiness/import-dryrun` — the last rehearsal's verdict (read-only, informational — not a `ready` input)

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

## /pool
- `GET /pool` — the machine pool: router, nicknames, hardware, online status, load, quota state
- `GET /pool/placement` — which machine owns a topic + the reason (`pinned`/`placed`/`unowned`) + the U4.1 verified pin state (`pinState`: `actuated`/`pending`/`diverged`/`suspended-pending-owner-return`, `pinHeldSince`, `pendingReason`, `pinnedBy`)
- `POST /pool/transfer` — deterministic topic move to a nickname/machineId (the validated planner)
- `POST /pool/unpin` — deliberately clear a topic's placement pin; the clear replicates as a tombstone so a stale copy can never re-pin it (U4.1)
- `GET /pool/pin-quarantine` — the sticky skew-quarantine set (clock-skewed pin records excluded from pin resolution) + fold status (503 when pin replication is dark)
- `POST /pool/pin-quarantine/readmit` — the deliberate, explicit per-record re-admission of a quarantined pin record (dismissing the alert never re-admits)
- `GET /pool/queue` — durable inbound-queue counts + hold/flap state (503 while dark)
- `GET /pool/reconciler` — WS1.3 ownership reconciler status (+ `?topic=N` per-topic explain)
- `GET /pool/stale-owner-release` — U4.2 stale-owner release telemetry: attempts, would-claims (dry-run), refusals by reason, evidence classes, P19 give-ups, probe-breaker state, open episodes (503 when dark; see [Multi-machine](/features/multi-machine/))
- `GET /pool/lease-handback` — U4.4 lease hand-back reconciler status: state, hysteresis window, operator-latch visibility, last episode, counters (503 when the mesh is dark)
- `POST /pool/lease-handback/latch` — write the operator-flip latch marker (the captain-flip playbook's POST step; suppresses automated hand-back — the human always wins)
- `DELETE /pool/lease-handback/latch` — clear the latch early (PIN-gated: re-enables automation against a human decision, so the dashboard PIN is required)
- `GET /pool/poll-cache` — the shared per-peer pool-scope poll cache (WS4.4(f))
- `GET /pool/duplicate-reconciler` — ownership-gated-spawn unified status: duplicate-reconciler posture + substrate readiness, owner-dark notice episodes, spawn-admission counters, breaker state, audit-log locations (503 while dark; see [Ownership-Gated Spawn](/features/ownership-gated-spawn/))
- `GET /pool/ownership-view?key=<topic>` — THIS machine's own ownership record for a conversation (proxy-free; the reconciler's peer-echo verification read)
- `GET /judgment-provenance` — redacted judgment-provenance decision rows (`?limit=`, `?sinceHours=`, `?scope=pool` merges peers' redacted rows as clamped untrusted data; full context never leaves the deciding machine)

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

## /review-exchange

ReviewExchange (coordination-mandate spec §7 G2.3): one mutual, mandate-gated
sign-off of a review artifact between the two agents named in a mandate. Both
sign-offs run through the mandate gate's `sign-code-review` authority; every
accepted signature carries the audit hash of the gate decision that authorized
it. Linear lifecycle: proposed → delivered → verdict-recorded → complete (or
changes-requested, terminal). Deny-by-default inherited: no mandate → 403.

- `POST /review-exchange` — create `{ mandateId, artifact, packageRef, packageSha256, parties:[ownerFp,peerFp] }` (content-addressed)
- `GET /review-exchange` — list exchanges
- `GET /review-exchange/:id` — one exchange + signatures with audit hashes
- `POST /review-exchange/:id/delivered` — record the Threadline delivery evidence
- `POST /review-exchange/:id/peer-verdict` — the peer's authenticated verdict; `approve` is their sign-off → mandate-gated (deny → 403)
- `POST /review-exchange/:id/sign` — the owner's countersignature → mandate-gated; completes the exchange

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
- `GET /self-knowledge/session-context` — the boot self-knowledge block: vault secret NAMES (never values) + operational facts; `?full=1` bypasses display caps. Dark on the fleet (`enabled ?? developmentAgent`).
- `GET /self-knowledge/tree`
- `GET /self-knowledge/validate`
- `POST /self-knowledge/facts` — append a durable operational fact (auto-stamped with date + machine)
- `DELETE /self-knowledge/facts` — remove a fact by `{match}` or `{index, expect}`

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
- `POST /sessions/:name/remote-close`
- `POST /sessions/cleanup-stale`
- `POST /sessions/create`
- `POST /sessions/refresh`
- `GET /sessions/resume-queue`
- `POST /sessions/resume-queue/:id/cancel`
- `POST /sessions/resume-queue/:id/requeue`
- `POST /sessions/resume-queue/drain`
- `POST /sessions/resume-queue/resume`
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

## /topic-operator
Verified per-topic operator binding (Know Your Principal). The operator is established ONLY from the authenticated sender `uid` — a content name can never become the operator. See [Know Your Principal](/concepts/know-your-principal/).
- `POST /topic-operator` — bind a topic operator from the AUTHENTICATED sender `{ topicId, platform?, uid (required), displayName? }`; a blank uid is refused `400`
- `GET /topic-operator` — all bound operators (names + uids)
- `GET /topic-operator/:topicId` — one topic's verified operator (or `null` when unbound)
- `GET /topic-operator/session-context?topicId=N` — the `<topic-operator>` session-start injection block (`{ present:false }` when unbound)

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

## /subscription-pool

Multi-account subscription registry + per-account quota (the Subscription & Auth
Standard). The registry stores each account's login *location* (its config home),
never tokens. These routes are **operator/internal** and ship dark — they do
nothing until accounts are enrolled, and are not surfaced in `/capabilities`
until the standard's later phases (scheduler + enrollment wizard) make them
user-usable.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/subscription-pool` | List enrolled accounts (nickname, provider, framework, config home, status, last quota) |
| POST | `/subscription-pool` | Add an account. Body: `id`, `nickname`, `provider`, `framework`, `configHome` |
| GET | `/subscription-pool/:id` | Get one account |
| PATCH | `/subscription-pool/:id` | Update mutable fields (nickname, framework, configHome, status) |
| DELETE | `/subscription-pool/:id` | Remove an account |
| POST | `/subscription-pool/poll` | Poll every account's live quota now (writes each account's `lastQuota`) |
| GET | `/subscription-pool/:id/quota` | Read an account's latest quota snapshot + measured burn rate |
| POST | `/subscription-pool/swap` | Resume a session on another eligible account (continuity guarantee — never dies on a quota limit). Body: `sessionName`, `exhaustedAccountId` |
| GET | `/subscription-pool/proactive-swap` | Pre-limit swap monitor status — `thresholdPct`, `watchPct`, `maxSwapsPerCycle`, `cooldownMs`, `running`, `lastResult`. `200 { enabled:false }` when the monitor is dark. |
| POST | `/subscription-pool/proactive-swap/check` | Run one proactive pass now (refresh the poll if near the wall, then pre-emptively swap at-pressure sessions). The deterministic "show me it works" lever. |
| POST | `/subscription-pool/enroll` | Start a mobile-first new-account login. Body: `id`, `label`, `provider`, `framework`, optional `kind`, `configHome`. Returns the pending login (public code/URL + TTL — never a token). |
| GET | `/subscription-pool/pending-logins` | The "Pending Logins" surface — active logins awaiting approval (code/URL + TTL). |
| POST | `/subscription-pool/enroll/:id/cancel` | Safely abandon a pending or expired login and best-effort stop its waiting login pane. Completed/already-abandoned logins return idempotently; an in-flight completion returns `409`. |
| POST | `/subscription-pool/enroll/:id/complete` | Mark a login completed once the operator approved + the account enrolled. |
| POST | `/subscription-pool/enroll/reissue-expired` | Sweep + auto-reissue every expired login with a fresh code/URL (the background tick calls the same path). |
| GET | `/subscription-pool/in-use` | Which pooled accounts are currently serving a live session. |

### Account follow-me / account×machine matrix (WS5.2)

Cross-machine account setup from the dashboard's Subscriptions-tab grid. Dark behind `multiMachine.accountFollowMe`. Each machine re-mints its OWN login (no token is copied between machines).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/subscription-pool/matrix/start-cell` | PIN-gated orchestrator: the grid's "Set up" tap. Issues the per-(account, targetMachine) `account-follow-me` mandate, then drives the enroll/start chain (self → loopback; peer → deliver the signed mandate + remote enroll). Body: `accountId`, `machineId`, `pin`. |
| POST | `/subscription-pool/follow-me/enroll/start` | Mandate-gated: re-mint the login on THIS target machine (Mechanism B). Spawns the waiting `claude auth login` pane + records a pending login. Body: `mandateId`, `accountId`. |
| POST | `/subscription-pool/follow-me/enroll/:id/submit-code` | Target-local: type the operator's verification code into the waiting login pane, then drive to a real outcome (S7 email-gate complete → add to pool). |
| POST | `/subscription-pool/follow-me/submit-code` | Fronting relay for the above — the operator's single dashboard hop; self → loopback, peer → forward. Body: `machineId`, `id`, `code`. |
| POST | `/subscription-pool/follow-me/enroll/:id/cancel` | Target-local: cancel a mis-tapped in-flight cell — abandon the pending login + tear down its login pane (raw `tmux kill-session`). Idempotent on a terminal record (200 `alreadyTerminal`); unknown/malformed id → 404; stands aside (409) while a code is mid-submit. Bearer-only. |
| POST | `/subscription-pool/follow-me/cancel` | Fronting relay for cancel — dispatches to self/peer by `machineId` (offline peer → 502). The route the dashboard Cancel button calls. Body: `machineId`, `id`. |
| POST | `/subscription-pool/follow-me/enroll/:id/complete` | Mark a follow-me login completed once the freshly-minted account passes the S7 email-gate. |

The quota-aware scheduler picks accounts reset-date-optimally ("use before reset")
and guarantees a long-lived session that hits its account's quota resumes on
another account (via `claude --resume`, which is account-agnostic, so the
conversation is preserved) rather than dying. There are two automatic swap
triggers, both dark by default in `.instar/config.json`: the **reactive** swap
(`subscriptionPool.autoSwapOnRateLimit`) fires AFTER a rate-limit escalation, and
the **proactive** pre-limit swap (`subscriptionPool.proactiveSwap.enabled`) moves a
session OFF an account BEFORE it walls, at a lag-aware measured `thresholdPct`
(default 80 — below the real limit because the polled reading trails real usage).
The proactive monitor resolves an UNTAGGED session's effective account from the
default-config login, so the primary interactive session is swap-visible instead
of wedging at the wall. The `/subscription-pool/swap` route is the manual lever;
`/subscription-pool/proactive-swap/check` runs one proactive pass on demand.

These routes are backed by three core classes: `SubscriptionPool` (the durable
account registry — login location only, never tokens), `QuotaPoller` (the
background poller that measures each account's live burn + reset windows), and
`QuotaAwareScheduler` (reset-date-optimal account selection + the swap continuity
guarantee). The swap itself drives `SessionRefresh` with an account-swap option so
the resumed session launches under the new account's `CLAUDE_CONFIG_DIR`.

The enrollment routes are backed by `PendingLoginStore` (a durable ledger of
in-flight logins — public code/URL/TTL only, never a token), `EnrollmentWizard`
(start a login + auto-reissue expired codes on a background sweep), and
`FrameworkLoginDriver` (spawns the framework's own login under the new account's
`CLAUDE_CONFIG_DIR` and scrapes the public code/URL). Enrollment ships dark — the
routes answer `200 { enabled:false }` until the wizard is wired.

Examples:

```bash
# List accounts and add one (login location only — never tokens)
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool \
  -d '{"id":"claude-personal","nickname":"personal","provider":"anthropic","framework":"claude-code","configHome":"~/.claude-personal"}'

# Inspect, update, remove a specific account
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/claude-personal
curl -X PATCH -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/claude-personal -d '{"nickname":"personal-max"}'
curl -X DELETE -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/claude-personal

# Refresh live quota for all accounts, then read one account's snapshot + burn rate
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/poll
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/claude-personal/quota

# Manually swap a session off a quota-exhausted account (continuity preserved)
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/swap \
  -d '{"sessionName":"my-session","exhaustedAccountId":"claude-personal"}'

# Proactive pre-limit swap: check status, then run one pass on demand
curl -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/proactive-swap
curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/subscription-pool/proactive-swap/check
```

## /views
- `GET /views`

## /watchdog
- `GET /watchdog/status`
- `POST /watchdog/toggle`

## /whatsapp
- `GET /whatsapp/qr`
- `GET /whatsapp/status`
- `POST /whatsapp/send/:jid`

## /permissions

The Slack org permission gate (dark/observe-only by default — these routes are operator/internal, not surfaced in `/capabilities` until the enforce path is enabled in a later phase).

- `GET /permissions/decisions` — recent permission-gate verdicts from the observe ledger (operator review).
- `GET /permissions/scenario-suite` — the worked-example verdict suite (deploy-allow, junior-deny, ambiguous-clarify, social-engineering-deny, compromised-CEO step-up) with expected vs actual verdicts.
- `GET /permissions/registrations/pending` — list pending self-registration requests awaiting admin approval.
- `POST /permissions/registrations/register` — admin registers a Slack user with an org role (`{ slackUserId, displayName, role }`).
- `POST /permissions/registrations/approve` — approve a pending registration (`{ slackUserId, role }`).
- `POST /permissions/registrations/deny` — deny/drop a pending registration (`{ slackUserId }`).

## /whoami
- `GET /whoami`
