# Consolidated Review Synthesis — Persistent Listener Daemon RFC

**Review ID**: 20260405-135742  
**Round**: 1  
**Date**: 2026-04-05  
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing  

---

## 1. Overall Status: NEEDS WORK

No reviewer issued a BLOCK, but every reviewer issued CONDITIONAL APPROVE. The aggregate picture is a spec with a sound core architecture that carries several pre-implementation blockers — primarily around inbox rotation, pipe session classification, and the split-brain/failover mechanism. None require redesign. All are fixable in a revision pass. The spec should not enter Phase 1 implementation until the critical issues below are resolved.

---

## 2. Score Summary

| Reviewer | Score | Approval Status |
|----------|-------|-----------------|
| Security | 6.5/10 | CONDITIONAL |
| Scalability | 6.5/10 | CONDITIONAL APPROVE |
| Business | 6.5/10 | CONDITIONAL APPROVE |
| Architecture | 8.0/10 | CONDITIONAL APPROVE |
| Privacy | 6.5/10 | CONDITIONAL APPROVE |
| Adversarial | 6.5/10 | CONDITIONAL APPROVE |
| DX | 7.5/10 | CONDITIONAL APPROVE |
| Marketing | 6.5/10 | CONDITIONAL APPROVE |
| **Average** | **6.8/10** | **NEEDS WORK** |

Architecture gave the highest score (8.0) noting the design is fundamentally sound. DX followed at 7.5 recognizing thoughtful structure with gaps in documentation and discoverability. All others clustered at 6.5, reflecting the same recurring blockers across lenses.

---

## 3. Consensus Findings (3+ reviewers agree)

### A. Pipe session classification via keyword matching is wrong
**Flagged by**: Security (REC-4), Scalability (Issue 3), Architecture (C2), Adversarial (CRIT-2), DX (O1)  
Keywords like "build", "implement", "fix" silently misroute messages phrased differently. The spec's own CLAUDE.md declares "Intelligence Over String Matching" — the spec violates its own principle. A Haiku-class LLM call (~200ms) is the correct replacement. All five reviewers independently reached this conclusion.

### B. Inbox rotation race condition is unresolved and dangerous
**Flagged by**: Architecture (C1), Scalability (Issue 2), Adversarial (CRIT-1), DX (Issue 3)  
The "100ms pause" coordination protocol described in Open Question 2 is a textbook TOCTOU vulnerability. Messages arriving during the pause window are silently dropped. The consensus fix: daemon always appends to a stable `inbox.jsonl.active` path; server atomically renames to timestamped archive and creates a fresh active file. No sleep/pause needed. This must be resolved as a design decision, not left as an open question.

### C. Split-brain / failover resolution is fragile
**Flagged by**: Security (CRIT-4), Scalability (Issue 1), Adversarial (CRIT-4)  
"Machine with most recent heartbeat wins" uses wall-clock time. Clock skew, NTP drift, or daylight saving transitions can cause incorrect split-brain resolution, leading to dual-primary state where messages are processed twice. The relay must be the authoritative arbiter using relay-assigned sequence numbers or fencing tokens, not wall-clock timestamps.

### D. Relay is an undocumented single point of failure
**Flagged by**: Security (Phase 2 concern), Scalability (Issue 1), Business (Risk table), Architecture (O1)  
Failover logic uses relay presence as oracle. Global relay outage kills all failover signals simultaneously. Relay HA requirements are undocumented. Reconnect storm risk at 100+ agents (no per-agentId jitter seeding documented).

### E. Inbox has no retention policy
**Flagged by**: Scalability (Issue 2), Privacy (CRITICAL-2), Adversarial (MED-1 via replay window), Architecture (R6 via key rotation gap)  
Append-only JSONL with no TTL, no rotation trigger, no archival policy. At production scale this is both a storage problem and a GDPR compliance problem. Privacy flags potential indefinite retention of personal data. Scalability projects 180MB/year per agent at modest volume. Needs a defined retention limit (suggested: 30 days or 50MB, configurable).

