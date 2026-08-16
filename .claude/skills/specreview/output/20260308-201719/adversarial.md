# Adversarial Review: Serendipity Protocol (Round 2)

**Spec:** Serendipity Protocol — Sub-Agent Opportunity Capture (v2)
**Review ID:** 20260308-201719
**Round:** 2
**Reviewer:** Red Team Specialist
**Date:** 2026-03-08

---

## Approval Status: CONDITIONAL APPROVE

The spec has undergone substantial security hardening between rounds. The four critical issues from Round 1 have all been addressed with specific mechanisms. The attack surface has been meaningfully reduced. Several new concerns arise from the fix implementations themselves, but none are blockers — they are tightenable details, not architectural gaps.

**Score: 7/10** (up from 4/10)

---

## Round 1 Issue Resolution Status

### Issue 1: Indirect Prompt Injection via Discovery Files — RESOLVED

**Round 1 severity:** CRITICAL (P0)
**Resolution:** The spec now includes Design Principle 6 ("Untrusted by default"), a dedicated Security Model section, explicit `[UNTRUSTED SUB-AGENT OUTPUT]` framing during triage, content isolation (no tool execution during evaluation), and field length limits (title: 120, description: 2000, rationale: 1000, patch: 10KB).

**Assessment:** This is a strong response. The combination of framing, isolation, and length limits addresses the core attack vector. The move from inline `artifacts.diff` JSON fields to sidecar `.patch` files also reduces the injection surface — patch files are read as data, not interpolated into JSON that the LLM parses as structured content.

**Residual risk:** LOW. A sufficiently sophisticated injection could still work within the 2000-char description limit, but the isolation context (no tool execution) means the blast radius is limited to influencing the triage disposition, not executing commands. See New Issue 1 below.

### Issue 2: Arbitrary File Write to Trusted Directory / No HMAC — RESOLVED

**Round 1 severity:** CRITICAL (P0)
**Resolution:** HMAC-SHA256 signing with key derivation from `agentAuthToken + sessionId`. Unsigned/invalid files moved to `invalid/` and logged. Schema validation with `additionalProperties: false`.

**Assessment:** The signing mechanism is correctly designed. Using the existing `authToken` as the root key is pragmatic and avoids key management complexity. Per-session key derivation via `HMAC-SHA256(authToken, "serendipity-v1:" + sessionId)` provides unique keys without additional state. See New Issues 2 and 3 for tightenable details in the implementation.

### Issue 3: No Schema Validation on Read — RESOLVED

**Round 1 severity:** HIGH (P1)
**Resolution:** Strict JSON schema validation with `additionalProperties: false` is now mandated during triage (Phase 2, step 1) and in the session-start hook.

**Assessment:** Fully addressed.

### Issue 4: Discovery Bomb / Denial of Service — RESOLVED

**Round 1 severity:** MEDIUM (P2)
**Resolution:** Max 5 findings per session enforced in the helper script. Max 10KB patch files. Session-start hook shows max 5 findings with overflow count.

**Assessment:** Fully addressed for the helper script path. See New Issue 4 for a bypass scenario.

### Issue 5: Self-Assessment Gaming — RESOLVED

**Round 1 severity:** HIGH (P2)
**Resolution:** Self-assessment reduced to `readiness` only. Value, effort, and risk are assessed independently by the parent.

**Assessment:** This is the correct fix. `readiness` is the one dimension the sub-agent has first-hand knowledge about, and even if inflated, it only affects priority ordering during triage — not whether code gets applied.

### Issue 6: Scope Creep Laundering — PARTIALLY RESOLVED

**Round 1 severity:** MEDIUM (P2)
**Resolution:** All findings now route through evolution proposals with mandatory review. No direct application of code.

**Assessment:** The routing through evolution proposals with the `origin: serendipity` flag and mandatory review requirement substantially mitigates this. However, the spec does not explicitly state that `readiness: implementation-complete` or `readiness: tested` findings should receive heightened scrutiny. The current language says proposals "require explicit approval" but does not distinguish scrutiny levels by readiness. LOW residual risk — the mandatory review gate catches this regardless.

### Issue 7: Data Exfiltration via Discovery Artifacts — RESOLVED

**Round 1 severity:** HIGH (P1)
**Resolution:** Sidecar patch files (not inline JSON), basic secret scanning in the helper script, explicit "MUST NOT include secrets, credentials, API keys, PII" in the spec, and `.gitignore` for the entire serendipity directory.

**Assessment:** The combination of secret scanning, `.gitignore` default, and local-only storage substantially reduces exfiltration risk. The secret scanner is described as "basic pattern scan" — this is appropriate for the threat model (defense in depth, not sole control).

