# Security Review — Persistent Listener Daemon RFC

**Reviewer**: Security Specialist
**Review ID**: 20260405-135742
**Round**: 1
**Date**: 2026-04-05

---

### Approval Status: CONDITIONAL

---

### Critical Issues (must fix before building)

**CRIT-1: HMAC verification timing attack** (Severity: HIGH)
- **Section**: 4.1, 3.2 (Inbox write protocol)
- The spec doesn't mandate `crypto.timingSafeEqual()` for HMAC comparison. Standard string equality leaks timing information, enabling key recovery over many attempts.
- **Fix**: Explicitly require constant-time comparison for all HMAC verification. Add to Section 4.1 threat table.

**CRIT-2: Unix socket TOCTOU/symlink attack** (Severity: HIGH)
- **Section**: 3.4 (Event-Driven Inbox Wakeup)
- The daemon reconnects on every message (per-message connect/send/close pattern). Each reconnect is a TOCTOU window. If an attacker replaces the socket file with a symlink between creation and connection, they can intercept wake signals.
- stateDir must use `fs.realpathSync()` before socket operations. Peer credential verification (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` on macOS) is absent.
- **Fix**: Use a persistent connection instead of per-message connect/close. Add peer credential verification. Resolve symlinks before socket operations.

**CRIT-3: Pipe session prompt injection** (Severity: HIGH)
- **Section**: 3.3 (Pipe-Mode Session Support — Prompt template)
- `{messageText}`, `{threadHistory}`, and `{fromName}` are embedded verbatim in the LLM prompt. A crafted message can override the security preamble. Trail of Bits (2025) documented `--allowedTools` bypass via argument injection. The spec's preamble-only defense is insufficient.
- **Fix**: Messages must be passed as tool results or structured data, NOT embedded in the system prompt. Add output filtering for pipe sessions. Consider sandboxing pipe sessions in a restricted filesystem namespace.

**CRIT-4: Split-brain tie-breaker is fragile** (Severity: HIGH)
- **Section**: 3.5 (Fast Failover — Split-brain prevention)
- "Machine with most recent heartbeat wins" uses wall-clock time, which breaks under clock skew between machines. NTP drift or daylight saving transitions could cause incorrect resolution.
- **Fix**: Relay must be the authoritative arbiter. Use relay-assigned sequence numbers or logical clocks instead of wall-clock timestamps. Add explicit distributed lock via relay for role transitions.

**CRIT-5: Ed25519 identity key shared between daemon and server** (Severity: HIGH)
- **Section**: 4.3 (Key Management)
- Both processes hold the same private signing key in memory. Daemon compromise = full agent identity compromise. The daemon only needs relay auth capability, not full signing authority.
- **Fix**: Derive a daemon-specific sub-key for relay authentication only. Use HKDF to derive a purpose-specific key: `HKDF-SHA256(IKM=master_key, info="daemon-relay-auth-v1")`. Server retains master key for full operations.

---

### Recommendations (should fix, not blocking)

**REC-1: Pipe session temp files in world-readable /tmp** (Severity: MEDIUM)
- **Section**: 3.3 (Pipe-mode spawn protocol)
- Prompt files written to `/tmp/instar-threadline/` are potentially world-readable. Other processes on the machine can read threadline message content.
- **Fix**: Use `mkdtemp()` with 0700 permissions, or write to `{stateDir}/tmp/` which is user-owned.

**REC-2: Displaced events should alert, not just log** (Severity: MEDIUM)
- **Section**: 7.1 (Listener Daemon Failures)
- A `displaced` event means another entity is authenticating as this agent. This could be legitimate (multi-machine) or could indicate key compromise. Currently only logged.
- **Fix**: Route `displaced` events to the Attention Queue with context about the displacing connection.

**REC-3: IQS band should never override local trust for security routing** (Severity: MEDIUM)
- **Section**: 5.2 (Trust-informed pipe session routing)
- The spec allows IQS band to influence session type selection. A high IQS score from MoltBridge should not override a locally-assigned low trust level.
- **Fix**: Add explicit rule: `effectiveTrust = min(localTrust, iqsTrust)`. Local trust is the ceiling, never the floor.

**REC-4: Keyword-based pipe classification is brittle** (Severity: MEDIUM)
- **Section**: 3.3 (Decision logic — task indicators)
- Keywords like "build", "implement", "fix" are easy to evade. An attacker could craft messages that avoid these keywords but still request dangerous operations.
- **Fix**: Use a Haiku-class LLM classifier instead of keyword matching. Consistent with the spec's own "Intelligence Over String Matching" principle from CLAUDE.md.

**REC-5: Inbox JSONL atomic append is not truly atomic** (Severity: LOW)
- **Section**: 3.2 (Inbox write protocol)
- `fs.appendFileSync` is NOT atomic on all filesystems. A crash mid-write can produce a partial JSONL line, corrupting the inbox.
- **Fix**: Write to a temp file first, then `rename()` (which IS atomic on POSIX). Or use a write-ahead approach where each entry is a separate file in a directory.

---

### Observations

- E2E encryption stack (X25519 ECDH + XChaCha20-Poly1305) is sound and well-chosen. No issues here.
- HMAC key derivation via HKDF with domain separation is good practice.
- The 0600 permission model for identity files is appropriate.
- The principle of least privilege table (Section 4.2) is well-structured and shows good security thinking.
- The circuit breaker for HMAC verification failures (10 in 1 min → lock reads) is a good defense against brute-force.

### Research Findings

- **WebSocket relay security**: Known vulnerabilities include connection hijacking via DNS rebinding, origin confusion, and upgrade header manipulation. The Ed25519 auth handshake mitigates most of these.
- **Unix domain socket security**: TOCTOU attacks on socket files are well-documented. `SO_PEERCRED` is the standard mitigation on Linux; macOS has `LOCAL_PEERCRED`.
- **HMAC timing attacks**: Demonstrated practical key recovery via timing side-channels on HMAC comparison (2023 research). `crypto.timingSafeEqual()` is the only safe approach in Node.js.
- **LLM prompt injection**: Trail of Bits "Not What You've Signed Up For" (2025) documents tool restriction bypasses. Preamble-based defenses are insufficient against sophisticated injection.

### Scalability Assessment

- **Phase 1 (MVP)**: Security posture is adequate for single-user, controlled environment. The main risk is the shared key between daemon and server.
- **Phase 2 (Growth, 10x)**: Multiple agents increase the attack surface for cross-agent prompt injection. Pipe session security becomes critical.
- **Phase 3 (Scale, 100x)**: Key management needs formalization. A proper key hierarchy (master → derived per-purpose keys) becomes essential.
- **Viral spike handling**: The rate limiting in InboundMessageGate handles this well. The HMAC circuit breaker prevents brute-force during spikes.

### Score: 6.5/10

The spec shows good security awareness — the threat surface analysis (Section 4.1), least privilege table (Section 4.2), and E2E encryption are solid. However, five critical issues need resolution before implementation: timing-safe HMAC comparison, socket TOCTOU mitigation, pipe session prompt injection defense, split-brain resolution via relay authority, and key separation between daemon and server. All are fixable without major architectural changes.