### F. Prompt injection via pipe session template
**Flagged by**: Security (CRIT-3), Adversarial (CRIT-3), Privacy (thread history in temp files)  
`{messageText}`, `{threadHistory}`, and `{fromName}` are embedded verbatim in the LLM system prompt. Trail of Bits (2025) documented >85% bypass success against preamble-only defenses. Multi-turn attack: turns 1-9 seed jailbreak fragments, turn 10 assembles override. Consensus fix: pass messages as tool results or structured data wrapped in `<data>` XML tags, never verbatim in the system prompt. Summarize thread history before injection via LLM.

### G. 5-minute pipe session timeout may be too short
**Flagged by**: Architecture (O5), DX (O4)  
Agents reading large codebases (multiple Grep + Read operations) can easily hit 5 minutes. Consensus: default 10 minutes, configurable, with warning alert at 8 minutes.

---

## 4. Critical Issues (Consolidated Blockers)

The following issues were flagged as CRITICAL, HIGH, or BLOCK-equivalent by at least one reviewer. All are pre-implementation blockers.

### BLOCK-1: Inbox Rotation Race Condition
- **Reviewers**: Architecture (C1), Adversarial (CRIT-1 — Priority 20/25), DX (Issue 3)
- **Risk**: Silent message loss, data corruption under concurrent write/rename
- **Fix**: Daemon appends to `inbox.jsonl.active` exclusively. Server atomically renames to `inbox.jsonl.TIMESTAMP`, creates fresh active file. No coordination sleep. This resolves Open Question 2.

### BLOCK-2: Pipe Session Prompt Injection
- **Reviewers**: Security (CRIT-3), Adversarial (CRIT-3 — Priority 20/25)
- **Risk**: CVE-2025-54794/54795 class — >85% bypass success documented. Arbitrary command execution via crafted threadline messages.
- **Fix**: Messages and thread history as tool results / `<data>`-wrapped structured data, never in system prompt. LLM-summarize history before injection. Sandboxed filesystem namespace for pipe sessions.

### BLOCK-3: Split-Brain / Dual-Primary on Network Partition
- **Reviewers**: Security (CRIT-4), Adversarial (CRIT-4 — Priority 15/25)
- **Risk**: Both machines promote to primary during partition, duplicate message processing, state divergence.
- **Fix**: Relay-side fencing tokens (monotonic epoch counter per agentId). Relay is sole authority for active-role grants. Machines default to STANDBY during partition.

### BLOCK-4: Shared Ed25519 Key Between Daemon and Server
- **Reviewers**: Security (CRIT-5)
- **Risk**: Daemon compromise = full agent identity compromise. Daemon only needs relay auth, not full signing authority.
- **Fix**: HKDF-derive daemon-specific sub-key: `HKDF-SHA256(IKM=master_key, info="daemon-relay-auth-v1")`. Server retains master key.

### BLOCK-5: HMAC Verification Timing Attack
- **Reviewers**: Security (CRIT-1)
- **Risk**: Standard string equality leaks timing, enabling key recovery over many attempts.
- **Fix**: Require `crypto.timingSafeEqual()` for all HMAC comparison. Mandate in Section 4.1 threat table.

### BLOCK-6: Unix Socket TOCTOU / Symlink Attack
- **Reviewers**: Security (CRIT-2), Adversarial (Nimbuspwn CVE-2022-29799/29800 reference)
- **Risk**: Per-message connect/close creates TOCTOU window. Symlink substitution intercepts wake signals.
- **Fix**: Use persistent connection instead of per-message connect/close. Add peer credential verification (`SO_PEERCRED` / `LOCAL_PEERCRED`). Resolve symlinks via `fs.realpathSync()` before socket operations.

### BLOCK-7: HMAC Key in launchd Environment (Adversarial High-Priority)
- **Reviewers**: Adversarial (HIGH-1 — Priority 12/25)
- **Risk**: `launchctl list` exposes env vars to any same-user process. HMAC key readable by npm packages, browser extensions.
- **Fix**: Read key from 0400 file at startup, or deliver via IPC handshake. Do not pass via env var in launchd plist.

