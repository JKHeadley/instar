# Privacy & Ethics Review — Persistent Listener Daemon RFC

**Reviewer**: Privacy & Ethics Specialist
**Review ID**: 20260405-135742
**Round**: 1
**Date**: 2026-04-05

---

### Approval Status: CONDITIONAL APPROVE

### Score: 6.5/10

Strong cryptographic foundations, but significant policy gaps around data retention, consent transparency, and behavioral telemetry exposure.

---

### Research Findings

- **Persistent WebSocket privacy:** OWASP guidance: never log message contents, auth tokens, session IDs, or PII. Persistent connections create long-lived traffic correlation opportunities.
- **GDPR for agent messaging:** GDPR applies wherever personal data is processed, including AI agent messages referencing humans. €1.2B in fines in 2025. Agent systems relaying human data must satisfy lawful basis, data minimization, purpose limitation, data subject rights.
- **Relay metadata sensitivity:** Traffic analysis of relay systems can de-anonymize participants even with E2E encryption. Who communicates with whom, when, at what cadence constitutes a metadata graph.
- **Agentic AI ethics:** Key risks include reduced human oversight as agents act autonomously, accountability gaps, power concentration in relay operators.

---

### Critical Issues

**CRITICAL-1: Public Availability Profile Leaks Behavioral Telemetry** (Section 5.3)
- Publishing uptime percentage, response latency, failover count, and disconnect timestamps reveals the human operator's schedule, device usage patterns, and operational rhythm.
- Available to any agent querying MoltBridge — no consent mechanism specified.
- **Fix:** Gate behind explicit opt-in with disclosure, or strip timestamps and publish only coarse availability bands ("generally available", "often offline").

**CRITICAL-2: No Data Retention Policy for Inbox JSONL**
- Append-only log of all incoming messages with no retention limit, rotation, or TTL.
- If entries reference humans, indefinite retention violates GDPR Article 5(1)(e).
- **Fix:** Define maximum retention (suggested: 30 days configurable). Implement rotation with deletion.

**CRITICAL-3: Cross-Machine ThreadResumeMap Sync Lacks Privacy Analysis** (Section 6.4)
- Syncing via git means conversation metadata appears in git history indefinitely, may be pushed to remote repos, and any machine with access has full visibility.
- **Fix:** Assess whether entries constitute personal data. If yes, apply data minimization, retention limits, and document access control on git remote.

---

### Recommendations

- **REC-1:** Explicit consent for relay presence disclosure (connection/disconnection broadcast to all participants).
- **REC-2:** Daemon log content scoping — define what fields are logged at each level. Never log message content at INFO+.
- **REC-3:** Pipe-mode session autonomy disclosure — notification when agent sends autonomous replies.
- **REC-4:** Relay operator trust model documentation — data handling, retention, jurisdictional analysis.
- **REC-5:** Right to erasure pathway — `instar listener purge` covering all personal data stores.
- **REC-6:** IQS score transparency — agents should see their own band and understand routing consequences.

---

### Observations

**Positive privacy engineering:**
- E2E encryption (relay cannot read content)
- HMAC-signed inbox prevents tampering
- Principle of least privilege for daemon
- AutonomyGate for user-controlled acceptance
- Trust-gated routing
- Identity file permissions at 0600

**Dual-use concern:** Persistent connection presence + behavioral telemetry + cross-machine failover creates monitoring infrastructure repurposable for surveillance. Relay operator has complete communications graph.

**Thread history in temp files:** Pipe prompt template embeds thread history in `/tmp/` files. Deletion not guaranteed on spawn failure.

---

### Required Actions

| Priority | Issue | Action |
|----------|-------|--------|
| Critical | Behavioral telemetry in public profile | Opt-in with disclosure, or strip fine-grained metrics |
| Critical | No inbox retention policy | Define TTL, implement rotation |
| Critical | ThreadResumeMap sync privacy gap | Assess personal data status, define retention |
| High | Relay presence disclosure lacks consent | Add consent to setup flow |
| High | Daemon log content unscoped | Define logging policy |
| High | No right to erasure pathway | Implement purge command |
| Medium | Autonomous replies lack visibility | Add notification pathway |
| Medium | Relay operator trust undocumented | Document data handling |
| Medium | IQS routing transparency | Expose band to affected agents |
