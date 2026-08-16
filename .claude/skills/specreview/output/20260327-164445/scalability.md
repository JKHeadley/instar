# Scalability & Infrastructure Review — Slack Adapter Spec
**Review ID**: 20260327-164445
**Reviewer Role**: Scalability & Infrastructure Specialist
**Spec**: SLACK-ADAPTER-SPEC.md
**Date**: 2026-03-27
**Round**: 1

---

## Approval Status

**CONDITIONAL APPROVE** — The spec is architecturally sound for its intended single-agent, DIY use case. However, several scalability assumptions are either unstated or incorrect, and one recently-changed Slack API constraint (the 2025 non-Marketplace rate limit change) is not addressed and will directly break the channel history hook on first deployment if the app classification is misunderstood.

---

## Research Findings

### Slack API Rate Limit Tiers (as of 2025-2026)

Slack assigns every Web API method to one of four tiers:

| Tier | Rate | Example Methods |
|------|------|-----------------|
| Tier 1 | ~1 req/min | `conversations.history`, `conversations.replies` (non-Marketplace apps, post May 2025) |
| Tier 2 | ~20 req/min | `files.upload`, `users.list`, `conversations.create` |
| Tier 3 | 50+ req/min | `chat.postMessage` (per-channel), `apps.connections.open`, `reactions.add` |
| Tier 4 | 100+ req/min | `chat.postEphemeral`, `auth.test` |

**Critical 2025 change (May 29, 2025)**: Slack introduced severe rate limits for non-Marketplace apps on `conversations.history` and `conversations.replies`: **1 request per minute, max 15 messages per request**. This applies to commercially-distributed unlisted apps. **Custom/internal apps are explicitly exempt** — they retain 50+ req/min. The Instar DIY model creates internal/custom apps per workspace, so the exemption should apply — but the spec does not acknowledge this distinction, leaving ambiguity.

**Additional constraint**: Even for exempt apps, `chat.postMessage` is limited to ~1 message per second *per channel*, with burst tolerance. Sustained rapid sends to a single channel will hit this ceiling.

### Socket Mode Connection Limits

- Maximum **10 concurrent WebSocket connections per app** (not per workspace, per app installation)
- WebSocket URL is ephemeral — rotates on a schedule; the `approximate_connection_time` field in the connection response indicates expected lifetime
- `apps.connections.open` is nominally Tier 3 (50+ req/min) but has effectively ~1 req/min tolerance during reconnect storms — a rapid reconnect loop can lock the app out of new connections for 60 seconds
- A 409 error ("too many websockets") is returned if the 10-connection ceiling is hit

### Message History Pagination

- `conversations.history` returns up to 200 messages per request (default 100) for unrestricted apps
- For restricted non-Marketplace apps: max 15 messages per request at 1 req/min
- Cursor-based pagination via `response_metadata.next_cursor`
- Messages are returned newest-first; `oldest` and `latest` parameters allow time-bounded range queries

### Channel Limits Per Workspace

- No documented hard ceiling on channel count for any Slack plan (free or paid)
- `conversations.create` is Tier 2 (~20 req/min) — mass channel creation during setup or migration is the binding constraint, not a per-workspace quota
- Channel names must be lowercase, max 80 characters, no spaces or special characters (periods, underscores, hyphens allowed)

---

## Critical Issues

### C1: `slack-channel-context.sh` Hook Will Exhaust Rate Limit Under Normal Use

**Severity: HIGH**

Section 7.5 describes `slack-channel-context.sh` fetching "last 30 messages" of channel history on every user prompt injection. This makes a live `conversations.history` API call per incoming message.

Under normal use: a user sends 10 messages in 5 minutes across 3 sessions = 30 `conversations.history` calls in 5 minutes. The Tier 3 budget is 50+ per minute — this looks safe. But all other adapter operations (reactions, sends, channel management) share this budget. More importantly, the hook fires on *every prompt*, including follow-up messages in rapid exchanges. A fast back-and-forth conversation of 20 messages generates 20 API calls that return mostly the same data.

