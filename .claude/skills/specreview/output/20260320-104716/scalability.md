## Scalability Review: Input Gate (Session Prompt Bridge)

**Approval Status: CONDITIONAL PASS**

The spec is architecturally sound for single-agent use. Issues become blockers at multi-session scale, not at v1.

### Research Findings

- **Telegram rate limits (Bot API 8.0):** 30 msg/s global, 1 msg/s per-chat. `answerCallbackQuery` has a separate 60/s bucket. `getUpdates` returns max 100 updates; concurrent polling drops updates.
- **tmux capture-pane:** No formal benchmarks. Large scrollback buffers (50k+ lines) cause lag. Per-session subprocess forking is the key cost driver, not CPU for parsing.
- **JSONL logging:** Synchronous `appendFileSync` blocks the event loop 0.5–2ms per write. Async writes (`fs.promises.appendFile`) or streams are the right approach at any meaningful volume.
- **Regex at 500ms:** Pre-compiled module-level patterns in V8 are sub-microsecond for typical terminal output sizes. The risk is greedy backtracking on large inputs before ANSI stripping — the spec correctly strips first.
- **ANSI strip:** `strip-ansi` is fast. Node.js 22+ has native `util.stripVTControlCharacters` with zero regex overhead as an alternative.

### Critical Issues

1. **Capture loop scales as O(sessions) subprocess forks** — 20 sessions = 40 `tmux capture-pane` forks/second. Not a v1 problem, but needs acknowledging. Mitigation: skip idle sessions, add idle-skip fast path.

2. **CallbackRegistry has no max-size cap** — unbounded `Map` with 60-second prune interval. Add a `maxEntries: 500` guard in `register()`.

### Key Recommendations

- Define `detectionWindowLines` explicitly in config (suggested: 50 lines)
- Implement relay queue with 1.1s drain rate + supersession-aware discard (Telegram's 1 msg/s per-chat limit)
- Make audit log writes async
- Add warning log when `pendingPromptReply` is overwritten mid-session
- `callback_query` processing should fast-path before the normal message pipeline

### Score: 7.5 / 10

Resolves both round-1 blockers cleanly. The remaining gaps are additive hardening, not architectural flaws. Safe to merge for v1 after the 5 small items listed above are addressed.