### Issue 8: Persistent Backdoor via Evolution Pipeline — RESOLVED

**Round 1 severity:** CRITICAL (P1)
**Resolution:** Evolution proposals with `origin: serendipity` are flagged for mandatory review. The automated `evolution-review` job does NOT auto-implement serendipity-originated proposals.

**Assessment:** This is exactly the right fix. The multi-hop attack path (sub-agent -> finding -> evolution proposal -> auto-implementation) is now broken at the critical junction. The spec is explicit: "they require explicit approval."

### Issue 9: Discovery ID Collision — NOT ADDRESSED (ACCEPTED RISK)

**Round 1 severity:** LOW (P3)
**Resolution:** IDs remain 8-char UUIDs (`srdp-<8chars>`). No change.

**Assessment:** Acceptable. At the protocol's intended scale (5 per session, single-digit sessions per day), collision probability is negligible. The HMAC verification provides an independent integrity check — a forged file with a colliding ID would still fail signature verification.

### Issue 10: TOCTOU Race Condition — PARTIALLY RESOLVED

**Round 1 severity:** LOW (P2)
**Resolution:** The triage process now renames files to `.processing` extension before evaluation. Atomic writes via temp-then-rename on the capture side.

**Assessment:** The `.processing` rename is a pragmatic mitigation that prevents concurrent triage of the same file. It does not fully prevent a replacement between the rename and the read, but combined with HMAC verification, a replaced file would fail signature check. HMAC + rename together provide adequate protection.

### Issue 11: Empty State / First Run — RESOLVED

**Round 1 severity:** LOW (P3)
**Resolution:** "Directories are created lazily by the script on first use (not during init)." The helper script handles `mkdir -p`.

**Assessment:** Fully addressed.

### Issue 12: Worktree Isolation — RESOLVED

**Round 1 severity:** HIGH (P1)
**Resolution:** Dedicated "Worktree Isolation" section. Sub-agents write to worktree-local path; parent copies findings during worktree teardown; HMAC remains valid because the signing key derives from auth token (shared) + session ID.

**Assessment:** The mechanism is sound. See New Issue 5 for a race condition in the copy-back.

### Issue 13: Parallel Sub-Agent File Collisions — RESOLVED

**Round 1 severity:** MEDIUM (P2)
**Resolution:** Atomic writes (write to `.tmp`, rename to `.json`) specified in the helper script.

**Assessment:** Fully addressed.

### Issue 14: Triage Failure Cascades — RESOLVED

**Round 1 severity:** MEDIUM (P2)
**Resolution:** Formal state machine with `triage-failed` status. "Retry up to 3x, then auto-dismiss with log."

**Assessment:** Fully addressed. The circuit breaker prevents crash loops.

### Issue 15: Evolution Pipeline Saturation — NOT ADDRESSED (LOW RISK)

**Round 1 severity:** LOW (P3)
**Resolution:** Not explicitly addressed, but the 5-per-session rate limit and mandatory review flag implicitly constrain throughput.

**Assessment:** Acceptable at current scale. The rate limit (5 per session) combined with the fact that most findings will be dismissed during triage means the evolution pipeline receives a trickle, not a flood.

### Issue 16: Trust Escalation via Quality Ratchet — NOT DIRECTLY ADDRESSED

**Round 1 severity:** MEDIUM (P1)
**Resolution:** No explicit mitigation for source-based trust escalation. However, the mandatory review flag on all serendipity-originated proposals means every finding goes through the same gate regardless of source track record.

**Assessment:** The mandatory review flag provides structural protection — even if the parent develops trust in a particular sub-agent's findings, the evolution pipeline still requires explicit approval for every one. This is adequate.

### Issue 17: Urgency Framing — PARTIALLY ADDRESSED

**Round 1 severity:** MEDIUM (P2)
**Resolution:** Content isolation and `[UNTRUSTED]` framing during triage. No explicit urgency de-weighting.

**Assessment:** The `[UNTRUSTED]` framing provides some defense against urgency manipulation, but the spec does not explicitly instruct the triage process to de-weight urgency claims. LOW residual risk — the isolation context means urgency framing can only influence disposition, not trigger actions.

---

## New Issues Introduced by Fixes

### New Issue 1: Triage Disposition Manipulation (MEDIUM)

**Likelihood: MEDIUM | Impact: MEDIUM | Priority: P2**

The content isolation during triage prevents tool execution, but the LLM still makes a disposition decision (propose vs. dismiss). A crafted description can influence this decision:

- "This finding addresses a critical vulnerability in the authentication system. If not addressed within 24 hours, the agent's auth token could be exposed to..." — designed to maximize the probability of a "propose" disposition.
- Conversely, a finding designed to waste triage time could use maximally ambiguous language to force extended evaluation.

