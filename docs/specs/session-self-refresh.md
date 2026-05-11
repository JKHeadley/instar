---
title: "Agent-initiated session refresh via POST /sessions/refresh"
slug: "session-self-refresh"
author: "echo"
created: "2026-05-11"
supersedes: "none — net-new capability"
approved: true
approved-by: "justin (via 'approve' on Telegram topic 9235 qalatra, 2026-05-11, after reading convergence report at https://echo.dawn-tunnel.dev/view/ed372d9c-0aa5-4c88-8b85-b75156a2595c)"
approved-at: "2026-05-11T21:36:00.000Z"
review-convergence: "2026-05-11T21:34:54.916Z"
review-iterations: 2
review-completed-at: "2026-05-11T21:34:54.916Z"
review-report: "docs/specs/reports/session-self-refresh-convergence.md"
---

# Agent-Initiated Session Refresh

## Problem Statement

When an agent installs a new MCP server or skill mid-conversation, the new tool only attaches to **future** Claude Code processes — not the running one. Today the only way to pick it up is for the user to send another message, which spawns a fresh tmux session via the standard Telegram-recovery path. From the user's side this is friction: they made the request, the agent prepared the tool, and now they have to wake the agent up again before the tool can be used.

A second, structurally related problem surfaced on the qalatra Fathom-MCP install (topic 9235, 2026-05-11): when a long autonomous build hits Claude's context-window limit, the session dies leaving uncommitted work in a worktree with no signal to the user. Self-refresh on a near-context-exhaustion signal is one mitigation for that class of failure (out of scope for v1 — but the lifecycle owner this spec creates is the natural home for it).

## Design

Add `POST /sessions/refresh`. The agent calls it from within its own tmux session. The server:

1. Reads the current Claude session UUID from the most recent transcript file in `~/.claude/projects/<project>/`.
2. Kills the tmux session (firing the existing `beforeSessionKill` hook so the UUID is persisted to `state.json`).
3. Spawns a fresh tmux session whose Claude invocation is `claude --resume <uuid> "<followUpPrompt>"`.

The fresh process boots with **all** newly-installed MCP servers and skills attached (Claude Code reads `~/.claude.json` at process start) **and** the full conversation state preserved (`--resume` rehydrates from the transcript). No summary reconstruction, no context loss beyond what compaction would have erased anyway.

### Lifecycle owner

A new module `src/core/SessionRefresh` owns the refresh lifecycle. The existing Telegram `/restart` command (`server.ts:onRestartSession`) delegates to it, consolidating the kill+resume logic in one place instead of duplicating it across two callers.

**Behavior change to `/restart` when `_sessionRefresh` is null** (early-boot before adapter wiring, or no-Telegram deployments): the previous inline kill+respawn fallback is removed. `/restart` in that narrow window now logs a warning and no-ops. This is **not a regression** because the inline fallback path had a pre-existing latent bug (it called `findUuidForSession` without `claudeSessionId`, so the mtime-fallback removal meant it never actually persisted resume context — `/restart` would respawn without `--resume` and lose the conversation). The window in which this fallback fires is so narrow (server up but adapter not yet wired AND a user typing `/restart` at that exact moment) that it has not been observed in production.

### Conversation-preservation precondition

Refresh preserves the conversation only if `session.claudeSessionId` is populated at kill time. The `beforeSessionKill` listener (in `commands/server.ts`) uses that field as the authoritative UUID source to persist to `TopicResumeMap`; the respawner then reads it back and invokes `claude --resume <uuid>`.

If `claudeSessionId` is null on the session at kill time (e.g. transcript writer hasn't flushed the first turn yet, OR the session was created via a path that doesn't populate it), the listener saves nothing, the respawner spawns without `--resume`, and the conversation is lost silently. v1 behavior: silent. The agent must call `/sessions/refresh` only after at least one full turn has been recorded for its own session. In practice the agent triggers a refresh AFTER an MCP install completes, which is always at least one turn into the conversation, so this precondition holds for the driving use case.

Future v2: add a precondition check that returns `code: 'no_resume_uuid'` if `claudeSessionId` is null, before issuing the kill — so the conversation-loss case is never silent.