### BLOCK-8: Pipe Session Classification Trivially Gameable
- **Reviewers**: Security (REC-4), Scalability (Issue 3), Architecture (C2), Adversarial (CRIT-2 — Priority 20/25), DX (O1)
- **Risk**: Any message avoiding keywords gets pipe-mode with Read/Glob/Grep access to full codebase, regardless of intent.
- **Fix**: Haiku-class LLM intent detection. Require IQS >= 70 for pipe-mode. Restrict file access to granted path list.

### BLOCK-9: Displaced Daemon Exit Code Unspecified
- **Reviewers**: Architecture (C3)
- **Risk**: If daemon exits with code 1 on displacement, launchd/systemd immediately respawns it, creating a tight reconnect loop.
- **Fix**: Specify exit code 0 for graceful displaced exit. Document required launchd plist and systemd unit configuration (`SuccessfulExitDisableThrottle` / `SuccessExit=0`).

### BLOCK-10: Public Availability Profile Leaks Behavioral Telemetry
- **Reviewers**: Privacy (CRITICAL-1)
- **Risk**: Uptime %, response latency, failover count, disconnect timestamps reveal operator schedule and device usage patterns. No consent mechanism.
- **Fix**: Gate behind explicit opt-in with disclosure, or publish only coarse availability bands.

---

## 5. Conflicts (Where Reviewers Disagree)

### Conflict 1: Persistent vs. Per-Message Unix Socket Connection
- **Security** flags per-message connect/close as a TOCTOU risk and recommends persistent connection.
- **Architecture** reviews the connect-send-close pattern favorably, noting it avoids connection state management.
- **Resolution**: Security's concern is valid but the fix is symlink resolution + peer credential verification, not necessarily a persistent connection. Both approaches are defensible. The spec should choose one explicitly and document the security rationale.

### Conflict 2: Pipe Session Model Selection (Open Question 1)
- **Architecture** recommends defaulting to Sonnet (cheaper, pipe sessions are definitionally simple).
- **DX** recommends defaulting to the agent's configured model with an override option for consistency.
- **Resolution**: Architecture's reasoning is stronger for cost and latency. Default to Sonnet-class; expose `pipeMode.model` override for operators needing consistency. This closes Open Question 1.

### Conflict 3: Inbox `appendFileSync` Atomicity
- **Architecture** states `fs.appendFileSync` is atomic for local filesystems and rates it "Correct."
- **Security** (REC-5) flags it as not truly atomic on all filesystems (crash mid-write produces partial JSONL line).
- **Scalability** flags it as blocking the event loop at >100 msg/sec.
- **Resolution**: For Phase 1, local filesystem use is fine. Document: write to temp file then rename for crash safety, and plan async migration at higher volumes. Caveat: NFS/network mounts break the guarantee — add to deployment docs.

### Conflict 4: Node.js vs. Go for Daemon
- **Architecture** favors Node.js for code reuse with Instar, notes Go would be cleaner but adds a build dependency.
- **Adversarial** explicitly recommends Node.js from a security standpoint (better runtime type safety, audited dependency tree).
- **Business** (implicit) favors keeping the stack unified.
- **Resolution**: No genuine conflict — both reviewers land on Node.js. Open Question 4 can be closed: Node.js is correct.

---

## 6. Gaps (Areas No Reviewer Covered Adequately)

### Gap 1: Relay Protocol Specification
No reviewer analyzed the wire protocol between daemon and relay in depth. What does the relay's WebSocket API look like? What messages does it send/receive? What authentication handshake is used? The spec references this throughout but never specifies it. If the relay is a production dependency, its API contract needs documentation.

### Gap 2: Cold Start Sequence (Adversarial mentioned briefly)
Adversarial flags "cold start: poll cursor before inbox exists → crash" as an edge case but doesn't elaborate. No reviewer analyzed the full cold start sequence: first-time setup, identity generation, relay registration, inbox initialization order, and what happens when each step fails.

### Gap 3: Multi-Agent on Same Machine
The spec focuses on single-agent deployments with multi-machine failover. No reviewer addressed the case where multiple agents (Echo + Dawn) run on the same machine. Shared relay, shared filesystem, socket namespace collisions, HMAC key isolation between agents — none addressed.