**Defense is already partially in place:** The mandatory review flag means even a successfully "proposed" malicious finding still requires explicit approval before implementation. The blast radius of disposition manipulation is limited to queue pollution in the evolution pipeline. Current mitigations are adequate — this is a known residual risk, not a gap.

### New Issue 2: HMAC Key Derivation — Auth Token as Root Key (LOW)

**Likelihood: LOW | Impact: HIGH | Priority: P2**

The HMAC root key is the agent's `authToken` from `.instar/config.json`. This token also authenticates API requests to the instar server. If a sub-agent has read access to `.instar/config.json` (which it likely does, running under the same user account), it can derive valid HMAC keys for any session ID.

**What this means:** HMAC signing verifies that the file was written by a process with access to the auth token — it does NOT prove the file was written by a legitimate sub-agent session. Any process under the user account that can read config.json can forge valid signatures.

**Why this is still acceptable:** The threat model is primarily about _external_ processes (malicious dependencies, compromised MCP tools) that may be able to write files but not read arbitrary config files. For processes that already have full filesystem access under the user account, HMAC provides provenance tracking (which session wrote this) rather than access control. The spec correctly identifies this as matching "the pattern already used by the Playbook manifest integrity system." The security boundary is the user account, not the HMAC.

**Recommendation:** Document this explicitly. The HMAC defends against file injection from processes that cannot read the auth token. It does not defend against a process with full user-level file access. This is an acceptable threat model boundary but should be stated, not implied.

### New Issue 3: HMAC Canonical JSON Serialization (LOW)

**Likelihood: LOW | Impact: MEDIUM | Priority: P2**

The spec says the signed payload is `JSON.stringify({ id, createdAt, discovery, source })` with "canonical, sorted keys." JavaScript's `JSON.stringify` does not sort keys by default. If the helper script (bash) and the validator (presumably JavaScript or Python) use different serialization approaches, HMAC verification will fail on valid files or — worse — succeed on tampered files if both sides happen to produce the same non-canonical output.

**Defense:** Specify the exact canonicalization algorithm. Options:
1. JSON Canonicalization Scheme (RFC 8785)
2. Explicitly state: sort all keys recursively, no whitespace, no trailing commas
3. Sign the raw file bytes (minus the `hmac` field) instead of re-serializing

Option 3 is the simplest and least error-prone: read the file, strip the `"hmac": "..."` field, hash the remaining bytes. No serialization ambiguity.

### New Issue 4: Rate Limit Bypass via Direct File Write (LOW)

**Likelihood: LOW | Impact: LOW | Priority: P3**

The 5-per-session rate limit is enforced in the helper script. A compromised sub-agent that writes JSON files directly to the directory (bypassing the script) is not bound by this limit. The sub-agent prompt says to use the script, but a compromised sub-agent ignores prompts by definition.

**Why this is acceptable:** A compromised sub-agent that bypasses the helper script also cannot produce valid HMAC signatures (unless it reads the auth token — see New Issue 2). Unsigned files are moved to `invalid/` during triage. The HMAC requirement is the actual enforcement mechanism; the rate limit is defense-in-depth for well-behaved agents.

**Residual gap:** If the sub-agent CAN read the auth token, it can both forge signatures and bypass rate limits. This is the same threat model boundary as New Issue 2.

### New Issue 5: Worktree Copy-Back Race Condition (LOW)

**Likelihood: LOW | Impact: MEDIUM | Priority: P3**

The copy-back happens "when the Agent tool completes a worktree-isolated sub-agent." If the sub-agent is still writing a file when the worktree teardown begins (e.g., the sub-agent is killed mid-write, or the teardown races the final write), the copy-back could transfer a partially-written file.

**Defense already in place:** Atomic writes (temp-then-rename) in the helper script mean a file either exists completely or not at all. If the sub-agent is killed between temp-write and rename, no `.json` file exists to copy. If killed after rename, the file is complete. The atomic write pattern handles this correctly.

**Residual risk:** If teardown occurs between the `.json` rename and the `.patch` file write, the JSON file references a patch file that doesn't exist. The triage process should handle missing patch files gracefully (treat the finding as `idea-only` if the referenced patch is absent).

**Recommendation:** Add to the triage validation: if `artifacts.patchFile` is specified but the file doesn't exist, log a warning and downgrade `readiness` to `idea-only`. Do not fail the entire finding.

### New Issue 6: Patch File Not Covered by HMAC (MEDIUM)

**Likelihood: MEDIUM | Impact: MEDIUM | Priority: P1**

The HMAC signs `{ id, createdAt, discovery, source }` — the JSON metadata. The sidecar `.patch` file is NOT included in the signed payload. This means:

