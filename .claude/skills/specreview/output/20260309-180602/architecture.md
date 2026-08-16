# Architecture Review: Cross-Topic Injection Defense

**Review ID:** 20260309-180602
**Round:** 1
**Reviewer:** Systems Architect
**Spec:** `/Users/justin/.instar/agents/echo/specs/cross-topic-injection-defense.md`

---

## Approval Status

**APPROVED WITH RECOMMENDATIONS**

The architecture is sound, well-motivated by a real incident, and appropriately scoped. The layered defense model (deterministic provenance check, LLM coherence review, warning injection) follows established security patterns and makes good tradeoff decisions. The recommendations below address gaps that should be resolved before or during implementation, but none are blockers.

---

## Score: 8/10

Strong design grounded in a real incident with clear constraints, good layering, and honest acknowledgment of limitations. Loses points for: tmux-level attack surface not addressed, no cryptographic provenance, and the LLM-reviewing-LLM-input pattern has inherent limitations that deserve more discussion.

---

## Research Findings

### AI Agent Context Isolation (Industry Patterns)

The OWASP Top 10 for Agentic Applications 2026 identifies context leakage between agent domains as a top-tier risk. The industry consensus is: strict isolation boundaries must prevent context leakage between users, tenants, and agent domains, with memory retrieval mechanisms strictly respecting authenticated identity and permissions. MCP security guidance recommends running agent processes in sandboxed environments (gVisor, Kata Containers, SELinux) and exposing capabilities through narrowly scoped APIs rather than direct system access.

**Relevance to this spec:** The spec operates at the application layer (message routing) rather than the process isolation layer. This is pragmatic given the tmux-based architecture, but it means the defense is advisory rather than structural. Industry best practice would add process-level isolation as a complementary layer.

### MCP Server Security & Prompt Injection

Microsoft, Palo Alto Networks, and the MCP specification itself all converge on multi-layered defense: input validation, per-session resource locking ("one repository per session" pattern), consent controls, and continuous monitoring. A key pattern is treating all tool descriptions and external inputs as untrusted by default. The "confused deputy" attack — where an attacker tricks a trusted system into acting on behalf of an untrusted one — maps directly to the cross-topic injection scenario described in this spec.

**Relevance:** The spec's provenance check is analogous to MCP's request validation layer. The "warn, don't block" approach for untagged input is more permissive than MCP best practices (which favor deny-by-default), but appropriately so given that legitimate untagged input is a normal use case here.

### tmux Session Isolation

tmux provides no inter-pane isolation within a user session. Any process running as the same user can `send-keys` to any tmux session or pane. The `-L` flag can create separate tmux servers for stronger isolation, but within a single server, all sessions are accessible. This is well-documented as a privilege escalation vector in penetration testing literature.

**Relevance:** This is the fundamental attack surface the spec is defending against. The spec correctly identifies that `send-keys` is the injection vector but does not propose any tmux-level hardening. The defense is entirely at the application layer (message content analysis), not the transport layer (preventing unauthorized send-keys calls). This is a conscious tradeoff worth making explicit.

### LLM-Based Input Validation

OWASP and industry frameworks recommend a combination of pattern matching (keyword detection, regex filtering), semantic analysis (embedding similarity, anomaly detection), and dedicated validator LLMs as a "firewall" layer. The Rebuff project and OpenAI's Guardrails demonstrate production patterns for LLM-based injection detection. A key architectural insight: the validator LLM should be smaller and faster than the primary LLM, with a narrow prompt focused solely on classification — exactly what this spec proposes with Haiku.

**Relevance:** The spec's Topic Coherence Reviewer follows established patterns. Using Haiku as a lightweight classifier is the right call. However, the industry also recommends storing embeddings of previous attacks for pattern matching — the spec could benefit from a simple blocklist or embedding-based check before the LLM call.

---

## Critical Issues

### 1. tmux-Level Attack Surface Unaddressed

The spec correctly identifies `send-keys` as the injection vector but proposes no hardening at the tmux layer itself. Any process running as the same user can inject arbitrary text into any session. The entire defense relies on detecting bad content after it arrives, rather than preventing unauthorized delivery.

**Recommendation:** Consider using separate tmux sockets (`tmux -L`) per session category (topic-bound vs. standalone), or wrapping `send-keys` calls through a controlled gateway function that itself enforces provenance before forwarding to tmux. This would add a structural layer beneath the application-level checks.

### 2. Race Condition Between Review and Injection

The spec makes `injectMessage` async to accommodate the Haiku call, but doesn't address what happens if multiple messages arrive in rapid succession. The rate limiter (1 LLM call per 5s) with "fail-open within burst" means an attacker could flood a session with injected messages, with only the first being reviewed and subsequent ones passing through unchecked.

**Recommendation:** Queue messages during review rather than fail-open. If a review is in progress, hold subsequent untagged messages until it completes. The 1-3s review latency is acceptable for untagged messages (which are already unusual in topic-bound sessions).

### 3. Warning Injection Is Itself an Injection

The warning text prepended to suspicious messages is itself unstructured text injected into the LLM's context. A sophisticated attacker could craft a message that, when combined with the warning prefix, creates a new injection vector (e.g., closing the warning context and introducing new instructions). The warning becomes part of the prompt.

**Recommendation:** Use a structured format for the warning that the LLM is less likely to misparse. Consider using Claude's system-level message formatting if available in the tmux injection path, or at minimum wrap the warning and message in clearly delimited blocks (XML-style tags like `<injection-warning>` and `<suspicious-message>` that Claude's training recognizes as structural).

---

## Recommendations

### R1: Add a Deterministic Pre-Filter Before LLM Review