### Gap 4: Dependency Audit
No reviewer listed concrete Node.js package dependencies the daemon will introduce and their security/maintenance posture. The daemon is described as "~300 LOC" but its dependency footprint could be significant.

### Gap 5: Testing Strategy
No reviewer addressed how the daemon will be tested. Integration tests for Unix socket IPC, relay reconnection, failover scenarios, and inbox rotation are non-trivial to write. Given the auto-memory note ("Always write regression tests"), this gap should be filled before implementation.

### Gap 6: A2A Protocol Compatibility Analysis
Business flagged A2A as a strategic risk, but no reviewer analyzed the technical compatibility gap in depth. What would it take to add an A2A bridge? Is the relay protocol an obstacle or an implementation detail?

---

## 7. Prioritized Action Items

Ordered by frequency × severity across all reviews. Items with multiple reviewer citations are de-duplicated.

### Tier 1 — Must Fix Before Implementation (Blockers)

1. **Resolve inbox rotation race condition** — Define the active/archive naming convention and atomic rename protocol. Close Open Question 2. [Architecture-C1, Adversarial-CRIT-1, DX-Issue3, Scalability-Issue2]

2. **Replace keyword pipe classifier with Haiku-class LLM** — Single classification call (~200ms). Prompt: "Does this require modifying files, running commands, or multi-step work?" [Security-REC4, Scalability-Issue3, Architecture-C2, Adversarial-CRIT2, DX-O1]

3. **Fix pipe session prompt injection** — Pass messages as tool results or `<data>`-wrapped data, never verbatim in system prompt. LLM-summarize thread history before injection. [Security-CRIT3, Adversarial-CRIT3]

4. **Fix split-brain resolution** — Relay-assigned fencing tokens replace wall-clock tie-breaker. Machines default to STANDBY during partition. [Security-CRIT4, Adversarial-CRIT4]

5. **Specify displaced daemon exit code** — Exit code 0. Document launchd/systemd configuration to prevent spurious respawn. [Architecture-C3]

6. **Derive daemon-specific sub-key via HKDF** — Separate relay auth capability from full agent identity. [Security-CRIT5]

7. **Mandate constant-time HMAC comparison** — `crypto.timingSafeEqual()` in all verification paths. [Security-CRIT1]

8. **Fix HMAC key delivery** — Read from 0400 file at startup, not via launchd env var. [Adversarial-HIGH1]

9. **Fix Unix socket TOCTOU** — `fs.realpathSync()` before socket operations. Add peer credential verification. Decide persistent vs. per-message connection and document rationale. [Security-CRIT2, Adversarial]

10. **Define inbox retention policy** — Maximum 30 days or 50MB (configurable). Implement rotation with deletion. [Privacy-CRIT2, Scalability-Issue2]

### Tier 2 — Should Fix Before Phase 1 Deployment (High Priority)

11. **Gate behavioral telemetry in public profile** — Opt-in with disclosure or coarse availability bands only. [Privacy-CRIT1]

12. **Specify `instar listener status` output format** — State, PID, uptime, relay connection state, last message time, log tail. [DX-Issue2]

13. **Add `instar listener doctor` command** — Pre-flight check: identity, relay reachability, inbox writable, HMAC key, launchd available. [DX-R1]

14. **Define poll cursor implementation** — Byte offset persisted to `{stateDir}/threadline/inbox.cursor`. Advance atomically after each successful route. [Architecture-R1, Adversarial-edge-cases]

15. **Specify HTTP error handling pre-WebSocket-upgrade** — 401: stop retrying, alert user. 503/429: longer backoff. [Architecture-R2]

16. **Seed reconnect jitter from agentId hash** — Prevents thundering herd at 100+ agents. [Scalability-Issue1, Architecture-research]

17. **Persist replay dedup cache to SQLite** — In-memory cache lost after >10min downtime enables replay attacks. [Adversarial-MED1]

18. **Add displaced event to Attention Queue** — Alert user with context about displacing connection IP. [Security-REC2, Adversarial-HIGH2]

