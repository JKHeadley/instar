# Scalability Review — Persistent Listener Daemon RFC

**Reviewer**: Scalability & Infrastructure Specialist
**Review ID**: 20260405-135742
**Round**: 1
**Date**: 2026-04-05

---

### Approval Status: CONDITIONAL APPROVE

### Score: 6.5/10

Sound infrastructure for 10-200 agents. Will require relay clustering and inbox storage evolution before 500+.

---

### Research Findings

- **WebSocket relay scaling:** Single-node WebSocket relays on Fly.io hit practical limits around 10,000-50,000 concurrent connections. At 500+ agents reconnecting simultaneously after relay restart, 25% jitter on 1s base gives ~±250ms window — thundering herd risk. Reconnect jitter should be seeded per agentId hash.
- **JSONL inbox scaling:** Append is O(1) for single writer, but `fs.appendFileSync` (synchronous/blocking) blocks the daemon's event loop at >100 msg/sec. Inbox growth unbounded — 1,000 msgs/day × 500 bytes = ~180MB/year per agent. No rotation policy specified.
- **tmux session limits:** Practical limits emerge around 100-200 concurrent sessions. The spec's `maxConcurrent: 5` for pipe sessions is appropriate per agent.
- **Unix domain socket throughput:** 0.01-0.05ms latency for small payloads, ~50% lower than TCP loopback. Connect-send-close adds ~0.1-0.5ms — negligible at expected rates.

---

### Phase Assessment

| Phase | Agents | Data Volume | Key Bottleneck |
|-------|--------|-------------|----------------|
| MVP | 10-50 | Small (MB/agent) | None significant |
| Growth | 50-500 | Medium (GB aggregate) | Relay SPOF; inbox JSONL rotation races; tmux aggregate on shared machines |
| Scale | 500-5000 | Large (10s GB) | Relay clustering required; JSONL needs SQLite replacement; git sync latency bottleneck |
| Viral | 5000+ in days | Rapid growth | Relay redesign needed; file-based inboxes can't support horizontal distribution |

---

### Critical Issues

**1. Relay as Undocumented Single Point of Failure** (High — Growth phase)
- Failover uses relay presence as oracle. Relay downtime kills all failover signals simultaneously.
- Heartbeat fallback only handles Machine A → B transitions, not global relay outage.
- No per-agent jitter seeding means reconnect storms at 100+ agents.
- **Fix:** Seed backoff jitter from agentId hash. Document relay HA requirements. Set offline queue TTL to 5× expected failover window.

**2. Inbox JSONL Has No Rotation Strategy** (Medium — Growth/Scale)
- No maximum inbox size, no archival policy, no poll cursor durability spec.
- The 100ms write-pause rotation coordination in Open Question 2 is fragile.
- **Fix:** Define rotation triggers (50MB or 7 days), implement durable poll cursor in sidecar file, retain rotated inboxes for one reconnect cycle.

**3. Task Detection Uses String Matching Instead of LLM Classification** (Medium)
- Keyword matching silently misroutes complex messages phrased with synonyms.
- **Fix:** Single Haiku-class LLM call (~200ms, negligible vs 2s spawn time).

---

### Observations

- **Git sync for ThreadResumeMap** (Phase 4) adds 5-30s latency — incompatible with <30s failover target from Phase 3. Relay-based propagation should be primary; git sync is eventual-consistency backup.
- **Pipe session log files** have no rotation — unbounded growth for high-volume agents.
- **launchd/systemd assumption** needs revisiting for container environments.
- **`fs.appendFileSync` is synchronous** — flag for replacement with async append at higher volumes.
- **Latency table (Section 3.4)** 300ms improvement from eliminating polling jitter is accurate and well-reasoned.

---

### Scalability Score Breakdown

| Dimension | Score | Notes |
|-----------|-------|-------|
| Database & Storage | 5/10 | Unbounded inbox growth; no rotation policy; poll cursor durability unclear |
| API & Network | 6/10 | Relay is undocumented SPOF; reconnect thundering herd risk |
| Compute | 8/10 | Pipe session caps appropriate; circuit breakers well-designed; daemon is lean |
| Cost Scaling | 7/10 | Reasonable per-agent model; pipe sessions reduce API costs |
| Viral Spike Handling | 4/10 | No relay capacity planning; reconnect storm unaddressed |
| Data Model Scaling | 6/10 | JSONL scanning grows linearly; ThreadResumeMap LRU correct; git sync won't scale |
