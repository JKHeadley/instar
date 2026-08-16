# Security Review: Serendipity Protocol — Sub-Agent Opportunity Capture

**Review ID:** 20260308-201719
**Reviewer:** Security Specialist
**Spec:** `/Users/justin/.instar/agents/echo/specs/discovery-protocol.md`
**Date:** 2026-03-08
**Round:** 2

---

## Approval Status: APPROVE

**Score: 8/10**

The spec has been substantially revised to address all critical and high-severity issues from Round 1. The new Security Model section is well-structured and addresses the core threat model correctly: sub-agent output as an untrusted input boundary. The HMAC implementation, content isolation, and evolution pipeline routing are all sound. Remaining items are low-severity hardening recommendations, not blockers.

---

## Round 1 Issue Resolution Status

### CRITICAL Issues

| ID | Issue | Status | Assessment |
|----|-------|--------|------------|
| CRITICAL-1 | Prompt injection via discovery file content | **RESOLVED** | The spec now mandates explicit `[UNTRUSTED SUB-AGENT OUTPUT]` framing during triage (Phase 2, step 2-3). Evaluation occurs in a read-only context with no tool execution. Field length limits are defined (title: 120, description: 2000, rationale: 1000, patch: 10KB). This is the correct mitigation pattern. |
| CRITICAL-2 | No integrity verification on discovery files | **RESOLVED** | HMAC-SHA256 signing is fully specified: key derivation from `authToken` + session ID, canonical JSON serialization for the signed payload, signature stored at top level. The Playbook-compatible pattern was adopted as recommended. Unsigned/invalid files are quarantined to `invalid/`. |
| CRITICAL-3 | Arbitrary code in `artifacts.diff` field | **RESOLVED** | The spec explicitly states "Findings are never applied directly as commits" (Phase 2, critical change note). All code routes through evolution proposals with mandatory review. The `origin: serendipity` flag prevents the automated evolution-review job from auto-implementing. Code diffs moved to sidecar `.patch` files, reducing JSON injection surface. |

### HIGH Issues

| ID | Issue | Status | Assessment |
|----|-------|--------|------------|
| HIGH-1 | TOCTOU race condition | **RESOLVED** | Atomic file writes (write-to-temp-then-rename) are mandated in the helper script. The parent renames files to `.processing` extension before evaluation, preventing concurrent triage of the same file. |
| HIGH-2 | Self-assessment is untrusted input | **RESOLVED** | Self-assessment reduced to `readiness` only. Value, effort, and risk are independently assessed by the parent. The spec explicitly states "eliminates the perverse incentive for sub-agents to overstate value and understate risk." |
| HIGH-3 | No access control on discovery directory | **RESOLVED** | Directory permissions set to 0700. Strict JSON schema validation with `additionalProperties: false`. HMAC verification means external processes cannot produce valid files without the auth token. |

### MEDIUM Issues

| ID | Issue | Status | Assessment |
|----|-------|--------|------------|
| MED-1 | Discovery ID collisions/overwrites | **PARTIALLY RESOLVED** | IDs still use 8-char UUIDs (`srdp-<8-char>`). Collision probability is low but nonzero at scale. The atomic write pattern (`O_CREAT|O_EXCL` semantics via temp+rename) prevents accidental overwrites. Acceptable for MVP. |
| MED-2 | Worktree isolation bypass | **RESOLVED** | Explicit worktree handling in a dedicated section. Sub-agents write to worktree-local path; parent copies during teardown. HMAC remains valid because the key derives from the shared auth token. Failure handling is specified (log + manual recovery path). |
| MED-3 | Information leakage via discovery files | **RESOLVED** | All of `.instar/state/serendipity/` is `.gitignore`d by default. Findings are local-only. Evolution proposals (which do sync) are the cross-machine path. Data safety section tells sub-agents not to include secrets/PII. Helper script includes basic secret scanning. |
| MED-4 | Denial of service via flooding | **RESOLVED** | Max 5 findings per session enforced by helper script. Patch files capped at 10KB. Session-start hook shows max 5 with overflow count. Configurable via `maxPerSession`. |

**Resolution rate: 13/14 issues fully resolved, 1 partially resolved (acceptable).**

---

## New Issues Introduced by v2

### LOW-1: HMAC Key Availability in Worktree Contexts

**Severity:** Low
**Concern:** The HMAC key derivation requires reading `authToken` from `.instar/config.json`. In worktree-isolated sub-agents, the helper script needs access to this config file. The spec says "The signing key is derived from the agent's auth token (shared across worktrees)" but does not specify how the worktree sub-agent accesses the auth token. If the worktree is a shallow copy that doesn't include `.instar/config.json`, signing fails silently or the script falls back to unsigned files.

**Risk:** Low. Worktrees created by the Instar session spawner likely include `.instar/` contents. But the spec should explicitly state that the helper script reads the auth token from the main tree's config if the worktree copy is absent, or that the session spawner passes the signing key as an environment variable.