19. **Resolve config namespace collision** — Unify `listener.*` vs. `threadline.listener.*`. [DX-Issue4]

20. **Define right-to-erasure pathway** — `instar listener purge` command covering inbox, thread history, pipe session logs. [Privacy-REC5]

### Tier 3 — Should Fix Before Phase 2/3 (Medium Priority)

21. **Document relay HA requirements** — Relay is a SPOF for failover; HA prerequisites need specification. [Scalability, Business]

22. **Define offline queue TTL** — 1 hour default, configurable. Surface in `status` output. Close Open Question 6. [Architecture-R3, DX-R5]

23. **Address A2A compatibility** — Add section acknowledging HTTP/SSE ecosystem or principled argument for custom protocol. Consider A2A bridge as Phase 5. [Business-Issue1]

24. **HMAC over ThreadResumeMap entries** — Prevent Machine B from resuming tampered state after failover. [Adversarial-MED2]

25. **Increase pipe session timeout** — Default 10 minutes, configurable, with 8-minute warning alert. [Architecture-O5, DX-O4]

26. **Document tmux as hard dependency** — Or provide `child_process.spawn` fallback path. [Architecture-O2, Adversarial-edge-cases]

27. **Pipe session log rotation** — Unbounded growth for high-volume agents. [Scalability]

28. **Health snapshot on state transitions** — Write on connect/disconnect/reconnect events, not only on 10-minute cadence. Add `snapshotAge` field. [Architecture-O6]

29. **Add sustainability model to spec** — Relay operating cost, ownership, revenue path. [Business-Issue2]

30. **IQS decay without re-verification** — Trust accumulation attack: 30 days benign messages → pipe-mode access. IQS should decay without active re-verification. [Adversarial-social-engineering]

31. **Privacy analysis for ThreadResumeMap git sync** — Assess whether entries constitute personal data; apply data minimization and retention limits. [Privacy-CRIT3]

32. **Add external name / product narrative** — "Persistent Listener Daemon" is not a product name. Consider Anchor or Vigil. Surface the 15min→30s failover, 21+ hr uptime metrics as headlines. [Marketing]

---

## 8. Open Questions Resolved (Section 11 Consolidation)

The spec lists 7 open questions. Based on reviewer consensus:

### OQ-1: Pipe session model — Sonnet or agent's configured model?
**Recommended answer: Sonnet-class by default, configurable via `pipeMode.model`.**  
Architecture: pipe sessions are definitionally for simple, fast responses; using Opus for a "yes/no" reply is resource waste. DX: expose override for operators needing consistency. Set default in spec, close the question.

### OQ-2: Inbox rotation protocol — 100ms pause or server-side rename?
**Recommended answer: Server-side atomic rename with stable active path. No pause.**  
Daemon always appends to `inbox.jsonl.active`. Server renames `inbox.jsonl.active` → `inbox.jsonl.TIMESTAMP` and creates fresh `inbox.jsonl.active`. Daemon's subsequent appends to the stable path always succeed. No coordination sleep. No TOCTOU window. This is a design decision, not an open question. [Architecture-C1, Adversarial-CRIT1]

### OQ-3: ThreadResumeMap sync — relay-based or git-only?
**Recommended answer: Relay-based as primary, git as eventual-consistency backup.**  
Git sync adds 5-30s latency. Relay-based propagation is necessary to meet the <30s failover target. Git sync is acceptable for eventual consistency during extended relay downtime. Architecture notes: if session resume isn't required on the first message after failover, a fresh interactive session is acceptable, with resume on second message. [Scalability, Architecture-O3]

### OQ-4: Daemon language — Node.js or Go?
**Recommended answer: Node.js.**  
Both Architecture and Adversarial independently recommend Node.js. Code reuse with Instar outweighs the ~30-50MB RSS overhead. Go adds a build dependency with limited benefit at this scale. [Architecture, Adversarial]

### OQ-5: Pipe session filesystem access scope?
**Recommended answer: Grant-list restricted, not full codebase.**  
Adversarial: current spec gives Read/Glob/Grep access to full codebase for any pipe-mode session. Restrict to a configured list of granted paths. Combined with LLM intent classifier and IQS >= 70 requirement. [Adversarial-CRIT2, Security-REC4]

