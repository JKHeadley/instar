# Adversarial Review Round 2 — Persistent Listener Daemon RFC

**Review ID**: 20260405-142000 | **Round**: 2 | **Score: 7.5/10** (was 6.5)

### Approval Status: CONDITIONAL APPROVE

---

### Round 1 Issue Resolution

| Issue | Status |
|-------|--------|
| CRIT-1: Inbox rotation TOCTOU | **RESOLVED** |
| CRIT-2: Keyword classifier gameable | **RESOLVED** |
| CRIT-3: Thread history injection | **RESOLVED** |
| CRIT-4: Split-brain circular | **RESOLVED** (phase-gated, Phase 1-2 interim risk acknowledged) |
| HIGH-1: HMAC key in launchd env | **RESOLVED** |
| HIGH-2: Adversarial displacement | **RESOLVED** |
| HIGH-3: Session name collision | **RESOLVED** |

### New Attack Vectors in v2

| ID | Issue | Priority | Blocker? |
|----|-------|----------|----------|
| NEW-1 | LLM classifier receives untrusted input without injection protection | HIGH (16/25) | YES |
| NEW-2 | Thread history summarizer launders adversarial facts | HIGH (15/25) | YES |
| NEW-3 | HKDF derivation missing salt; no key rotation protocol | MEDIUM (10/25) | No |
| NEW-4 | Displacement alert may disclose IPs in git-synced state | LOW-MEDIUM (8/25) | No |
| NEW-5 | Relay fencing token bootstrap problem on relay restart | MEDIUM (12/25) | No |
| NEW-6 | allowedPaths default "." may expose stateDir secrets | MEDIUM (10/25) | YES |
| NEW-7 | IQS decay "re-verification" trigger undefined | LOW (6/25) | No |

### Conditions to reach APPROVE

1. Wrap classifier input in injection-resistant tags
2. Frame summarizer output as still-untrusted in pipe-mode prompt
3. Exclude `{stateDir}` from allowedPaths grant-list by default
4. Document relay epoch counter persistence behavior
5. Clarify Phase 1-2 multi-machine split-brain caveat