### Rate guard

Refusing infinite-respawn loops is a hard safety requirement (an agent that respawns itself in a tight loop would burn API quota and DOS its own tmux). The lifecycle owner enforces:

- **Rolling-window rate limit**: 5 refreshes per 10-minute window per session name. Stale timestamps are pruned on each call.
- **In-flight guard**: a second concurrent refresh for the same session returns `refresh_in_progress` immediately, no second kill issued.

Both guards reject with structured error codes (`rate_limited`, `refresh_in_progress`) — they are structural counters, not LLM-backed authority calls, so the signal-vs-authority principle's "boundary structural validators" carve-out applies (see `docs/signal-vs-authority.md`).

### Response timing

The route returns `202 Accepted` immediately. The kill+spawn fires ~500ms later (settable via `KILL_DELAY_MS`) so the response can flush back to the requester before its process is destroyed. Without the delay the requester would see ECONNRESET.

### Scope

**v1 (this spec):** Telegram-bound sessions only. The respawner needs `topicResumeMap` and `respawnSessionForTopic` to wire the new tmux session back to its Telegram topic. Non-Telegram sessions return `{ ok: false, code: 'not_telegram_bound' }`.

**v2 (out of scope):** Slack-bound, iMessage-bound, and headless-CLI sessions. Each adapter would need an analog of `respawnSessionForTopic`.

## API

```
POST /sessions/refresh
Authorization: Bearer <agent-auth-token>     # enforced by global authMiddleware
Content-Type: application/json

{
  "sessionName": "<tmux session name, required, /^[a-zA-Z0-9_-]{1,200}$/>",
  "followUpPrompt": "<optional, ≤500_000 chars — first message to inject in the resumed session; matches /sessions/spawn prompt cap>",
  "reason": "<optional, ≤1000 chars — short observability tag for ledger/log>"
}
```

Responses (synchronous portion — the 202 ack is returned BEFORE the kill+spawn fires; downstream failures are observable only via server logs, not the response):

- `202 Accepted` — `{ ok: true, message: 'Refresh scheduled', sessionName }` — request validated, kill+spawn scheduled in 500ms.
- `400 Bad Request` — `{ error: '...' }` for missing/oversized/malformed fields. Synchronous, before scheduling.
- `503 Service Unavailable` — `{ error: 'Session refresh not enabled (no Telegram adapter wired)' }` when `sessionRefresh` is not on the route context (v1 scope: Telegram-only). Synchronous.

**Async (post-202) failure outcomes** — emitted as structured `console.warn` from `[sessions/refresh]` and `[SessionRefresh]`, NOT returned to the caller:

- `rate_limited` — exceeded the rolling window cap (default 5/10min).
- `refresh_in_progress` — a prior refresh for the same `sessionName` is mid-flight.
- `not_telegram_bound` — `sessionName` is not registered with a Telegram topic (v1 scope).
- `no_telegram_adapter` — Telegram adapter was wired into `sessionRefresh` but is now null (server reconfigured).
- `session_not_found` — no running state session matches the requested `sessionName`.

The caller cannot retry intelligently on async failure because by the time the failure is logged, the caller's process may already be alive (refresh was a no-op) or dead (kill happened before failure code path). v1 behavior: the caller assumes 202 means "the server will handle it" and learns of failure only by observing whether new tools attach on next turn. Future v2 work: optional callback URL or attention-queue event on async failure (out of scope for v1).

### Authorization model

The bearer token gates the endpoint at `authMiddleware` (global), so any holder of the agent's `authToken` can refresh ANY session on that server, not just the caller's own session. There is no per-call "this session belongs to me" check in v1 because:

1. The token is a single-tenant agent secret; an attacker with the token already owns the agent.
2. Distinguishing "caller's own session" from "another session" would require the route to know the caller's tmux session name — which is not available from an HTTP request alone (no session-of-origin header today). Adding one would be a separate spec.

Risk acknowledged and accepted for v1: a buggy agent process could refresh a peer session it doesn't own. The rate guard (per-`sessionName`) limits blast radius. Tracked as a v2 follow-up if multi-agent-per-server becomes a real deployment.

