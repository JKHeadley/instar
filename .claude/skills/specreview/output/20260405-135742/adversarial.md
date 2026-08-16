# Adversarial Review — Persistent Listener Daemon RFC

**Reviewer**: Red Team Specialist
**Review ID**: 20260405-135742
**Round**: 1
**Date**: 2026-04-05

---

### Approval Status: CONDITIONAL APPROVE

### Score: 6.5/10

---

### Research Findings

- **WebSocket relay attacks:** CVE-2024-55591 (auth bypass in Node.js WebSocket, exploited in wild 2025). Cross-Site WebSocket Hijacking against GraphQL-over-WebSocket demonstrated April 2025.
- **File-based queue TOCTOU:** GHSA-w853-jp5j-5j7f and GHSA-qmgc-5h2g-mvrw (filelock ecosystem, recurring CVEs) apply directly to inbox rotation.
- **PID file races:** "Don't Trust the PID" research (WarCon 2018) and polkit CVE-2025-67859 show PID reuse attacks against daemon management.
- **Unix socket symlink:** Nimbuspwn (CVE-2022-29799/29800) combined directory traversal with symlink races against systemd for root privilege escalation.
- **launchd env leak:** CVE-2018-4280 — `launchctl list` exposes environment variables from plist to any local process.
- **LLM prompt injection:** CVE-2025-54794/54795 (InversePrompt / Claude Code command injection) — >85% bypass success against Claude Sonnet with adaptive strategies.

---

### Critical Issues

**CRIT-1: Inbox Rotation Race Condition (TOCTOU)** — Likelihood 4/5 × Impact 5/5 = Priority 20
- Open Question 2's "100ms pause" protocol is textbook TOCTOU. Messages arriving during pause are silently dropped. Delayed rename causes daemon to write to archived path.
- **Fix:** Daemon always appends to `inbox.jsonl.active`, server atomically renames to `inbox.jsonl.TIMESTAMP` and creates fresh active file. No sleep/pause needed.

**CRIT-2: Pipe Session Classification Is Trivially Gameable** — Likelihood 5/5 × Impact 4/5 = Priority 20
- Keyword filter easily evaded. "Could you take a look at what's in the config" → routes to pipe-mode, gets Read/Glob/Grep access to full codebase.
- **Fix:** Haiku-class LLM intent detection. Restrict file access to granted path list. Require IQS >= 70 for pipe-mode.

**CRIT-3: Thread History Is Unmitigated Prompt Injection Vector** — Likelihood 5/5 × Impact 4/5 = Priority 20
- Thread history injected verbatim adjacent to CONSTRAINTS block. Multi-turn attack: turns 1-9 seed jailbreak fragments, turn 10 assembles complete override. >85% bypass success documented.
- **Fix:** Summarize thread history via LLM before injection. Wrap in XML `<data>` tags with explicit untrusted-content instruction. Never pass verbatim attacker content adjacent to instruction context.

**CRIT-4: Split-Brain Resolution Is Logically Circular** — Likelihood 3/5 × Impact 5/5 = Priority 15
- During network partition, Machine B can't query relay presence, falls back to heartbeat. Machine A still writing heartbeats. Both promote → dual-primary, messages processed twice.
- **Fix:** Relay-side fencing tokens (monotonic epoch counter per agentId). Only relay can grant active status. Default to STANDBY during partition.

---

### High-Priority Issues

**HIGH-1: launchd Plist Leaks HMAC Key** — Priority 12
- `launchctl list` exposes env vars to any same-user process. `INSTAR_INBOX_HMAC_KEY` readable by npm packages, browser extensions.
- **Fix:** Read key from 0400 file at startup, or deliver via IPC handshake. Phase 1 prerequisite.

**HIGH-2: Adversarial Displacement / Connection Seizure** — Priority 12
- Stolen Ed25519 identity → attacker connects, legitimate daemon yields permanently (spec says "no reconnect" on displaced).
- **Fix:** 30-second grace period before honoring displacement. Alert user immediately with connecting IP. Treat as security incident.

**HIGH-3: Pipe Session Zombie Risk / Session Name Collision** — Priority 9
- `pipe-{threadId-8}` uses 8 hex chars. 2s post-spawn check doesn't verify claude subprocess started. Process group kill not used.
- **Fix:** Full UUID for tmux name. PID verification post-spawn. `kill -9 -PGID` on timeout.

---

### Medium-Priority Issues

- **MED-1:** Replay window on restart — in-memory dedup cache lost after >10min downtime. Fix: persist to SQLite.
- **MED-2:** Failover inherits poisoned state — Machine B resumes tampered ThreadResumeMap entries. Fix: HMAC over map entries.
- **MED-3:** Health file information disclosure — `relaySessionId` + timestamps readable in shared environments. Fix: 0600 permissions, omit sessionId.
- **MED-4:** Failover storm via presence churn — repeated connect/disconnect generates evaluation load. Fix: rate-limit to one eval per agentId per 60s.

---

### Social Engineering Scenarios

- **Trust accumulation:** 30 days of benign messages → IQS "strong" → pipe-mode access to codebase. Fix: IQS decay without re-verification.
- **Agent name squatting:** Register `fromName = "dawn"`. Fix: always display `fromName (fingerprint: abc123...)`.
- **Multi-turn history seeding:** Jailbreak distributed across 10 innocuous turns. Fix: summarize history before injection.

---

### Edge Cases

- Cold start: poll cursor before inbox exists → crash
- Identity rotation mid-connection: daemon holds old keypair, displaced without explanation
- tmux not installed: pipe sessions silently fail
- Concurrent inbox readers during failover: both machines process same entries

---

### Observations

- HMAC-signed inbox is the strongest defensive element. Cryptographic boundary at file layer is correct.
- Node.js vs Go (Open Question 4): Node.js is correct from security standpoint — better runtime type safety and audited dependency tree.
- Circuit breaker table (Section 7.4) is comprehensive and shows mature operational thinking.
- Phase 4 (cross-machine sync) deserves its own dedicated RFC rather than being bundled.
