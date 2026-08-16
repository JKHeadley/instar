# Architecture Review: Persistent Listener Daemon
**Review ID:** 20260405-135742  
**Round:** 1  
**Reviewer:** Systems Architect  
**Spec:** `specs/persistent-listener-daemon.md`  
**Date:** 2026-04-05

---

## Approval Status

**CONDITIONAL APPROVE** — The architecture is fundamentally sound. The four-component design is well-reasoned, the security model is thorough, and the phased migration is cleanly reversible. Several issues need resolution before implementation begins, none of which require a redesign.

---

## Score: 8.0 / 10

Strong spec. Loses points on: inbox race condition underspecification, string-based pipe session routing (hard-coded keyword matching), Unix socket reconnection protocol ambiguity, and the thread-resume sync strategy being optimistic about git latency.

---

## Research Findings

### Process Supervision (launchd / systemd)

The spec's use of launchd/systemd is appropriate. Both support automatic restart with configurable backoff. The critical requirement — confirmed by Apple's own documentation — is that daemons **must not daemonize themselves**; launchd manages process lifecycle and expects the process to run in the foreground. The spec's "single-file Node.js script" approach satisfies this.

**Best practice alignment:**
- `Restart=on-failure` (systemd) is the right choice for a daemon that should recover from crashes but not loop on intentional exits (displaced case). The spec correctly handles the displaced case by NOT reconnecting — this needs to translate to a clean process exit (exit code 0) so systemd/launchd don't immediately respawn it. The spec does not specify this exit code behavior, which is a gap.
- launchd's `ThrottleInterval` (default 10s) and systemd's `RestartSec` should be configured to match the daemon's own exponential backoff rather than fighting it. Otherwise you get double-backoff: the daemon's internal 1s backoff fires before launchd's 10s throttle expires.

### Unix Domain Socket IPC

The spec's choice of Unix domain sockets for the wake signal is the correct call over alternatives:

| Mechanism | Latency | Reliability | Complexity |
|-----------|---------|-------------|------------|
| Unix socket (connect-send-close) | <1ms | High | Low |
| Named pipe (fifo) | <1ms | Medium (SIGPIPE risk) | Medium |
| fs.watch on sentinel file | ~50ms | Medium (fs.watch edge cases on macOS) | Low |
| inotify/FSEvents directly | ~1ms | High | High |

Unix domain sockets with 0600 permissions are the right tool. The `connect -> send 1 byte -> close` pattern described is appropriate — no persistent connection means no connection state to manage. Node.js `net` module handles this natively.

One note: `fs.watch` on macOS (the fallback) has a known issue where events can coalesce under load. The fallback is acceptable for a degraded path but should not be relied on for correctness guarantees.

### WebSocket Relay Reconnection Patterns

The spec's backoff parameters (1s base, 2x multiplier, 60s max, 25% jitter) align with production best practices. Relay operators recommend:
- Jitter on reconnect to prevent thundering herd (25% is appropriate)
- Cap around 60s (the spec matches)
- Heartbeat/keepalive ping to detect half-open connections (30s interval is standard)

The **displaced** state handling is a strength: gracefully yielding when the relay reports another connection for the same agentId is exactly correct. This prevents connection storms when multiple instances of the same agent start simultaneously.

One gap: the spec does not specify behavior when the relay itself returns an HTTP error (401, 503, etc.) before the WebSocket upgrade completes. These require different handling than post-upgrade disconnects.

### JSONL Inbox Pattern (File-Based Message Queue)

The inbox pattern being implemented here is a recognized distributed systems primitive (transactional inbox). The JSONL append-only format with HMAC integrity checking is a sound implementation.

Key property: `fs.appendFileSync` is synchronous and atomic at the OS level for small writes on local filesystems, which provides the needed guarantee. However, **NFS or network-mounted filesystems break this guarantee** — worth noting in deployment docs even if not an immediate concern.

The poll cursor pattern for crash recovery (tracking last-processed position) is essential and the spec references it in the glossary but does not detail the cursor implementation. This is an implementation gap that could cause message re-processing after crash recovery if not addressed explicitly.

---

## Critical Issues

### C1: Inbox Rotation Race Condition is Underspecified

**Section 11, Open Question 2**

The proposed solution (server sends ROTATE signal, daemon pauses 100ms, server renames) is described as a question, not a decision — but it's the most dangerous data integrity risk in the spec. A 100ms sleep is not a safe synchronization primitive. If the daemon is in the middle of `appendFileSync` when the rename happens, the entry goes to the old file. If the server is processing from the old file while the daemon writes to the new file, the server might miss entries.

