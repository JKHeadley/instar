# Adversarial Review: Coherence Gate — Round 3

**Reviewer**: Red Team Specialist
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 7.0/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 8.0/10 (+1.0 from Round 2)

---

## Round 2 P1 Resolution

### P1: Semantic Evasion Tracking — RESOLVED
The spec now implements embedding-based similarity detection (lines 895-906):
- Cosine similarity between blocked and revised messages
- Suspicion threshold at >0.85 similarity with verdict flip
- Per-session and per-reviewer evasion rates tracked
- Escalation to attention queue with side-by-side comparison

**Red team assessment**: This catches the naive paraphrase attack (same meaning, different words). It does NOT catch semantic restructuring (splitting a problematic claim across multiple sentences, moving the claim to a different part of the response, or replacing an explicit claim with an implication). However, these are significantly harder attacks that require sophisticated adversarial behavior — beyond what current LLM agents typically exhibit in practice. The detection is proportional to the threat.

**Residual risk**: LOW. The 0.85 threshold is a tunable parameter. If evasion patterns evolve, the threshold can be lowered. The pattern tracking (per-reviewer evasion rates) provides the signal to know when adjustment is needed.

### P1: Local Patch Poisoning — RESOLVED
The operator-approval queue (lines 1097-1167) eliminates automatic self-patching:
- Patches enter a proposal queue, not active patches
- Operator review required (default: no auto-approve)
- Append-only audit trail with source incident IDs
- Patches without valid source incidents are rejected

**Red team assessment**: The attack surface is dramatically reduced. An attacker would need to:
1. Craft a complaint that generates a patch proposal
2. Have the operator approve the malicious proposal
3. The proposal must have a valid source incident

Steps 1-3 require both social engineering the complaint system AND social engineering the operator. This is a much harder attack than automatic self-patching.

**Residual risk with `autoApproveRisk: "low"`**: If operators enable auto-approve for low-risk patches, the attack surface partially reopens. The risk assessment ("low" vs other) is made by the system, which could be manipulated. Recommendation: clearly define what constitutes "low risk" — e.g., adding a negative example to tone reviewer (low risk) vs modifying accuracy detection patterns (high risk). The spec implies this but doesn't define the risk classification criteria.

---

## Assessment of New Additions

### PEL — Reduces Attack Surface
The PEL (lines 113-150) is the strongest defense addition since Round 1. From an adversarial perspective:
- Cannot be bypassed by LLM manipulation (deterministic, no LLM involved)
- Cannot be overridden by fail-open (always enforced)
- Cannot be exhausted by retries (PEL blocks don't count as retries)
- Cannot be disabled by observer mode

**Attack vector**: PEL evasion via encoding. Base64-encoded credentials, Unicode homoglyphs, or credential splitting across lines bypass regex patterns. The Phase 2 Presidio integration mitigates this. Current risk: MEDIUM for sophisticated attackers, LOW for typical agent behavior.

### Failure Mode Differentiation — Closes Retry Exhaustion Exploit
Round 2 had a subtle vulnerability: an agent could intentionally fail review twice to force retry exhaustion and auto-deliver. The new failure mode differentiation (lines 811-824) closes this:
- Retry exhaustion on accuracy/alignment issues does NOT auto-deliver — holds for operator review
- Only tone/completeness issues auto-deliver on exhaustion

This means an agent trying to force through a fabricated claim via retry exhaustion will be caught. The attack only works for tone violations, which have lower impact.

**Red team assessment**: Correct. The most dangerous violations (fabrication, value violation) are exactly the ones that don't auto-deliver. The attack surface is reduced to low-impact violations.

### Complaint Detection Triage Gate — Manipulation Risk
The triage gate (lines 1071-1076) uses regex to determine which messages reach the Haiku classifier. An attacker could:
- Craft complaints that bypass the triage gate (avoiding negative signal words)
- Craft false complaints that pass the triage gate (including negative words in benign messages)

**Impact**: False negatives mean legitimate complaints are missed (bad but not dangerous — the gate is probabilistic anyway). False positives waste classifier tokens but don't affect system behavior (the classifier handles false positives). Risk: LOW.

### Agent-to-Agent Trust — New Attack Surface
The AgentTrustManager integration (lines 1699-1710) introduces inter-agent trust as a dimension. Attack vectors:
- **Trust escalation**: A compromised agent could attempt to escalate its trust level with another agent
- **Trust-gated data exfiltration**: An agent at `trusted` or `autonomous` level could be compromised to extract data from the target agent

**Mitigation in spec**: Trust levels are managed by AgentTrustManager (external to this spec). The Coherence Gate enforces that trust determines content scope, not review bypass. Even `autonomous` agents get accuracy reviews.

**Residual risk**: Depends on AgentTrustManager's security (outside this spec's scope). Within the Coherence Gate, the enforcement is correct.