**Recommendation:** Specify that the session spawner passes a `SERENDIPITY_SIGNING_KEY` environment variable (the pre-derived session key) to sub-agents. This avoids the sub-agent needing to read the auth token directly (defense in depth — the sub-agent gets a session-scoped derivative, not the root secret).

### LOW-2: Canonical JSON Serialization Not Defined

**Severity:** Low
**Concern:** The HMAC signed payload is described as `JSON.stringify({ id, createdAt, discovery, source }) (canonical, sorted keys)`. However, "canonical JSON" is underspecified. Different implementations of "sorted keys" may handle nested objects differently (sort at all levels? stable sort?). If the capture script and the verification code disagree on canonicalization, valid files will be rejected.

**Recommendation:** Specify the exact canonicalization: recursive key sorting at all levels, no whitespace (`JSON.stringify` with no space/indent arguments), and a reference implementation in the helper script. Alternatively, reference an existing canonical JSON spec (RFC 8785 / JCS).

### LOW-3: Secret Scanning Coverage in Helper Script

**Severity:** Low
**Concern:** The spec states the helper script "includes a basic pattern scan for common secret formats." This is a warn-only check. A compromised sub-agent will simply not use recognizable secret formats. More importantly, a non-malicious sub-agent might include secrets in novel formats the scanner doesn't catch.

**Risk:** Low, because findings are `.gitignore`d and local-only. The primary risk is secrets persisting on disk longer than necessary (up to 90 days in `processed/`).

**Recommendation:** This is adequate for MVP. In future iterations, consider integrating with a dedicated secret scanner (e.g., `trufflehog` or `gitleaks`) for the patch file content specifically.

### LOW-4: `.processing` Extension Race Window

**Severity:** Low
**Concern:** The parent renames files to `.processing` before evaluation. If the parent agent crashes mid-triage, `.processing` files are orphaned. The spec doesn't define recovery for this state. On next session start, these files won't match `*.json` glob and won't be triaged.

**Recommendation:** The session-start hook should check for `.processing` files and either rename them back to `.json` (for retry) or move them to `invalid/` if they've been in `.processing` state for more than a configurable timeout (e.g., 1 hour).

---

## Remaining Recommendations

| Priority | Recommendation | Addresses |
|----------|---------------|-----------|
| P1 | Pass session-derived signing key via env var rather than having sub-agents read auth token | LOW-1 |
| P1 | Specify canonical JSON format precisely (RFC 8785/JCS or explicit recursive sort rules) | LOW-2 |
| P2 | Add `.processing` file recovery to session-start hook | LOW-4 |
| P2 | Consider full UUIDs for finding IDs to eliminate collision risk at scale | MED-1 (carried) |
| P3 | Integrate dedicated secret scanner for patch files in future iteration | LOW-3 |
| P3 | Add structured logging for all triage decisions (carried from R1) | Observability |

---

## Security Model Assessment

The new Security Model section (top of Architecture) is well-designed. Specific strengths:

1. **Defense in depth.** HMAC signing, content isolation, schema validation, field length limits, rate limiting, and directory permissions form overlapping layers. No single bypass compromises the entire system.

2. **Correct trust boundary.** The spec now explicitly identifies sub-agent output as an untrusted input boundary. This is the fundamental insight that was missing in v1.

3. **Evolution pipeline as review gate.** Routing all code through evolution proposals with mandatory review and the `origin: serendipity` flag is the right architectural choice. It reuses existing infrastructure and adds a human-in-the-loop checkpoint.

4. **Sidecar patch files.** Moving code diffs out of JSON fields and into separate `.patch` files is a smart design choice. It eliminates JSON string escaping as an attack vector and makes patch content easier to scan independently.

5. **Configurable disable.** The `serendipity.enabled: false` flag provides a clean kill switch for agents that don't need this surface area.

### Residual Risk

The primary residual risk is **social engineering via untrusted content fields**. Even with `[UNTRUSTED]` framing, a sophisticated adversary could craft a finding that reads as highly compelling to the parent LLM, biasing the triage toward "propose" for a subtly malicious change. The HMAC and provenance checks confirm the file came from a legitimate sub-agent session, but they don't verify the intent of the content.

This is an inherent limitation of any system where an LLM evaluates attacker-influenced content. The mitigations in the spec (no auto-application, mandatory review, evolution pipeline) reduce this to a manageable risk. The final backstop is human review of serendipity-originated evolution proposals — this MUST remain mandatory and should not be relaxed in future iterations.

---

## Verdict

The v2 spec has addressed all critical and high-severity security concerns from Round 1. The Security Model section is coherent, the HMAC implementation follows established patterns, worktree isolation is handled explicitly, and the elimination of direct code application removes the most dangerous attack path. The remaining issues (LOW-1 through LOW-4) are implementation details that should be resolved during development but do not block proceeding.

**Approved.** Implement P1 recommendations during development. P2/P3 items can follow iteratively.

---

*Round 2 security review. All Round 1 critical issues resolved. Score improved from 6/10 to 8/10.*