**Required resolution before implementation:** Define a concrete rotation protocol. A safe option: the daemon always writes to a fixed `inbox.jsonl` path. Rotation is the server's responsibility and uses `rename(inbox.jsonl, inbox-TIMESTAMP.jsonl)` atomically, then continues reading from the new empty file. The daemon's `appendFileSync` to `inbox.jsonl` will always succeed because the path is stable — the rename doesn't affect subsequent appends. The server reads rotated files in order, processes them, and deletes them.

### C2: Pipe Session Routing Uses String Keyword Matching

**Section 3.3, Decision Logic**

The decision tree uses keyword matching (`"build"`, `"implement"`, `"fix"`, `"deploy"`, `"review"`, `"analyze"`) to classify messages as requiring interactive sessions. This is a brittle pattern: it silently fails on synonyms, non-English agents, rephrased intent, or novel phrasings. An agent saying "please make this change" or "can you update the code?" bypasses the safety guard and gets a read-only pipe session.

**Required resolution:** Replace keyword matching with a lightweight LLM classification call (Haiku-class model) as a preprocessing step. The call is cheap, fast (~200ms), and actually understands intent. The classification prompt is simple: "Does this message require modifying files, running commands, or complex multi-step work? Answer yes or no." This is exactly the case where intelligence beats string matching.

### C3: Exit Code Contract for Displaced State Not Specified

**Section 3.2, Connection Management**

The spec says the daemon "yields gracefully (no reconnect)" when displaced. But what exit code does it use? If it exits with code 1, launchd/systemd will immediately respawn it, which will immediately get displaced again, creating a tight respawn loop. If it exits with code 0 and the process manager is configured with `SuccessfulExit = false` (launchd) or `Restart=on-failure` (systemd), it stays down correctly.

**Required resolution:** Specify exit code 0 for graceful displaced exit. Document the required launchd plist (`SuccessfulExitDisableThrottle`) and systemd unit (`SuccessExit=0`) configuration to prevent spurious respawn.

---

## Recommendations

### R1: Specify Poll Cursor Implementation

The glossary mentions "poll cursor" but Section 7.2 references it only obliquely ("Entry stays in inbox. Next poll cycle retries"). Without a concrete cursor implementation, a crash between inbox write and cursor advance causes message re-processing. Define: cursor = byte offset of last successfully processed entry, persisted atomically to `{stateDir}/threadline/inbox.cursor` after each successful route.

### R2: Clarify HTTP Error Handling Pre-WebSocket-Upgrade

Section 3.2's state machine handles post-connection failures well but doesn't cover HTTP-level rejections (401 Unauthorized, 503 Service Unavailable, 429 Rate Limited) that occur before the WebSocket connection is established. 401 should trigger "alert user, stop retrying" behavior. 503/429 should use longer backoff intervals. The current state machine merges all failures into a single backoff path.

### R3: Define Offline Queue TTL (Open Question 6)

Open Question 6 asks what the relay's offline queue TTL should be. This is not a hard question — 1 hour is the right default for an agent coordination system. Messages older than 1 hour are almost certainly stale for agentic workflows. Leave it configurable but set the default and close the question.

### R4: Pipe Session Model Default

Open Question 1 asks whether pipe sessions should use Sonnet or the agent's configured model. The answer is Sonnet (or cheaper). Pipe sessions are definitionally for simple, fast responses. Using the agent's configured model (which could be Opus) for a "yes/no, I'll handle this in a full session" reply is resource waste. Document the override path if an operator needs consistency.

### R5: Consider Abstract Unix Sockets on Linux

On Linux, the socket can use the abstract namespace (`\0instar-listener-{agentId}`) rather than a file path. This eliminates the stale socket file problem if the server crashes without unlinking. macOS doesn't support abstract sockets, so this would be Linux-only. Worth noting in the implementation notes for cross-platform robustness.

### R6: Inbox HMAC Key Rotation Strategy

The HMAC key is derived from `authToken` via HKDF. If `authToken` changes (user regenerates credentials), all existing inbox entries become unverifiable. The spec doesn't address this. Define: on authToken rotation, flush and re-sign the inbox, or maintain a small key history (last 2 keys) for verification grace period.

### R7: Document Daemon Node.js Version Requirement

The daemon uses `fs.appendFileSync`, `net.createServer`, and `crypto` for HMAC. These are all stable APIs, but the minimum Node.js version should be pinned in the implementation. Instar's current requirement should carry over explicitly into the daemon's package metadata.

---

## Observations

### O1: The "Degraded Fallback" Server Relay Client is Unclear

The architecture diagram shows a "Relay Client (degraded fallback)" inside the agent server. The spec doesn't describe how the server knows to use its embedded client vs. defer to the daemon. Is this a config flag? A daemon health check on startup? Does the server try the Unix socket first and fall back if the daemon isn't present? This needs to be specified — the fallback path is important for the migration period.