At 10x (an agent handling 10 sessions): 200 history calls in 5 minutes, saturating the tier budget entirely, causing all other Slack API operations to fail.

The spec also doesn't specify how many paginated requests "last 30 messages" requires. If cursor pagination is used, it could be 1-3 requests per prompt.

**Recommendation**: Maintain an in-memory ring buffer (last 50 messages per active channel) updated from Socket Mode events in real-time. The hook reads from this cache — zero API calls, zero latency, no rate limit exposure.

### C2: Reconnection Logic Can Trigger `apps.connections.open` Exhaustion

**Severity: HIGH**

Section 3.3 specifies: "On WebSocket close: reconnect immediately." Exponential backoff only applies to repeated failures. Under normal Slack operation, WebSocket connections are closed and rotated on schedule (approximate_connection_time is typically several hours). Each rotation triggers `apps.connections.open` — a Tier 3 call.

The danger: if a connection close coincides with a transient network issue, the adapter calls `apps.connections.open` repeatedly before the error path triggers the backoff. If 10+ calls happen within the rate limit window, the app is locked out of new connections for 60 seconds. During this window, all incoming messages are lost (Socket Mode does not buffer during disconnection — it buffers only for 30 minutes of total downtime, not reconnect attempts).

A secondary risk: the spec does not mention reading `approximate_connection_time`. If the adapter doesn't know when to expect a rotation, it always reconnects reactively rather than proactively.

**Recommendation**: Apply exponential backoff from the first reconnect attempt, not only after repeated failures. Read and honor `approximate_connection_time` — pre-emptively open a new connection 60 seconds before the current one expires, then close the old one. This is the pattern Slack's own SDK uses.

### C3: No Rate Limit Budget Coordination Across Concurrent Callers

**Severity: MEDIUM**

The spec describes multiple independent Slack API callers that share a single bot token (and therefore a single rate limit bucket):
- The SlackAdapter itself (reactions, sends, channel management)
- `slack-reply.sh` — called by each active session independently; 5 concurrent sessions can each fire simultaneously
- `slack-channel-context.sh` — fires per prompt
- Job scheduler notifications (periodic)
- Attention queue channel creation

The `slackApi()` wrapper in section 7.2 handles per-call retry but has no global budget awareness. A single busy minute with 5 sessions all acknowledging messages simultaneously generates:
- 5x `reactions.add` (👀)
- 5x `reactions.add` (⏳)
- 5x `chat.postMessage`
- 5x `reactions.remove` + `reactions.add` (✅)
= 25 Tier 3 calls in seconds, plus any concurrent history fetches.

This does not exceed the 50+ req/min Tier 3 budget at 5 sessions, but the budget is consumed unevenly (burst then idle), and there is no mechanism to prioritize user-visible operations (chat.postMessage) over cosmetic ones (reactions) when approaching limits.

**Recommendation**: A global token bucket at the adapter level with priority queues: user-visible sends at highest priority, reactions at lowest. Drop or defer reactions silently when under pressure.

---

## Recommendations

### R1: In-Memory Channel History Cache (Addresses C1)

Maintain a per-channel ring buffer (e.g., last 50 messages) populated from incoming Socket Mode events. Seed it with an initial `conversations.history` call when a channel becomes active. The `slack-channel-context.sh` hook reads from this in-process cache via a new server endpoint (e.g., `GET /slack/channels/:channelId/cache`). Result: zero API calls per prompt, ~1 API call per channel per session start.

### R2: Proactive WebSocket Rotation (Addresses C2)

On connection establishment, read `approximate_connection_time`. Schedule a new `apps.connections.open` call at `T - 60s`. Open the new WebSocket, verify it's receiving events, then close the old one. On any close event that isn't a planned rotation, apply exponential backoff from the first attempt (start at 1s, not 0s).