## Decision-point inventory

Per `signal-vs-authority.md`, every new decision point must be classified.

| Decision | Authority? | Justification |
|---|---|---|
| Rate-limit cap (5/10min) | structural counter | Rolling-window count of timestamps. No semantic judgment. Boundary validator carve-out. |
| In-flight guard (one refresh per session at a time) | structural flag | Boolean per-session, set on enter, cleared on exit. Mechanical, not judgment. |
| Input validation (sessionName format, prompt size) | structural validator | Boundary input check. Carve-out applies. |
| Telegram-bound preflight | structural lookup | Checks for adapter presence. No agent-behavior decision. |

No LLM-backed gates are introduced.

## Rollback

- The new route is additive — removing the route handler reverts the surface.
- The `SessionRefresh` module is a leaf with one caller (`server.ts:onRestartSession`); deleting it requires reverting the delegation in `onRestartSession` back to inline kill+respawn.
- No persistent state is added (rate-counter is in-memory).
- Rollback cost: ~5 minutes (git revert of one commit). No data migration.

## Tests

- `tests/unit/SessionRefresh.test.ts` — 15 `it()` cases organized as: happy path (4 — return shape, kill-before-respawn order, undefined-prompt forwarding, no spurious findUuidForSession call), rate guard (5 — under cap, over cap, rolling-window pruning, per-session counters, no-side-effects-when-blocked), in-flight guard (3 — concurrent rejection, post-success clearing, post-throw clearing), failure modes (3 — not_telegram_bound, no_telegram_adapter, session_not_found).
- `tests/unit/sessions-refresh-route.test.ts` — 6 cases: 400 on missing sessionName, 400 on invalid chars, 400 on oversized followUpPrompt, 202 on valid input, async-call verification with real 600ms wait, 503 when sessionRefresh is null.

Total: 21 tests.

(Note: the side-effects review's tally of "11 SessionRefresh + 6 route = 17" is stale — count was strengthened during the second-pass rework that added the in-flight guard, the session_not_found failure mode, and the kill-ordering assertions.)

## Known v1 limitations

- **Async-failure observability gap.** The 202 ack is returned before the kill+spawn. If the refresh subsequently fails (`rate_limited`, `not_telegram_bound`, `session_not_found`, `refresh_in_progress`, `no_telegram_adapter`), the caller learns of failure only by side effects (no new MCP attached, conversation still alive). Mitigation today: structured `console.warn` logs at `[sessions/refresh]` and `[SessionRefresh]` are scrapable by ops. v2 path: post-failure attention-queue event or callback URL.
- **Cross-session authorization.** Bearer-token holders can refresh ANY session on the server, not just their own. Acceptable in single-agent deployments; tracked for multi-agent-per-server hardening.
- **`recentRefreshes` map grows over server uptime.** Each distinct `sessionName` adds one Map entry that is never reaped (only its timestamp array is pruned). Memory impact: ~100 bytes per session-name observed. Acceptable for instar's per-agent server model. v2 path: time-bucketed sweep removing sessionNames with no fresh timestamps and not currently registered with the adapter.
- **`killSession` return value not inspected.** If `sessionManager.killSession` returns false (e.g. session already dead), the respawner still fires. The result is that we respawn a session whose old process was already gone — behaviorally identical to the success case, but the structured log won't reflect "we killed nothing." v2 path: log when killSession returns false.
- **Conversation-loss precondition** (see Conversation-preservation precondition section): currently silent; v2 should return a `no_resume_uuid` code before issuing the kill if `claudeSessionId` is null.

## Out of scope (v2 follow-ups)

- Self-triggered refresh on near-context-exhaustion signal (the lifecycle owner is the right home; needs separate spec).
- Slack/iMessage/CLI adapter support.
- Persistent rate-counter (currently in-memory; lost on server restart, which is acceptable for v1).
- Refresh telemetry to attention queue (planned; needs separate spec for the alert shape).
- Per-call authorization scoping (caller's own session vs another).
- `no_resume_uuid` synchronous-failure code.
- Post-202 async-result delivery (callback URL or attention-queue event).
