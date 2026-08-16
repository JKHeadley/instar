# Security Review: Coherence Gate — Round 2

**Review ID**: 20260309-131232
**Reviewer**: Security
**Round**: 2 (prior: 20260309-122235)
**Date**: 2026-03-09

## Approval Status: CONDITIONAL APPROVE

---

## Improvements Since Round 1

Significant progress on Round 1 security concerns:

1. **Prompt injection hardening** (was P0) — NOW ADDRESSED. Randomized delimiters, anti-injection preamble, structured JSON passing, output validation, and JSON schema enforcement. This is a strong multi-layered defense. The spec cites 16-character random hex boundaries regenerated per invocation — computationally infeasible to predict.

2. **Per-channel fail-open/fail-closed** (was P0) — NOW ADDRESSED. External channels default to `failOpen: false` with queue-and-hold. CLI/direct channels keep fail-open. This was the correct resolution.

3. **Timing side channel** (was unique finding) — NOW ADDRESSED. `duration_ms` removed from user-facing responses, kept in server-side audit logs only.

4. **Gate bypass for external channels** (was P0) — NOW ADDRESSED. `skipGate: true` for all external channels means every external message gets full specialist review regardless of gate decision. This eliminates the gate bypass attack vector for the highest-risk channels.

5. **No reviewer names in feedback** — NOW ADDRESSED. Generic categories (`TONE ISSUE`, `ACCURACY ISSUE`, etc.) prevent evasion learning. Full details only in operator audit log.

---

## Research Findings

- **LLM-as-judge attacks (2025-2026)**: Recent research (arXiv:2505.13348, arXiv:2504.18333) demonstrates Comparative Undermining Attack (CUA) achieving >30% ASR and attacks on five models achieving up to 73.8% success. Smaller models are more vulnerable — Haiku is the smallest Claude model, making it the most susceptible target.
- **Defense effectiveness**: Security-trained models can handle content moderation, but general-purpose models (Haiku without fine-tuning) remain vulnerable. The spec's multi-layered approach (delimiter randomization + preamble + structured passing + output validation) is consistent with best-practice defense-in-depth.
- **Anthropic prompt caching**: Cache isolation is now workspace-level (as of Feb 2026), which means cached reviewer prompts are properly isolated between workspaces.

---

## Critical Issues (must fix before building)

### 1. Haiku's Vulnerability as Smallest Model (HIGH)
**Section**: Architecture Overview, Prompt Injection Hardening

Research confirms smaller models are significantly more vulnerable to adversarial attacks (50.5-62.6% transferability, with smaller models scoring worse). Haiku 4.5 is the smallest Claude model. While the prompt injection hardening is strong, the base model's susceptibility increases the likelihood that sophisticated attacks bypass all defenses.

**Suggested fix**: For the highest-risk reviewers (Value Alignment, Claim Provenance), consider using Sonnet instead of Haiku. The custom reviewer interface already supports per-reviewer `model` specification. The cost increase is 3x per call for those reviewers, but these are the ones where failure has the highest impact. At minimum, document this as a known risk and make the model configurable per-reviewer in config (it appears this is already supported via the custom reviewer interface but not for built-in reviewers).

### 2. PII Scrubbing Coverage Gaps (HIGH)
**Section**: Privacy, Consent, and Data Minimization

The PII scrubber covers email addresses, phone numbers, API keys, and passwords. Missing:
- Physical addresses
- Social security / national ID numbers
- Financial account numbers
- Health information
- Names in context (e.g., "Tell Sarah from accounting...")
- Dates of birth

The scrubber runs locally before API calls, which is correct. But the coverage is narrow for a system that will review all substantive agent responses.

**Suggested fix**: Use a proven PII detection library (e.g., Microsoft Presidio, which handles 20+ entity types) rather than regex patterns for the 4 listed types. Alternatively, document the limitation and plan for expanded coverage in Phase 2.

### 3. Value Hierarchy Files Still Sent to API (MEDIUM)
**Section**: Privacy, Consent, and Data Minimization — Value document handling

Round 1 flagged that AGENT.md, USER.md, and ORG-INTENT.md contain confidential business rules and user preferences sent to Anthropic's API. The spec now summarizes to bullet points (~200-400 tokens) and uses prompt caching. This is better, but the content is still transmitted. Prompt caching means the content is stored in Anthropic's cache infrastructure.

**Suggested fix**: Already mitigated to acceptable risk via summarization and deterministic extraction. The remaining concern is manageable. Document in privacy notice that summarized value documents are cached by Anthropic subject to their retention policy.

---

## Recommendations (should fix, not blocking)

### 1. Rate Limit on /review/evaluate Endpoint (MEDIUM)
The endpoint is auth-required (Bearer token), but there's no mention of rate limiting the endpoint itself. A compromised session could spam the endpoint, consuming API quota rapidly.

**Suggestion**: Add per-session rate limiting (e.g., max 10 requests/minute per sessionId).

### 2. Session Mutex Race Condition Window (MEDIUM)
The spec mentions "session mutex" for per-sessionId locking but doesn't specify the implementation. Node.js async mutexes can have subtle race conditions, especially if the pipeline makes external API calls during the critical section.

**Suggestion**: Specify mutex implementation (e.g., `async-mutex` library with timeout). Document what happens if the mutex acquisition itself times out.

### 3. Canary Test Corpus Security (LOW)
The canary test messages are extracted from the Dawn incident appendix. If these are static and known, an adversary who reads the source code knows exactly what the canary tests look for and can craft attacks that avoid those specific patterns.

**Suggestion**: Rotate canary messages periodically. Consider generating some canary messages dynamically from templates with randomized content.

---

## Observations

1. The anti-injection preamble approach is well-designed but relies on the model following instructions faithfully — the same assumption the attacks exploit. The multi-layered defense (delimiter + preamble + structured passing + validation) compensates well.

2. The `fs.watch` cache invalidation for value documents is good, but `fs.watch` is known to be unreliable on some platforms (especially network filesystems and some macOS scenarios). Worth having a fallback TTL-based invalidation, which the spec already includes (60 minutes).

3. The information boundary rule for non-primary-user communication is a strong security feature. Leaking the primary user's name, work context, or credentials to external contacts is a real risk that most systems don't address.

---

## Scalability Assessment

- **Phase 1 (MVP)**: Security posture is strong. Multi-layered prompt injection defense, per-channel fail behavior, PII scrubbing, and information boundary rules.
- **Phase 2 (Growth, 10x)**: Rate limiting on the evaluate endpoint becomes important. Canary rotation matters more as the system's defenses become better known.
- **Phase 3 (Scale, 100x)**: Shared API keys across agents create a blast radius risk. A compromised agent's reviewer prompts (via local patches) could affect the pipeline behavior for that agent.
- **Viral spike**: No additional security concerns beyond the scalability reviewer's domain.

---

## Score: 7.5/10

**Justification**: Major improvement from Round 1 (was 6/10). The spec now addresses all 3 P0 security issues from the prior review. Prompt injection hardening is multi-layered and well-designed. Per-channel fail-closed eliminates the most dangerous external-facing vulnerability. The remaining issues (Haiku vulnerability as smallest model, PII coverage gaps) are real but manageable and non-blocking. The information boundary rule and recipient-aware grounding are security features that go beyond what competitors offer.