### O2: Pipe Session tmux Dependency

Pipe sessions are spawned via `tmux new-session -d`. This creates an undocumented dependency on tmux being installed. The spec should either (a) document tmux as a hard dependency for pipe mode, or (b) provide a non-tmux path using `child_process.spawn` with a detached process group. The tmux approach is reasonable for agent environments but unexpected as an implicit production dependency.

### O3: Cross-Machine ThreadResumeMap Sync Latency (Open Question 3)

The spec proposes git sync for ThreadResumeMap replication and asks if relay-based replication is needed. For the <30s failover target, git sync is borderline: a commit+push+pull cycle takes 5-15 seconds under ideal conditions and can take much longer on slow connections. If failover takes 10-30s (relay detection) + 10-15s (git sync) = 20-45s, the target is barely met in the best case. Consider whether session resume is required on first message after failover or can be deferred (Machine B starts a fresh interactive session, resumes on second message after git sync completes).

### O4: MoltBridge IQS Cache Warm-Up (Open Question 7)

Open Question 7 asks about pre-warming Machine B's IQS cache before failover. The solution is simpler than described: the IQS cache should be part of the git-synced state directory if it's small enough (likely yes for deployments with <50 known peers). Pre-warming via relay adds complexity that isn't justified until the cache miss problem is observed in production.

### O5: The 5-Minute Pipe Session Timeout May Be Too Short

For an agent responding to a threadline query that requires reading a large codebase (multiple `Grep` + `Read` operations), 5 minutes could be tight. The timeout should be configurable and the default should probably be 10 minutes with a warning alert at 8 minutes. The 5-minute default appears inherited from a simpler use case.

### O6: Health Snapshot Write Frequency

The health snapshot is written every 10 minutes. This means the `/listener/health` endpoint can return data up to 10 minutes stale. If the daemon crashed 9 minutes ago, the health endpoint still shows "connected." Write the health snapshot on state transitions (connected, disconnected, reconnecting) in addition to the 10-minute cadence. Include a `snapshotAge` field so consumers can detect stale data.

---

## Scalability Assessment

This architecture is designed for single-agent deployments with optional multi-machine failover. That is the correct scope.

**Horizontal scaling ceiling:** The design is intentionally not horizontally scalable in the traditional sense. One daemon per machine, one agent server per machine, one relay connection per agent. Appropriate.

**Message throughput:** At typical agentic workloads (dozens to hundreds of messages per day), the JSONL inbox is trivially small. At 1000 messages/day at ~500 bytes each, the inbox grows at ~500KB/day. Inbox archival strategy should be documented separately from log rotation.

**Concurrency ceiling for pipe sessions:** 5 concurrent pipe sessions at ~3.2s average latency handles ~1.5 messages/second sustained — adequate for agent-to-agent coordination workloads.

**Relay dependency:** Fast failover takes a hard dependency on the Threadline relay (Fly.dev) for presence signaling. If the relay is down, failover falls back to the 15-minute heartbeat path — acceptable and correctly documented. The relay is not in the critical path for message delivery itself, only for failover signaling. This is a clean dependency boundary.

---

## Technology Choices Assessment

| Choice | Verdict | Notes |
|--------|---------|-------|
| Node.js for daemon | Appropriate | Code reuse with Instar outweighs ~30-50MB RSS overhead. Go binary would be cleaner but adds a build dependency. |
| launchd/systemd for supervision | Correct | Platform-native, battle-tested. No reason to use a third-party supervisor here. |
| Unix domain socket for wake signal | Correct | Right tool. Fast, secure, no polling. |
| fs.appendFileSync for inbox writes | Correct | Atomic for local filesystems. Acceptable risk. |
| JSONL inbox format | Correct | Human-readable, append-friendly, crash-recoverable with cursor. |
| HMAC-SHA256 with HKDF key derivation | Correct | Cryptographically sound. |
| tmux for pipe session isolation | Questionable | Adds undocumented dependency. Worth evaluating child_process alternative. |
| Keyword matching for pipe routing | Wrong | Must be replaced with LLM classification. See C2. |

---

## Summary

The architecture closes a real gap (relay connection coupled to server lifecycle, 15-minute failover, polling latency) with a clean, incrementally deployable design. The security model is well-thought-out. The migration path is conservative and reversible at every phase.

Three issues require resolution before Phase 1 begins: the inbox rotation race (C1), the pipe session routing classifier (C2), and the displaced daemon exit code contract (C3). The remaining recommendations are improvements, not blockers.

The open questions in Section 11 are mostly answerable now — the spec author should close them in a revision rather than leaving them as review fodder.

**Recommended action:** Address C1-C3, close open questions 1/4/6, then proceed to Phase 1 implementation.
