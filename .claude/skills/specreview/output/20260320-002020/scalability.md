# Scalability & Infrastructure Review: Input Gate
**Review ID:** 20260320-002020
**Spec:** `specs/session-prompt-bridge.md` (renamed: Input Gate)
**Reviewer Role:** Scalability & Infrastructure Specialist
**Round:** 2
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL APPROVE**

Round 2 has resolved the three critical issues identified in DX review round 1 (CallbackRegistry for 64-byte Telegram limit, ANSI stripping now specified, auto-approve opt-in, audit log schema with rotation). From a scalability perspective, the design is appropriate for the expected operating envelope: single-agent, single-machine, 1-50 concurrent sessions. The critical issues below are not blockers for MVP, but two of them become hard walls at Growth phase (50-500 sessions) and must be addressed before that threshold.

---

## Research Findings

### tmux capture-pane Performance at Scale

From the tmux issue tracker and benchmark data: tmux's in-process pane operations are fast at small scale, but the server process degrades when scrollback history buffers (default 2000 lines/pane) fill up. At 100+ active panes, memory pressure from accumulated scrollback buffers causes increasing latency on all pane operations, including capture-pane. One tracked issue (tmux/tmux#2551) documented 100% CPU core saturation after extensive pane history accumulation. The 100-pane benchmark measured zoom-toggle at P95 = 67ms — capture-pane is lighter than zoom, but the memory pressure pattern is the same.

**Implication for Input Gate:** The existing 500ms capture loop per session is the polling foundation of the entire detection system. At 10-20 concurrent sessions this is trivially cheap. At 50+ sessions with full history buffers, each capture-pane call becomes more expensive and jitter increases. There is no buffering or batching in the current design — each session has its own capture interval.

### Telegram Bot API Rate Limits (2025-2026)

As of Bot API 7.0 (January 2025), Telegram replaced legacy per-chat soft limits with a token-bucket algorithm returning `retry_after` on 429 responses. Bot API 8.0 (November 2025) added these headers to every method. The practical limits:
- Global: 30 messages/second per bot token (shared across all methods)
- Per-chat: ~20 messages/minute sustained; burst allowed
- `getUpdates` polling: not counted against the outgoing message quota
- `answerCallbackQuery`: must be called within 10 seconds of receiving the callback, or the user sees a loading spinner permanently
- `editMessageText`: counts against the global 30 msg/s limit

**Implication for Input Gate:** The relay flow for a single prompt involves 3 API calls (sendMessage, answerCallbackQuery, editMessageText). At steady state this is negligible. Under viral spike or many concurrent prompts, the timeout + reminder flow adds 2 more calls per prompt. With 10 active relays timing out simultaneously, that is 30 API calls in a burst — hitting the global per-second limit. The spec notes "rate limit relay to 1 msg/s per topic" but does not specify a global outbound queue or backpressure mechanism.

### JSONL Performance at Scale

JSONL append-only writes are O(1) per entry and do not require file locking for appends on POSIX systems when writes are sequential (single writer). The spec's 10MB rotation threshold with 3 retained files creates a maximum on-disk footprint of ~40MB for the audit log. At the expected rate (tens of prompts per session, tens of sessions per day), this rotation threshold will not be hit for months or years. JSONL is the correct format choice here. The performance concern is not write throughput — it is read-time query: there is no index, so any query over historical log entries requires a full file scan. This is acceptable for an audit trail but rules out using the JSONL log as a real-time data source for dashboards.

### Node.js In-Memory Map Performance

Node.js `Map` has O(1) amortized get/set/delete. For the CallbackRegistry use case (8-char string keys, small context objects), memory per entry is approximately 200-400 bytes (key string + object overhead + Map entry pointer). At 1000 concurrent pending callbacks (an extreme upper bound), total registry memory is under 400KB — effectively free. The GC pressure from frequent creation/deletion of small objects in the registry is negligible at this scale.

The `pendingPromptReply` map is keyed by `topicId` (integer) — a small number of entries bounded by the number of active Telegram topics. No scaling concern here.

The `InputDetector` uses three `Map<string, ...>` instances keyed by session name. At 100 sessions, all three maps hold 100 entries each — trivially small.

---

## Critical Issues

### CI-1: No Global Outbound Rate Limit Queue for Telegram API (Growth Phase)

**Hits at:** Growth (50-500 sessions, multiple simultaneous relays)