### R3: Global Rate Limit Token Bucket (Addresses C3)

Implement a per-method token bucket inside `slackApi()`. Track requests per minute per method tier. When a bucket is near empty, queue low-priority calls (reactions, history fetches) and allow high-priority calls (chat.postMessage) to proceed. This prevents cosmetic operations from crowding out user-visible ones.

### R4: Clarify Custom App Exemption for Rate Limits

Add a note in section 7.2 explicitly stating that the DIY app model creates a custom/internal app (not a distributed non-Marketplace app), which retains standard rate limits for `conversations.history`. Include a runtime check in the adapter's `start()` method that calls `conversations.history` with `limit=1` and logs the effective tier based on response time. Alert if response indicates restricted tier.

### R5: Channel Creation Pacing at Startup

Section 5.3 and Phase 3 describe creating job channels, session channels, and attention channels. At agent startup with 20 configured jobs + existing attention items, this can trigger 25+ `conversations.create` calls simultaneously. At Tier 2 (~20 req/min), this saturates the create budget. Implement a creation queue with a 15/min pacing limit and defer non-critical channel creation (job channels, attention channels) to a background task rather than blocking startup.

### R6: Reactions Must Be Non-Fatal (Critical for Production Stability)

Section 9.1's `acknowledgeMessage()` will throw if `reactions.add` fails (rate limit, message already reacted to, message deleted, permission error). This is called in the message processing hot path. If it throws, the message may fail to route to the session. All reaction calls must be wrapped in fire-and-forget with silent error logging. Reactions are cosmetic; they must never block or fail message processing.

---

## Observations

### O1: Single-Agent Scale Means Most Issues Are Latent, Not Immediate

At the intended 1 user / 1 workspace / 3-5 sessions scale, none of the critical issues above will manifest under normal conditions. C1 won't hit rate limits until ~30+ messages/minute across all sessions. C2 won't trigger in normal operation (WebSocket rotation is infrequent). C3 is only relevant under simultaneous burst. The spec is production-viable as written for its stated scope.

### O2: Socket Mode Was the Right Call

Socket Mode's 30-minute delivery buffer (noted in section 3.4) is accurate and is genuinely superior to Telegram's long-polling for server-restart resilience. The architecture decision is correct.

### O3: `channels:write` Scope Is Deprecated

The manifest in section 6.3 requests `channels:write`. Slack deprecated this scope in favor of `channels:manage` in 2021. The scope still works but generates deprecation warnings in some contexts and may be rejected for new apps in stricter workspace configurations. The spec should update to `channels:manage` (public channels) and verify the equivalent for private channels (`groups:write` → `groups:write.invites`).

### O4: `slack-reply.sh` Default Port Is 4040, Should Be 4042

Section 7.4 hardcodes `PORT="${INSTAR_PORT:-4040}"`. The instar server runs on port 4042 (per CLAUDE.md and config). If `INSTAR_PORT` is not set in the session environment, the relay script silently fails with a connection refused error. This is a day-one operational bug.

### O5: No Mention of Slack Free Plan 90-Day History and Cache Seeding Interaction

The spec correctly lists 90-day history as a known risk (section 13). But it doesn't address the interaction with R1 (cache seeding): when a channel context hook is called for a channel that went inactive for >90 days and was archived/unarchived, the initial cache seed call to `conversations.history` will return 0 messages on free plans. The JSONL log (section 7.6) is the fallback, but the cache seeding logic should explicitly fall back to the local log when Slack history is empty.

### O6: No Explicit Handling of Slack's `disconnect` Event Type

Socket Mode sends a `disconnect` event with a `reason` field before closing the connection (e.g., for planned rotations: `reason: "refresh_requested"`). The spec's reconnection logic does not differentiate between `disconnect` events and raw WebSocket close events. Handling `disconnect` with `reason: "refresh_requested"` specifically allows the adapter to know it has time for a graceful rotation rather than treating it as an error.

