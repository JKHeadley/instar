# Architecture Review: Serendipity Protocol — Sub-Agent Opportunity Capture

**Review ID:** 20260308-201719
**Reviewer:** Systems Architect (Round 2)
**Spec:** `/Users/justin/.instar/agents/echo/specs/discovery-protocol.md`
**Date:** 2026-03-08
**Round:** 2 (verifying fixes from Round 1)

---

## Approval Status

**APPROVED**

The v2 spec addresses every recommendation from my Round 1 review and integrates the cross-reviewer findings without compromising the architectural elegance that earned the original approval. The security layer is proportionate, not excessive. The design remains simple where it should be simple and adds complexity only where the threat model demands it.

---

## Score: 9/10

Up from 8/10 in Round 1. The single point deducted is for the increased implementation estimate (6 hours vs. 4 hours) which, while justified by the added scope, puts more pressure on execution discipline. Every other concern has been resolved.

---

## Round 1 Recommendations — Disposition

| # | Round 1 Recommendation | Status | Notes |
|---|----------------------|--------|-------|
| 1 | Write-time schema validation | **Resolved** | JSON schema with `additionalProperties: false` specified in Step 1. Triage validates before processing (Phase 2 step 1). Malformed files route to `invalid/`. |
| 2 | Explicit worktree handling | **Resolved** | Dedicated "Worktree Isolation" section implements Option A (my preferred approach). Sub-agent writes locally, parent copies during teardown. HMAC validity across worktrees explicitly addressed. |
| 3 | Garbage collection for processed discoveries | **Resolved** | "Retention and Cleanup" section defines 90-day TTL for processed, 30-day for invalid, 30-day auto-dismiss for untriaged pending. Cleanup runs in session-start hook. |
| 4 | Atomic file writes | **Resolved** | Helper script handles write-to-tmp-then-rename. Explicitly listed in script responsibilities. |
| 5 | Discovery deduplication | **Not addressed** | Acceptable omission. Deduplication is a low-priority optimization that can be added later without architectural changes. The evolution proposal system provides a natural dedup point. |
| 6 | Token budget verification | **Resolved** | Helper script approach reduces prompt to ~80 tokens, under the 100-token target. The key insight: offload complexity to the script, keep the prompt minimal. |

**Score: 5 of 6 addressed.** The one omission (deduplication) was correctly prioritized as low-impact.

---

## Security Layer Assessment

The central question for Round 2: did the security additions bloat the design or maintain architectural coherence?

**Verdict: Proportionate and well-integrated.**

The security model adds six mechanisms: HMAC signing, content isolation, no auto-apply, field length limits, rate limiting, and directory permissions. Each maps to a specific threat identified in Round 1. None introduces a new subsystem or dependency. The implementation burden falls primarily on the helper script (signing, rate limiting, secret scanning) and the triage phase (verification, isolation) — both natural locations for these concerns.

Specific observations:

1. **HMAC key derivation** (`HMAC-SHA256(authToken, "serendipity-v1:" + sessionId)`) reuses the existing auth token infrastructure and mirrors the Playbook manifest pattern. No new key management. This is the right choice.

2. **Content isolation** ("evaluate in a context that does not permit tool execution") is stated as a requirement but the enforcement mechanism is implicit. The triage skill/script will need to ensure this — it is not enforced by the file format or directory structure. This is fine for a spec document; the implementation will need to be explicit about how tool execution is blocked during evaluation.

3. **Sidecar patch files** are an excellent architectural decision. Extracting code diffs from JSON into separate `.patch` files solves two problems simultaneously: it avoids the LLM-JSON-escaping failure mode, and it creates a natural content boundary for security scanning. The 10KB limit is reasonable.

4. **Rate limiting in the helper script** (max 5 per session) is the right enforcement point. It is a soft control (a determined sub-agent could bypass the script) but the HMAC verification provides the hard control — findings not signed by the script will fail verification.

5. **The elimination of direct code application** is the most important security change. In v1, the triage could "apply" a finding as a commit. In v2, all code routes through evolution proposals with mandatory review. This closes the most dangerous attack vector (unreviewed code execution via crafted discovery files) without adding complexity — it simplifies the triage disposition tree from four outcomes to three.

**No excessive complexity detected.** The security layer adds ~30% to the spec length but introduces zero new services, zero new dependencies, and zero new scheduling mechanisms. It is additive hardening on an existing design, not a redesign.

---

## State Machine Evaluation

The formal state machine is a welcome addition:

```
pending → processing → proposed | dismissed | triage-failed
                                              ↓
                                        (retry up to 3x, then auto-dismiss with log)
```

This is clean and minimal. Five states, no cycles, clear terminal conditions. The `.processing` rename-as-lock prevents concurrent triage of the same finding. The circuit breaker (3 retries then auto-dismiss) prevents pathological findings from blocking the triage pipeline.

One observation: the `triage-failed` → auto-dismiss transition should include the failure reason in the disposition metadata, not just a log entry. The spec implies this ("auto-dismiss with log") but making it explicit would help debugging.

---