### OQ-6: Offline queue TTL?
**Recommended answer: 1 hour default, configurable.**  
Messages older than 1 hour are almost certainly stale for agentic workflows. Architecture and DX both point to this as the obvious answer. Surface in `instar listener status` output. [Architecture-R3, DX-R5]

### OQ-7: Pre-warm Machine B's IQS cache before failover?
**Recommended answer: No — include IQS cache in git-synced state directory.**  
Architecture: IQS cache is likely small enough (<50 known peers) to be part of the synced state directory. Pre-warming via relay adds complexity not justified until the cache miss problem is observed in production. Implement as a Phase 4 optimization if needed. [Architecture-O4]

---

## 9. Scalability Summary Table — Phase-by-Phase Consensus View

| Phase | Agents | Key Constraints | Bottlenecks | Status |
|-------|--------|-----------------|-------------|--------|
| **MVP (Phase 1)** | 1-50 | Local FS, single relay node | None significant at this scale | Ready after blockers fixed |
| **Growth (Phase 2)** | 50-500 | Git sync latency vs failover budget; inbox rotation races; tmux aggregate | Relay as SPOF; `appendFileSync` event-loop blocking at >100 msg/sec; inbox unbounded growth | Needs relay HA plan, inbox rotation, async inbox writes |
| **Scale (Phase 3)** | 500-5000 | Relay clustering required; JSONL → SQLite migration | JSONL scanning O(n); git sync incompatible with <30s failover; file-based inboxes can't support horizontal distribution | Requires architecture evolution (relay clustering, SQLite inbox) |
| **Viral (Phase 4)** | 5000+ | Relay redesign; horizontal inbox distribution | Reconnect storm (jitter seeding critical); file-based storage can't support horizontal scale; git sync a non-starter | Requires relay redesign and storage migration — not in current spec scope |

**Consensus**: The architecture is appropriate for Phase 1 (MVP) and Phase 2 (Growth) with the rotation and retention fixes. Phase 3+ requires explicit architectural evolution beyond this RFC's scope. The spec correctly stays within its design envelope.

**Compute ceiling**: 5 concurrent pipe sessions × ~3.2s average latency ≈ 1.5 messages/second sustained throughput. Adequate for agent-to-agent coordination workloads.

**Relay dependency boundary**: Relay is in the failover signaling path, not the message delivery path. This is a clean separation. Relay downtime degrades failover from 30s to 15min (heartbeat fallback) but does not stop message delivery.

---

## Appendix: Reviewer Attribution Matrix

| Issue | Sec | Scal | Biz | Arch | Priv | Adv | DX | Mkt |
|-------|-----|------|-----|------|------|-----|----|-----|
| Inbox rotation race | | ✓ | | ✓ | | ✓ | ✓ | |
| Keyword classifier | ✓ | ✓ | | ✓ | | ✓ | ✓ | |
| Prompt injection | ✓ | | | | | ✓ | | |
| Split-brain fragility | ✓ | ✓ | | | | ✓ | | |
| Relay SPOF | | ✓ | ✓ | ✓ | | | | |
| Inbox retention | | ✓ | | | ✓ | | | |
| HMAC timing attack | ✓ | | | | | | | |
| Key sharing daemon/server | ✓ | | | | | | | |
| HMAC key in env var | | | | | | ✓ | | |
| Socket TOCTOU | ✓ | | | | | ✓ | | |
| Exit code unspecified | | | | ✓ | | | | |
| Behavioral telemetry | | | | | ✓ | | | |
| No getting started path | | | | | | | ✓ | |
| Status output unspecified | | | | | | | ✓ | |
| A2A compatibility | | | ✓ | | | | | ✓ |
| No product name | | | ✓ | | | | | ✓ |
| 5-min timeout too short | | | | ✓ | | | ✓ | |
| Pipe session timeout | | | | ✓ | | | ✓ | |
| ThreadResumeMap latency | | ✓ | | ✓ | ✓ | | | |
