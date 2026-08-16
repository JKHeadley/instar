# Scalability Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Scalability & Infrastructure
**Score**: 7/10
**Approval Status**: CONDITIONAL APPROVE

---

## Critical Issues

### 1. In-memory PendingRelay state with no persistence
PendingRelay state is in-memory only. Server restart loses all pending relays — users who responded after restart get no effect, and the session stays blocked.

**Fix**: Persist PendingRelay to disk (same pattern as PresenceProxy state persistence).

### 2. No concurrency control on tmux injection
Multiple pending relays for the same session could inject responses concurrently. If two prompts queue up and the user responds to both quickly, two `sendKey` calls race.

**Fix**: Per-session injection mutex. Queue responses and inject sequentially.

### 3. Timeout reminder creates unbounded notification chain
10-minute and 30-minute reminders repeat indefinitely for unresponsive prompts. With multiple sessions, this becomes notification spam.

**Fix**: Cap reminders at 2-3 per relay. After final reminder, log and stop.

---

## Recommendations

1. Add relay event batching — if 3 prompts queue up in 10 seconds, send one combined message
2. LLM context calls (Haiku) share the same concurrency queue as PresenceProxy — verify it doesn't starve Standby calls
3. PendingRelay cleanup: auto-expire after 1 hour with no response
4. The `promptId` fingerprint should survive server restarts for dedup

---

## Scalability Assessment

| Phase | Agents | Status | Key Risk |
|-------|--------|--------|----------|
| MVP (1-10) | Works cleanly | No issues | Single-user, low prompt frequency |
| Growth (50-500) | Functional | Notification spam with multiple sessions | Need batching |
| Scale (500-5000) | Needs work | In-memory state loss on restart, LLM queue contention | Need persistence + queue isolation |
| Viral (5000+) | Not designed for this | Per-agent feature, scales linearly | Main constraint is the Telegram bot rate limits |