The spec specifies "rate limit relay to 1 msg/s per topic" but this is per-topic, not global. With 20 topics each firing a relay simultaneously (e.g., a shared instar instance serving many users), the bot could attempt 20 `sendMessage` calls in the same second plus their corresponding timeout reminders — approaching or exceeding Telegram's 30 msg/s global token bucket.

More critically: `answerCallbackQuery` must be called within 10 seconds of receiving the callback. If a global queue backs up due to rate limiting, callbacks received while the queue is saturated will miss this window. The user's button tap produces a permanent loading spinner, which is a severe UX failure.

**Required mitigation:** Implement a global outbound Telegram API queue with:
- A token bucket (30 tokens/s, replenished continuously)
- Priority lanes: `answerCallbackQuery` calls must be highest priority (10-second deadline)
- `editMessageText` and `sendMessage` in standard priority
- Timeout reminders in lowest priority
- Exponential backoff on 429 with the `retry_after` value from Bot API 7.0+

This is a Growth-phase requirement. At MVP scale (1-5 active users), the current design is safe.

### CI-2: capture-pane Polling Does Not Scale Horizontally (Scale Phase)

**Hits at:** Scale (500-5000 sessions across multiple agents/machines)

The InputDetector hooks into the existing 500ms capture loop in `WebSocketManager.ts`. This means every active session generates at least 2 tmux subprocess calls per second (one for the existing WebSocket stream, one implicit via InputDetector's `onCapture`). At 50 sessions: 100 subprocess calls/second. At 200 sessions: 400 subprocess calls/second. At 500 sessions: 1000 subprocess calls/second on a single process.

tmux's own issue tracker documents CPU saturation when many panes accumulate history. The capture loop does not batch — each session is polled independently. There is no backpressure: if the server falls behind, prompts may be detected 2-4 seconds late (missing the 2-second debounce window with correct timing).

**Required mitigation (Scale phase):**
- Consolidate the InputDetector into the existing capture call — one tmux process spawn per session per 500ms, not two
- Add adaptive polling: sessions with recent activity poll at 500ms; idle sessions poll at 2s or 5s
- Cap the maximum concurrent capture calls with a semaphore (e.g., max 20 in-flight at once)
- For Scale+ deployments: move to tmux hooks (`set-hook`) to push output to the server rather than polling, eliminating the capture-pane call entirely for prompt detection

### CI-3: CallbackRegistry Has No Persistence and No Cross-Restart Recovery for Active Prompts (MVP Edge Case, Growth Blocker)

**Hits at:** MVP (single-agent restart during active relay)

The spec correctly documents this: "On startup, the registry is empty. Any stale Telegram buttons from before the restart will fail to resolve." The mitigation specified is to show an expiry message on stale button taps. This is acceptable UX for a cold restart.

However, the spec does not address the recovery path for the `pendingPromptReply` map. If the server restarts while a topic has an active `pendingPromptReply`, that state is lost. The next text message in the topic — which the user intends as normal conversation — will be processed as a normal message, not a prompt response. But the tmux session is still blocked waiting for input. The user is confused: they sent a message, Claude did not respond, the session is still frozen.

**Required mitigation:**
- Persist `pendingPromptReply` state to a small JSON file (e.g., `.instar/input-gate-state.json`) on set/delete
- On server start, re-hydrate this state and send a Telegram message to each pending topic: "Server restarted — please re-send your response or check the dashboard"
- This is a one-time write per state change, negligible overhead

---

## Recommendations

### R1: Consolidate into Existing Capture Loop (Correctness + Performance)

The spec says InputDetector "hooks into the existing 500ms capture loop... After each `captureOutput()` call, the captured text is also passed to InputDetector." This is correct design — it is a pipeline, not a second capture. The implementation must ensure `captureOutput()` is called once per 500ms tick and the result is passed to both the WebSocket streamer and InputDetector. Do not introduce a second independent polling loop for InputDetector. The spec implies this but should state it explicitly to prevent implementation drift.

### R2: ANSI Strip Is Now Specified — Enforce with a Tested Library

Round 1 DX review called out missing ANSI strip; round 2 spec now includes it. Good. Ensure the ANSI strip function handles the full VT100/VT220 escape sequence set, not just color codes. `tmux capture-pane` emits cursor positioning sequences (`\x1b[H`, `\x1b[2J`), alternate screen switches, and bracketed paste mode markers. A regex like `/\x1b\[[0-9;]*[a-zA-Z]/g` catches color codes but misses some cursor sequences. Use a tested ANSI strip library (e.g., `strip-ansi` npm package) rather than a hand-rolled regex.

### R3: Add Semaphore to AutoApprover's sendInput Calls

AutoApprover injects `sendInput` after a 500ms sleep. If multiple auto-approve decisions are queued simultaneously (rapid sequential prompts), multiple `sendInput` calls could arrive at tmux in the same tick. tmux `send-keys` is synchronous and terminal echo can create interleaving artifacts. Add a per-session semaphore in AutoApprover so only one `sendInput` is in flight per session at a time. This is a correctness concern, not just a performance concern.

### R4: Define a Maximum Supersession Rate for Rapid Sequential Prompts

The spec defines supersession behavior when a second prompt arrives while one is pending. It does not define a maximum rate of supersession. In a pathological case (Claude generating many prompts rapidly, user not responding), the system sends a Telegram message for each prompt, each superseding the previous. This could send 10+ Telegram messages in 30 seconds for a single topic — burning through per-chat rate limits and creating a confusing wall of notifications.

**Mitigation:** If a prompt is superseded within N seconds (e.g., 10s) of the previous prompt, edit the existing message in place rather than sending a new one. Only send a new message if the user had enough time to see and potentially respond to the previous one. This caps the notification rate at one new message per N seconds per topic.

### R5: Jitter the Prune Interval

The spec defines `prune()` running on a 60-second interval. If multiple agents run on the same machine (likely for instar multi-agent setups), all agents will start their prune intervals at approximately the same time post-boot. On a server with 10 agents, all 10 prune intervals firing simultaneously causes a small but real I/O burst. Use `setInterval(prune, 60000 + Math.random() * 10000)` — jitter the interval by 0-10 seconds to spread the load.

### R6: Do Not Query the Audit Log File Directly for Dashboard Display

The spec mentions an "Audit log viewer in dashboard" (Phase 4). If the dashboard reads `.instar/input-gate-log.jsonl` directly from the server process while AutoApprover is appending to it, `fs.readFile` will see partial lines at append boundaries. Maintain a separate in-memory ring buffer of the last N log entries for the dashboard to query — keeping the dashboard view independent of the file read path. The file is the durable record; the in-memory buffer is the live view.

---

## Observations

### O1: The 2-Second Debounce Interacts Correctly With the Stall Fallback

The debounce requires 4 consecutive identical captures (4 x 500ms = 2s). The stall fallback fires after 60 seconds of no output change. These work together: debounce confirms a prompt is real before triggering relay; stall fallback catches what debounce misses. One edge case: if a prompt appears AND disappears within the 2-second debounce window (e.g., auto-approved by a different mechanism), InputDetector correctly does not emit it. The `onInputSent` callback to clear the dedup cache is the right design here.

### O2: The 10MB Rotation Threshold Is Appropriate — Will Rarely Trigger

At the expected rate of tens of prompts per session and tens of sessions per day, each log entry is ~200-300 bytes. 10MB accommodates approximately 35,000-50,000 entries. At 100 prompts/day, rotation would occur every ~350 days — the log will almost never rotate in single-agent production use. This is correct sizing. The rotation specification is good hygiene, not a performance necessity.

### O3: Single-Machine Scope Is the Correct MVP Boundary

All state (CallbackRegistry, pendingPromptReply, InputDetector maps) is in-process memory. This is correct for the stated audience. Distributed state would add significant complexity for no benefit at the expected scale. The architecture should document multi-machine evolution (instar git-sync or shared database) in Open Questions as an explicit future path rather than an afterthought.

### O4: Base62 Token Collision Probability Is Negligible

8-character base62 = 62^8 approximately 218 trillion distinct tokens. Even at 1000 active callbacks simultaneously, the collision probability per registration is ~4.6 x 10^-12. This is safe. The `register()` implementation should nonetheless check for key existence and retry on collision, for correctness completeness.

### O5: False Positive Tracking Specification Is Vague

Section 5 ("False positive detection") says "track the last 5 injections and if Claude's output continues normally after injection, the auto-approve was correct. If Claude shows an error or unexpected state, flag it." This is not actionable as written. What constitutes "continues normally"? What triggers "unexpected state"? The Phase 4 deliverable should define concrete criteria (e.g., "if session produces no output for 10 seconds after an auto-approve inject, emit a warning to the audit log").

---

## Scalability Assessment by Phase

### MVP (10-50 sessions, 1-5 users)

All components are well-sized for this phase. In-memory Maps hold trivially small state. The CallbackRegistry at 1000 concurrent callbacks uses under 400KB. JSONL writes are O(1). The capture loop at 50 sessions generates 100 subprocess calls/second — within normal Node.js operational parameters. The Telegram API rate limit budget (30 msg/s global) is essentially unlimited at this scale with 1-5 concurrent users.

No blockers. CI-3 (restart recovery for pendingPromptReply) is a UX concern at this phase but not a data loss risk.

**Score: 9/10**

### Growth (50-500 sessions, 5-50 users)

The Telegram outbound queue (CI-1) becomes a real concern when multiple users' sessions relay simultaneously. The `answerCallbackQuery` 10-second deadline can be missed under burst load without a priority queue. The capture-pane overhead at 500 sessions (1000 subprocess calls/second) requires adaptive polling to be in place before reaching this phase.

Blockers before scaling to this phase:
1. Global Telegram outbound queue with priority lanes for time-sensitive callbacks (CI-1)
2. Confirmed single-capture consolidation per session per tick (R1)
3. Adaptive polling for idle sessions

**Score: 6/10 without mitigations; 8.5/10 with them**

### Scale (500-5000 sessions, 50-500 users)

The polling architecture becomes the primary constraint. 5000 sessions at 2 captures/second = 10,000 subprocess spawns/second — Node.js event loop saturation territory. The tmux-hook approach (push vs. pull) is the architectural shift required here. The CallbackRegistry and other in-memory structures remain efficient (Map lookup is O(1)). The Telegram adaptive rate windows expected in 2026 may help or hurt depending on bot reputation score.

Required architectural change: tmux hooks as primary detection mechanism; capture-pane polling as fallback only.

**Score: 4/10 without architectural shift; 7/10 with tmux hooks**

### Viral (5000+ sessions in days)

This is not a realistic operating scenario for the described use case. A viral spike here implies a multi-tenant hosted platform, not a single-machine deployment. At that scale, the entire architecture would require decomposition: separate services for detection, classification, relay, and state management; a message broker (Redis/Kafka) replacing in-memory Maps; Telegram API across multiple bot tokens with load balancing.

This phase is explicitly out of scope for Input Gate v1 and should remain so. The spec's single-machine design is correct for its stated audience.

**Score: N/A (architecture not designed for this phase, by design)**

---

## Score

**7.5 / 10**

The spec is well-designed for its MVP operating envelope. The round 2 revisions (opt-in auto-approve, CallbackRegistry, ANSI stripping, audit log schema with rotation) closed the critical correctness issues from round 1. From a scalability lens, the design is sound through the MVP phase (10-50 sessions) with no modifications required. Two issues (global Telegram rate limit queue, capture-pane scaling) are real walls that will be hit at Growth phase if not addressed before reaching that scale. They are not blocking MVP ship, but they should be tracked as explicit Growth-phase milestones.

Points deducted for:
- No global Telegram outbound queue with priority for time-sensitive callbacks (answerCallbackQuery 10s deadline) (-1.0)
- No persistence for `pendingPromptReply` across server restarts; silent misrouting after restart (-0.5)
- No adaptive polling strategy specified; idle sessions consume same capture budget as active ones (-0.5)
- False positive tracking spec is vague and unactionable as written (-0.25)
- No maximum supersession rate cap for rapid sequential prompts; potential per-chat rate limit burn (-0.25)

This rates as a conditional approve for Phase 1-2 implementation. Phase 3 (Telegram relay) should not ship without the global outbound queue (CI-1). Phase 4 production deployment should include adaptive polling and restart recovery for `pendingPromptReply`.

---

## Sources

- [tmux CPU saturation issue (tmux/tmux#2551)](https://github.com/tmux/tmux/issues/2551)
- [tmux vs zellij 100-pane benchmark](https://tildalice.io/tmux-vs-zellij-100-pane-benchmark/)
- [Telegram Bot API Rate Limits — gramio.dev](https://gramio.dev/rate-limits)
- [Telegram Bots FAQ](https://core.telegram.org/bots/faq)
- [Telegram Bot API official docs](https://core.telegram.org/bots/api)
- [Telegram rate limit discussion (tdlib/td#3034)](https://github.com/tdlib/td/issues/3034)
- [JSONL Performance — ndjson.com](https://ndjson.com/performance/)
- [JSONL for Log Processing — jsonl.help](https://jsonl.help/use-cases/log-processing/)
- [Node.js 16-25 Performance Benchmarks — repoflow.io](https://www.repoflow.io/blog/node-js-16-to-25-benchmarks-how-performance-evolved-over-time)
- [Node.js Memory — Understanding and Tuning](https://nodejs.org/en/learn/diagnostics/memory/understanding-and-tuning-memory)

---

*Review generated by Echo (instar developer agent) · Round 2 · 2026-03-20*