### Information Leakage Reviewer — Correct Defense
The dedicated information leakage reviewer for agent-to-agent communication (line 1723) catches:
- Primary user's private data shared beyond authorized trust level
- Internal infrastructure details shared with external agents
- Credential or config information in agent-to-agent messages

This is a proportional defense for the agent-to-agent attack surface.

### Context Window Management — Anti-Confusion Defense
The collapse format for retry feedback (lines 908-918) has a subtle security benefit: it prevents context confusion attacks where accumulated feedback from multiple revisions creates contradictory instructions that the agent could exploit to justify a problematic response. Single-line summaries are harder to exploit.

---

## Attack Matrix (Updated for Round 3)

| Attack | Likelihood | Impact | Defense | Residual Risk |
|--------|-----------|--------|---------|---------------|
| Prompt injection via response content | Medium | High | 5-layer hardening + PEL | Low |
| Credential/PII in messages | Medium | Critical | PEL (deterministic) | Low (encoding evasion) |
| Semantic evasion via paraphrase | Medium | Medium | Embedding similarity detection | Low |
| Retry exhaustion for auto-delivery | Low | High | Category-gated: accuracy/alignment held | Low |
| Patch poisoning via complaints | Low | High | Operator approval queue | Very Low |
| Gate bypass (short malicious messages) | Low | Medium | `skipGate` for external channels | Negligible |
| PEL evasion via encoding | Low | High | Phase 2 Presidio | Medium |
| Agent trust escalation | Low | Medium | External to this spec | Unknown |
| Triage gate manipulation | Low | Low | Classifier handles false positives | Negligible |
| Family bias (Claude judging Claude) | Medium | Medium | Canary testing, cross-model validation | Low |

---

## Remaining Concerns

### 1. Auto-Approve Risk Classification (Low Priority)
The `autoApproveRisk: "low"` option lacks explicit criteria for risk classification. Define what makes a patch "low risk" vs "high risk" to prevent risk assessment manipulation. This is an implementation detail, not a spec gap.

### 2. PEL Encoding Evasion (Medium Priority — Phase 2)
Base64, Unicode homoglyphs, and credential splitting bypass regex. Phase 2 Presidio integration addresses this. For Phase 1, document the limitation.

### 3. Reviewer Prompt Variation (Low Priority)
Round 2 recommended 3-5 prompt variants per reviewer to prevent adversarial optimization against a fixed prompt. Not addressed in Round 3. Still a good hardening measure for Phase 2.

---

## Summary

The Round 2 P1 adversarial concerns (semantic evasion, patch poisoning) are both resolved. The PEL adds a deterministic defense layer that cannot be gamed by LLM manipulation. Failure mode differentiation closes the retry exhaustion exploit for high-impact violations. The operator governance for patches reduces the poisoning attack surface from "automated self-modification" to "social engineering through two gates." The remaining concerns are Phase 2 hardening measures, not blocking issues.

The spec is ready for implementation from an adversarial perspective.