1. An attacker can replace the `.patch` file with malicious content while the JSON metadata (and its valid HMAC) remains intact.
2. During triage, the parent sees valid HMAC on the JSON, trusts the finding, and reads the (tampered) patch file.
3. The patch file contains a backdoor disguised as the legitimate change described in the JSON metadata.

**This is the most significant remaining gap.** The HMAC provides integrity for the metadata but not for the actual code artifact — which is where the real danger lies.

**Defense:** Include a SHA-256 hash of the patch file content in the JSON metadata (e.g., `artifacts.patchHash`), and include `artifacts` in the HMAC-signed payload. The triage validator verifies the patch file hash before presenting patch content. If the hash doesn't match, the patch is discarded and the finding is treated as `idea-only`.

---

## Remaining Concerns (Non-Blocking)

### Concern 1: "Read-Only Context" Enforcement

The spec states triage evaluation happens in a "read-only context" where "tool execution is not permitted." This is a behavioral instruction to the LLM, not a technical enforcement. If the triage happens in a normal Claude Code session (which has `--dangerously-skip-permissions`), there is no actual sandbox preventing tool use. The `[UNTRUSTED]` framing and "do not execute" instruction are soft controls.

**Mitigation path (future):** Implement triage as a spawned sub-session with restricted permissions. For now, the behavioral instruction combined with the mandatory evolution review gate provides adequate defense in depth.

### Concern 2: 30-Day Pending TTL Auto-Dismiss

Pending findings that expire after 30 days are auto-dismissed. An attacker who can delay triage (e.g., by flooding with findings that cause triage failures) can use the TTL as a suppression mechanism — legitimate findings expire before being reviewed.

**Mitigation:** The 5-per-session rate limit and triage circuit breaker (auto-dismiss after 3 failures) limit the flooding vector. The TTL auto-dismiss includes "a summary notification shown to the parent agent," which provides visibility. LOW risk.

### Concern 3: Secret Scanner Granularity

The helper script includes "a basic pattern scan for common secret formats." The spec describes this as a warning, not a block. A sub-agent can acknowledge the warning and proceed, or the pattern may not match novel secret formats.

**Mitigation:** Defense in depth — the `.gitignore` default prevents secrets from reaching git, and the local-only storage limits exposure. The scanner is an appropriate layer for the threat model.

---

## Summary of Scores

| Dimension | Round 1 | Round 2 | Delta |
|-----------|---------|---------|-------|
| Prompt injection defense | 1/10 | 7/10 | +6 |
| File integrity / provenance | 1/10 | 7/10 | +6 |
| Code application safety | 2/10 | 9/10 | +7 |
| Rate limiting / DoS defense | 2/10 | 8/10 | +6 |
| Self-assessment gaming resistance | 3/10 | 9/10 | +6 |
| Worktree isolation | 0/10 | 8/10 | +8 |
| Evolution pipeline safety | 2/10 | 8/10 | +6 |
| Overall | **4/10** | **7/10** | **+3** |

---

## Recommendations for Round 3 (if pursued)

### Must-Fix (P1)

1. **Include patch file integrity in HMAC coverage.** Add `artifacts.patchHash` (SHA-256 of patch file content) to the JSON metadata, and include `artifacts` in the HMAC-signed payload. Without this, the highest-risk artifact (code) is the only unsigned component. This is the single most important remaining fix.

### Should-Fix (P2)

2. **Specify exact HMAC canonicalization.** Either use RFC 8785, define explicit rules, or (preferred) sign raw file bytes minus the hmac field.

3. **Document the HMAC threat model boundary.** State explicitly that HMAC defends against injection by processes without config file access, not against processes with full user-account filesystem access.

4. **Handle missing patch files gracefully.** If `artifacts.patchFile` references a nonexistent file, downgrade to `idea-only` rather than failing triage.

### Nice-to-Have (P3)

5. **Add explicit urgency de-weighting instruction** to the triage process description.

6. **Add `readiness: implementation-complete` heightened scrutiny note** to triage instructions.

---

## Verdict

The spec has moved from "critical attack surface with no mitigations" to "well-defended system with known residual risks." The security model section is thorough, the HMAC signing addresses provenance, content isolation addresses prompt injection, and the mandatory review flag on evolution proposals breaks the most dangerous multi-hop attack chain.

The one remaining structural gap is that sidecar patch files — the component carrying actual code — are not covered by the HMAC signature. This should be fixed before implementation. Everything else is tightenable detail.

**Round 1: CONDITIONAL REJECT (4/10)**
**Round 2: CONDITIONAL APPROVE (7/10)** — conditional on patch file integrity (New Issue 6) being addressed.