### O7: Block Kit Block Limit Not Mentioned

Slack's Block Kit has a limit of **50 blocks per message**. The Prompt Gate implementation (section 8.1) maps prompt options to action buttons. If a prompt has more than ~45 options (unlikely but possible for generated option lists), the message will be rejected. Add a guard that truncates to 45 options with a "..." overflow indicator.

---

## Scalability Assessment

### Phase 1: Core Adapter (Weeks 1-2)

**Scale target**: 1 user, 1 workspace, 1-3 sessions

**Verdict**: Low risk. Socket Mode connection handling is trivial at this scale. Rate limits will not be encountered. The reconnect gap (C2) won't manifest under normal rotation schedules.

**Blocking items before Phase 1 launch**: Fix the port default in `slack-reply.sh` (O4). Wrap reactions in fire-and-forget (R6). Both are 5-minute fixes.

### Phase 2: Setup Wizard (Weeks 2-3)

**Scale target**: Fresh workspace creation, ~20-30 API calls during 14-step setup

**Verdict**: Low risk from a scalability perspective. API calls are sequential and well within tier budgets. The scope deprecation (O3) is the only Slack-specific concern here.

**Blocking items**: Update manifest scopes from `channels:write` to `channels:manage` (O3).

### Phase 3: Feature Parity (Weeks 3-4)

**Scale target**: Full adapter with attention queue, job scheduler, file handling, concurrent sessions

**Verdict**: Medium risk. Concurrent callers (C3) become real here. The reaction ack pattern must be non-fatal (R6) before this phase ships. Channel creation pacing (R5) needed if agent has many jobs.

**Blocking items**: R6 (reaction non-fatal), R5 (channel creation pacing). R3 (token bucket) strongly recommended but not strictly blocking for initial testing.

### Phase 4: Polish & Testing (Weeks 4-5)

**Scale target**: Continuous operation, full feature set, performance testing

**Verdict**: High risk if C1 is not addressed before this phase. The channel context hook fetching live history on every prompt will cause rate limit failures under even moderate testing load. This is the most impactful implementation gap.

**Blocking items**: R1 (in-memory cache for channel history) must be implemented before Phase 4 load testing begins. R2 (proactive WebSocket rotation) should be validated here.

---

## Score: 6.5 / 10

**Rationale**:

The architecture is correct. Socket Mode, DIY app model, zero-SDK approach, and reuse of shared infrastructure are all well-reasoned decisions for this use case.

**Deductions**:
- C1: Channel history hook design will cause rate limit failures under moderate load (-1.0)
- C2: Reconnection logic can create self-inflicted lockout (-0.75)
- C3: No cross-caller budget coordination (-0.5)
- O4: Day-one port bug in relay script (-0.5)
- O3: Deprecated scope in manifest (-0.25)
- Missing acknowledgment of 2025 rate limit changes and custom app exemption (-0.5)

**Credits**:
- Correct identification of 30-minute Socket Mode buffer window
- Solid feature parity analysis with accurate equivalence ratings
- Good channel lifecycle design with auto-archive policy
- DIY app model rationale is well-argued and correct
- Reaction-as-ack pattern is genuinely better than Telegram's text acks
- Risk table is honest and includes realistic likelihoods

The spec is implementable and will work correctly for its intended single-user scope. The identified issues are real but surface only under edge cases or higher load — all fixable before Phase 3/4 without architectural changes.

---

*Research sources*:
- [Slack API Rate Limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Rate limit changes for non-Marketplace apps (May 2025)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [Clarifying rate limit changes for non-Marketplace apps (June 2025)](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [apps.connections.open method](https://docs.slack.dev/reference/methods/apps.connections.open/)
- [Socket Mode implementation guide](https://api.slack.com/apis/connections/socket-implement)
