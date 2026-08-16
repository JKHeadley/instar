# Security Review Round 2 — Persistent Listener Daemon RFC

**Review ID**: 20260405-142000 | **Round**: 2 | **Score: 8.0/10** (was 6.5)

### Approval Status: CONDITIONAL APPROVE — Phase 1 can proceed

---

### Round 1 Critical Issue Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| CRIT-1: HMAC timing attack | **RESOLVED** | `crypto.timingSafeEqual()` mandated in Section 3.2, 4.1, and 4.3 with rationale |
| CRIT-2: Unix socket TOCTOU/symlink | **RESOLVED** | Persistent connection, `fs.realpathSync()`, `SO_PEERCRED`/`LOCAL_PEERCRED` peer verification, CVE attribution |
| CRIT-3: Pipe session prompt injection | **RESOLVED** (one residual) | XML `<untrusted-message>` tags, LLM-summarized history, multi-turn assembly addressed. Residual: `{fromName}` embedded outside XML tags — validate alphanumeric + spaces, max 64 chars before embedding |
| CRIT-4: Split-brain wall-clock | **RESOLVED** in design | Relay-side fencing tokens specified. Interim Phase 1-2 uses heartbeat (document as known interim risk) |
| CRIT-5: Shared Ed25519 key | **RESOLVED** | HKDF-derived daemon sub-key with rationale. Capability table confirms master key isolation |

---

### New Issues Introduced by Revision

**NEW-1 (LOW): Config namespace inconsistency** — Section 3.2 shows top-level `listener.*` block; Section 9.3 defines `threadline.listener.*` as canonical. Remove or redirect Section 3.2 example.

**NEW-2 (MEDIUM): HKDF relay verification undocumented** — How does the relay verify the daemon's sub-key without the master private key? Also: no salt means deterministic sub-key — recommend `salt=agentId` to prevent cross-agent collisions. Needs documentation before Phase 2.

**NEW-3 (LOW): Rename-append language in Section 3.2 step 5** — "rename() to append position" is not valid POSIX. Should match the rotation protocol's `appendFileSync` to `inbox.jsonl.active`.

**NEW-4 (LOW): IQS decay policy lacks implementation anchor** — Decay specified but not tied to a component or trigger.

**NEW-5 (LOW): ThreadResumeMap conflict resolution uses timestamp** — Acceptable given low stakes, but acknowledge the contrast with split-brain's anti-wall-clock stance.