## Helper Script Approach

The shift from "sub-agent writes JSON directly" to "sub-agent calls a helper script" is arguably the most impactful architectural change in v2. It:

- **Reduces prompt tokens** from ~130 to ~80 (under the 100-token target)
- **Shifts correctness responsibility** from the LLM to deterministic code
- **Centralizes security controls** (signing, rate limiting, secret scanning) in one enforceable location
- **Simplifies the sub-agent contract** to a CLI invocation instead of a JSON format specification

This is a textbook example of "structure over willpower" — rather than instructing the LLM to produce valid, signed, rate-limited JSON (and hoping it complies), the system guarantees these properties through tooling.

The only risk: the helper script becomes a critical path dependency. If it has a bug, no findings can be captured. Mitigation: the script is simple (JSON construction + HMAC + file write), testable in isolation, and its failure mode is safe (no finding captured, not a corrupted finding).

---

## Implementation Plan Changes

The plan grew from 4 hours (6 steps) to 6 hours (8 steps). The additions:

- **Step 1 expanded**: Now includes HMAC signing, rate limiting, secret scanning in the helper script. Justified by the security model.
- **Step 4 (new)**: Worktree copy-back integration. Was "future work" in v1, now Phase 1. Correctly reprioritized.
- **Step 8 (new)**: End-to-end example. Addresses the DX reviewer's request for a concrete walkthrough.

The 6-hour estimate is tight but feasible. The helper script (Step 1, 1 hour) is the highest-risk item — it does the most work and has the most edge cases (HMAC computation, secret scanning regex, rate limit state tracking). If any step slips, it will be this one. Recommendation: allow 1.5 hours for Step 1.

---

## New Concerns (Round 2)

### 1. Secret Scanning Fidelity (Low Risk)

The spec mentions "basic pattern scan for common secret formats" in the helper script. This is appropriate for a first pass, but regex-based secret scanning has well-documented false positive and false negative rates. This should be explicitly scoped as a best-effort check, not a security guarantee. The real protection is that findings don't sync to git (`.gitignore`) and patch files route through evolution proposals with human review.

### 2. Session ID Availability in Worktrees (Low Risk)

HMAC key derivation uses `sessionId`. In worktree-isolated sub-agents, the session ID may come from the Agent tool's spawning context rather than the sub-agent's own context. The spec should clarify how the helper script obtains the session ID in worktree mode. If unavailable, a fallback (e.g., a generated UUID) should be used — the key derivation should not fail silently.

### 3. Helper Script Portability (Low Risk)

The helper script is a shell script (`.sh`). HMAC-SHA256 computation in pure bash requires either `openssl dgst`, `python3 -c "import hmac..."`, or a similar dependency. The spec should note which tool is used and verify it exists in the standard agent environment. Given that `python3` is already a dependency for other instar scripts, `python3` for HMAC is the safe choice.

---

## What Works Well (Preserved From v1, Strengthened in v2)

1. **Design Principle 3** (separate capture from evaluation) remains the key architectural insight and is now reinforced by the security model's content isolation.

2. **Evolution system integration** is even cleaner in v2 with the mandatory review flag for serendipity-originated proposals. The `origin: serendipity` tag is a minimal, traceable annotation.

3. **Zero overhead when unused** is preserved. The helper script, directories, and hook checks are all lazy/conditional. An agent that never spawns sub-agents pays nothing.

4. **The rename** from "Discovery" to "Serendipity" is well-justified and avoids the A2A/ANP collision. The `srdp-` prefix for IDs is distinctive.

5. **Configuration section** with `serendipity.enabled: false` provides clean opt-out. All configurable parameters (max per session, patch size, retention days, TTL) have sensible defaults.

6. **Observability section** defines meaningful metrics (triage rate, disposition breakdown, compliance rate) that enable calibration of the sub-agent prompt over time.

---

## Overall Architecture Coherence

The v2 spec is a cohesive document. The security model, worktree handling, helper script, state machine, retention policy, and configuration are all integrated — they reference each other correctly and don't create contradictions or redundant mechanisms.

The architecture remains what I praised in Round 1: **restrained**. File drops, JSON files, directory conventions, a helper script, and a decision tree. No new services, no new protocols, one new script dependency. The security additions are woven into the existing structure rather than bolted on as a separate layer.

The design correctly identifies that the hardest problem is not technical but behavioral: getting sub-agents to capture findings without polluting primary work, and getting parent agents to triage them without ignoring or rubber-stamping them. The helper script solves the capture side; the mandatory evolution review solves the triage side. Both are structural solutions, not instructional ones.

---

## Summary

Round 1 approval stands, strengthened. The v2 spec transforms a sound but under-hardened design into a production-ready protocol. The security model is proportionate. The worktree isolation is concrete. The helper script is the right abstraction. The state machine is clean. The retention policy is defined. The implementation plan is realistic.

The three new concerns (secret scanning fidelity, session ID in worktrees, helper script portability) are all low-risk implementation details that do not affect the architecture. They should be addressed during Step 1 implementation, not in the spec.

This is ready to build.
