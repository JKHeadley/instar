## Architecture Review: Input Gate (Session Prompt Bridge)

**Approval Status: CONDITIONAL APPROVAL**
**Score: 8/10**

### Research Findings

- tmux `capture-pane` subprocess forking is the primary cost, not regex matching
- Telegram InlineKeyboardMarkup limited to 64 bytes per callback_data — spec correctly addresses with CallbackRegistry
- Event-driven terminal monitoring is standard for tools like tmuxinator, overmind

### Critical Issues

**CRIT-1: WebSocketManager integration captures output only when dashboard clients are connected.** The spec says InputDetector hooks into the "existing 500ms capture loop in WebSocketManager.ts (line 241)." But that loop only runs when WebSocket clients are connected. Headless Telegram sessions — the PRIMARY use case — would get zero captures. InputDetector needs its own capture loop or needs to hook into `SessionManager.monitorTick()` instead.

**CRIT-2: Fingerprint-only dedup can miss re-rendered prompts.** If tmux redraws the prompt with slightly different content (whitespace, cursor position), the fingerprint changes and the prompt is emitted again. Needs a post-emission cooldown window (e.g., 5s) in addition to fingerprint tracking.

### Key Recommendations

- **Specify the exact ANSI strip library/regex** — incomplete stripping is a common silent failure. Recommend `strip-ansi` npm package or Node 22+ `util.stripVTControlCharacters`.
- **Clarify `sendInput` vs `sendKey` usage** — the two behave differently for named keys like Escape. The spec uses both terms interchangeably.
- **Coordinate stall safety net with existing idle-kill timer** — sessions waiting on Telegram input will be killed as zombies by the existing 15-minute idle detection. This is exactly the bug observed in production (session 8a1956eb killed at 07:35).
- **Reuse existing `jsonl-truncator.ts` for log rotation** rather than implementing custom logic.

### Observations

- The CallbackRegistry token design is correct and elegant
- Opt-in auto-approve default is the right call
- Phase delivery order is sensible — detect-only Phase 1 allows validation before automation
- The test matrix with explicit false-positive test cases shows strong design awareness
- The 2s debounce (4 consecutive captures) is appropriate for the 500ms cycle

### Scalability Assessment

- **MVP (1-5 sessions)**: Architecture is well-suited. No bottlenecks.
- **Growth (5-20 sessions)**: Capture loop O(n) forks become noticeable. Add idle-session skip.
- **Scale (20-50 sessions)**: Need batched/multiplexed capture or switch to PTY-based monitoring.
- **Viral spike**: Not applicable — this is per-agent infrastructure, not multi-tenant.