Before invoking Haiku, run a fast pattern match for known injection signatures: "ignore previous instructions," "you are now," "system override," zero-width characters, Base64-encoded blocks, and the specific pattern observed in the incident ("I just received a message from X"). This reduces LLM calls further and catches obvious attacks at near-zero cost. The OWASP prompt injection cheat sheet provides a good starting list.

### R2: Persist Attack Patterns for Learning

When a message is classified as SUSPICIOUS, store its embedding or a normalized fingerprint. Over time, build a local blocklist that catches repeat patterns without an LLM call. This is the "embedding store" pattern used by Rebuff and similar tools. Even a simple hash-based deduplication would help.

### R3: Clarify Dashboard Allowlisting Timeline

Phase 3 (Dashboard Allowlisting) should be Phase 1 or at most Phase 1.5. Without it, dashboard users of topic-bound sessions will trigger false positives on every input. If Phase 1 ships with monitoring mode, the security log will be noisy with legitimate dashboard input, making it harder to spot real injections. At minimum, add a `INSTAR_INPUT_SOURCE` signal to dashboard input from the start, even if the full allowlisting logic comes later.

### R4: Address Open Question 1 Definitively

Mismatched tags should be hard-blocked. A message tagged `[telegram:42]` arriving at a session bound to topic 116 is always a routing bug — there is no legitimate cross-topic forwarding in the current architecture. If cross-topic forwarding is needed in the future, it should use a dedicated mechanism (e.g., `[forwarded-from:42]`) rather than weakening the provenance check. Indecision here creates implementation ambiguity.

### R5: Address Open Question 3 — Fail-Open Is Correct

Fail-open on timeout is the right call, but add a counter. If the coherence reviewer times out more than N times in a window, that itself is suspicious (possible DoS on the review layer) and should trigger an attention queue item. Fail-open should not be silent.

### R6: Consider Bidirectional Defense (Open Question 4)

The existing output-side Coherence Gate should be enhanced to detect topic drift in responses, not just inputs. If a session starts responding about Dawn/Threadline when it's bound to a Coherence Gate topic, the output reviewer should catch that even if the input reviewer was bypassed. This is defense-in-depth and can be a follow-up phase.

---

## Observations

### What the Spec Gets Right

1. **Incident-driven design.** The spec starts from a real failure, analyzes it thoroughly, and designs a defense that would have caught it. This is the right methodology — not speculative threat modeling but empirical hardening.

2. **"Warn, don't block" philosophy.** For untagged input, this is exactly right. Blocking would break legitimate use cases (dashboard, tmux attach). Warning transforms the LLM from a blind consumer of input into an informed evaluator. This is a sophisticated insight about how to work with LLMs rather than around them.

3. **Honest limitations section.** The spec explicitly states what it does NOT catch (topic-matching injections, unbound sessions, malicious users). This intellectual honesty is more valuable than a spec that claims to solve everything.

4. **Cost awareness.** The analysis showing <5 Haiku calls/day is realistic and shows the designer understands operational cost. Layer 1 handling the common case deterministically is good architecture.

5. **Configuration modes (warn/block/log).** Supporting multiple enforcement modes from the start enables progressive rollout: log → warn → block. This is operationally mature.

### Architectural Tensions

1. **Application-layer defense for a transport-layer problem.** The injection happens via tmux `send-keys`, which is a transport-level operation. The defense operates at the content level (analyzing what was sent). This is pragmatic but inherently incomplete — it's like defending against network injection by analyzing packet contents rather than authenticating the sender. The spec should acknowledge this tension more explicitly.

2. **LLM reviewing LLM input.** Using one LLM (Haiku) to validate input for another LLM (Claude) is a well-established pattern, but it has a fundamental limitation: both LLMs share similar vulnerabilities. An injection crafted to bypass Haiku's coherence check might also succeed against Claude. The spec partially addresses this by noting that topic-matching injections pass through — but the broader point is that LLM-based validation is a probabilistic defense, not a deterministic one.

3. **Environment variables for binding.** Using `INSTAR_BOUND_TOPIC` environment variables is simple but static — the binding is set at spawn time and can't change. If a session needs to handle multiple topics (merged threads, forwarded conversations), the env var approach won't scale. The spec notes this as a future concern, which is appropriate for now.

---

## Scalability Assessment

**Current scale:** The design handles the current workload well. With <5 Haiku calls/day and deterministic handling for the common path, there's no performance concern.

**10x scale:** Still fine. Even with 50 topic-bound sessions and 50 untagged messages/day, the Haiku cost is negligible and the provenance check is O(1).

**100x scale (multi-user, many agents):** Two concerns emerge:
1. The `security.jsonl` audit log will grow unbounded. Needs rotation or a size cap.
2. The topic coherence reviewer prompt includes "recent conversation" context. For very active topics, assembling this context per-review could become expensive. Consider caching the last-assembled context with a TTL.

**Architectural ceiling:** The environment-variable binding approach has a hard ceiling at one topic per session. Multi-topic sessions would require a registry lookup, which is a different architecture. This is fine for the current design but should be noted as a known scaling constraint.

---

## Summary

This is a well-designed, pragmatic defense against a real and security-critical vulnerability. The layered approach (deterministic provenance check → LLM coherence review → warning injection) follows industry best practices while respecting the constraints of the tmux-based session architecture. The main gaps are at the transport layer (no tmux-level hardening) and in the burst/race-condition handling. The recommendations above would strengthen the design without changing its fundamental architecture.

The spec demonstrates strong security thinking: starting from an incident, analyzing the attack surface honestly, designing proportional defenses, and acknowledging limitations. This is the kind of security work that actually ships and actually helps, rather than theoretical perfection that never gets built.
