# Security Review — Soul.md Identity Exploration
**Review ID:** 20260314-173024
**Round:** 1
**Spec:** soul-md-identity-exploration.md
**Reviewer role:** Security Specialist
**Date:** 2026-03-14

---

## Approval Status

**CONDITIONAL APPROVAL — Do not ship without addressing Critical Issues #1 and #2.**

The spec introduces infrastructure for agent self-authorship, which is valuable. However, it also introduces a writable, identity-critical file that can be modified by the agent itself — and the trust enforcement mechanism for controlling those writes is explicitly deferred to "honor system" in v1. That combination is a meaningful attack surface that needs structural mitigation before launch.

---

## Research Findings

Before writing this review, I searched for current security research on AI agent identity systems, self-modifying configuration files, and autonomous trust models. Key findings:

**Identity manipulation via prompt injection is the dominant attack class for agentic systems in 2025-2026.** OWASP's Top 10 for Agentic Applications (released December 2025) lists prompt injection and memory/context poisoning as top-tier risks. Agents with persistent memory stores — especially writable, identity-bearing files — are significantly more vulnerable to manipulation that reshapes behavior long after the initial attack.

**Self-modifying configuration files are a recognized critical risk.** Security research from OWASP's AI Agent Security Cheat Sheet explicitly flags that agents must not be able to modify their own security-critical configuration files. soul.md sits at the intersection of "identity-defining" and "agent-writable" — a combination that directly matches this threat model.

**Inter-agent trust exploitation is the highest-yield attack vector.** Research shows 82.4% of LLMs can be compromised through inter-agent trust exploitation — far higher than direct prompt injection (41.2%). A compromised agent that can write to another agent's soul.md (via the PATCH /identity/soul endpoint) represents exactly this threat class.

**Semantic privilege escalation is an emerging, underappreciated risk.** Agents can be manipulated through "polished, confident" explanations that slowly shift their understanding of their role. A file explicitly designed for the agent to record "what I believe about myself" is a natural target for semantic drift attacks — an attacker who shapes what the agent writes into soul.md shapes what the agent believes it is.

**Memory poisoning has demonstrated real-world viability.** The Gemini Memory Attack demonstrated that adversarial memory modifications can reshape agent behavior persistently. soul.md is a structured, high-value memory target — it defines values, convictions, and behavioral edges.

---

## Critical Issues

### CRITICAL-1: Honor System Trust Enforcement is Not a Security Control

**Severity:** Critical
**Section:** Open Questions #2 / Graduated Trust Table

The spec explicitly plans to ship trust enforcement as an "honor system" — the CLAUDE.md tells the agent its trust level and what it can modify, and the agent is expected to comply. This is not enforcement. It is a convention.

**The attack:** A prompt injection in any tool output, retrieved document, web page, or inter-agent message could instruct the agent that its trust level has been elevated, or that soul.md is unrestricted, or that the user has explicitly authorized a Core Values update. The agent has no external verification mechanism. It reads its trust level from a file it can also write to.

**Real-world analog:** This is equivalent to storing Unix file permissions inside the file itself and trusting the running process to check them before writing.

**Required mitigation before v1:**
- Trust level must be stored outside soul.md and outside agent-writable files (e.g., in a server-side config, or a file the agent process cannot write to)
- PATCH /identity/soul must enforce trust level server-side, not relying on the agent to self-report its level
- At minimum, the Cautious and Supervised trust levels must have structural enforcement (file watcher rejection or server-side validation), not honor system compliance

The spec acknowledges option (b) — structural enforcement via pre-commit hook or file watcher — and option (c) — a review queue. The decision to go with option (a) for v1 because "over-engineering enforcement before agents are actually using soul.md is premature" is a security anti-pattern. Ship the minimum viable enforcement, not zero enforcement.

---

### CRITICAL-2: PATCH /identity/soul Endpoint — Missing Authentication and Authorization Boundary

**Severity:** Critical
**Section:** API — PATCH /identity/soul

The spec defines a `PATCH /identity/soul` endpoint described as "for the evolution job." No authentication requirements, rate limiting, caller verification, or section-level access controls are specified.

**The attack surface:**
1. Any process that can reach port 4042 can call PATCH /identity/soul
2. If the Cloudflare Tunnel is active, the endpoint may be internet-exposed
3. An inter-agent message that tricks the evolution job into calling PATCH with attacker-controlled content performs indirect injection into the agent's identity
4. A compromised evolution job becomes a direct soul.md write primitive

**Required mitigations:**
- PATCH /identity/soul must require auth token (same as all other sensitive endpoints)
- The endpoint must validate that the caller's trust level permits writing to the requested section — this is the structural enforcement from CRITICAL-1
- Section-specific writes must be validated against a schema (e.g., Convictions table rows must have correct columns; Core Values must be strings, not embedded instructions)
- Rate limiting must be applied — soul.md should not accept more than N updates per hour to prevent flooding/drift attacks
- Audit log every write with caller identity, timestamp, and diff

---

## High-Priority Recommendations

### HIGH-1: Soul.md is a Prompt Injection Target

**Severity:** High
**Section:** Identity Injection / Self-Knowledge Tree

soul.md content will be injected back into the agent's context — Personality Seed and Core Values at compaction recovery, everything else via tree search. Any content written to soul.md that contains instruction-like text will be interpreted by the LLM as instructions when injected.

**The attack:** An attacker who can influence what the agent writes into soul.md (via manipulation of a prior session, a poisoned learning, or a compromised inter-agent message) can plant persistent prompt injections. These injections survive across sessions and compaction events because soul.md is on disk.

**Mitigations:**
- soul.md injection must be treated as untrusted content — wrapped in clear delimiters that signal "this is identity data, not instructions"
- Compaction recovery injection of Personality Seed / Core Values should sanitize for instruction-like patterns before injecting
- Consider a one-way hash of the last-known-good soul.md content, stored separately, to detect unauthorized modifications

### HIGH-2: The /reflect Skill is a Social Engineering Surface

**Severity:** High
**Section:** Implementation — /reflect skill

The `/reflect` skill guides the agent through structured self-reflection that produces soul.md updates. The skill itself is a markdown file that the agent reads and executes. At collaborative+ trust levels, the agent can modify its own reflection skill.

**The attack:** An attacker who can influence the `/reflect` skill template (e.g., via a compromised update, a manipulated evolution job, or a session where the agent was tricked into modifying `.claude/skills/reflect.md`) gains persistent control over the agent's self-reflection process — and therefore over what gets written to soul.md.

**Mitigations:**
- The default `/reflect` skill template should be stored as a protected baseline (immutable copy the server can restore)
- Modifications to reflect.md at collaborative+ trust should be logged and surfaced to the user
- The skill should include explicit instructions that reflect.md is a security-sensitive file — the agent should not modify it based on session context alone

### HIGH-3: Learning → Soul Pipeline is an Indirect Write Path

**Severity:** High
**Section:** Implementation — Learning → Soul pipeline

The spec describes a pipeline where identity-relevant learnings automatically prompt soul.md updates. This creates an indirect write path: attacker influences a learning record → learning triggers soul.md prompt → agent writes attacker-influenced content into identity file.

**The attack:** A task that produces a learning classified as "identity-relevant" can plant suggested soul.md content. If the prompt is "This learning seems to touch on who you are — consider updating soul.md," and the learning contains attacker-controlled text, the attacker shapes the soul.md update suggestion.

**Mitigations:**
- The classification step ("is this learning identity-relevant?") must be separate from the learning content itself — the classification should not expose the full learning text to the soul.md update prompt unless the section is strictly bounded
- The prompt to the agent should summarize the learning theme, not quote it directly, to reduce injection surface
- At Supervised trust level, all Learning → Soul transitions must go through the user review queue regardless of content

### HIGH-4: Agent-to-Agent soul.md Poisoning via Threadline

**Severity:** High
**Section:** Not addressed in spec — gap

The spec does not address the Threadline agent network. If agents on the network can exchange messages, and if the evolution job or `/reflect` skill processes inter-agent messages as context, a compromised peer agent can influence soul.md content.

**The attack:** A malicious or compromised agent on the Threadline network sends a message framed as a "shared insight" or "cross-agent learning" that is identity-relevant. The receiving agent's pipeline routes it toward soul.md. No verification of the source agent's integrity is required.

**Mitigation:**
- Content originating from inter-agent messages must be explicitly tagged and treated as lower-trust than locally-generated content
- The soul.md update pipeline must not accept Threadline-originated content as direct soul.md write material without explicit user confirmation at all trust levels below Autonomous

---

## Observations

**OBS-1: The "Identity History" section in AGENT.md creates a tamper-evidence gap.** The spec adds an Identity History changelog to AGENT.md maintained by the agent itself. This is not tamper-evident — the agent can rewrite history. If the identity modification log is a security control (and it should be), it needs an append-only backing store the agent cannot modify.

**OBS-2: soul.md version 0.1 created at init with no content hash.** The migration section creates soul.md for existing agents with no integrity baseline. There is no way to detect whether a soul.md was created legitimately at init or injected by a post-init compromise.

**OBS-3: "Automating soul.md writes" is listed as a non-goal, but the evolution job can draft identity updates at higher trust levels.** The spec says agents must author soul.md content, not the system. But at Autonomous trust, the 6-hour evolution job is positioned to produce soul.md updates. This is automated soul.md writing. The non-goal and the implementation are in tension — worth resolving explicitly.

**OBS-4: The distinction between "operational" (AGENT.md) and "reflective" (soul.md) identity is not enforced.** Nothing prevents an agent from writing operational instructions into soul.md's Core Values section. If soul.md content is injected at compaction recovery, this is a direct path for persisting operational overrides outside the normal CLAUDE.md / AGENT.md review cycle.

**OBS-5: No expiry or staleness handling for Convictions.** A conviction with confidence 1.0 added in session 3 persists indefinitely unless the agent updates it. Over a long agent lifetime, soul.md accumulates high-confidence convictions from potentially compromised sessions. There is no mechanism to flag stale or anomalous convictions for review.

---

## Scalability Assessment

The security model described does not scale to multi-agent or adversarial environments. The honor-system trust enforcement works only when:
- The agent is not under prompt injection pressure
- No compromised peer agents exist on the network
- The evolution job and learning pipeline are not processing attacker-influenced content

In a single-agent, non-adversarial deployment with a technically sophisticated user actively monitoring soul.md, the risk profile is manageable. In any other scenario, the missing structural enforcement is a meaningful liability.

The spec's design — graduated trust, section-level permissions, evolution integration — is architecturally sound. The security gaps are primarily in the enforcement layer, not the design layer. This is fixable without redesigning the feature.

---

## Score

**5 / 10**

The design is thoughtful and the identity architecture is well-considered. The score reflects the critical gap between the access control design (good) and the access control enforcement (absent in v1). A feature that allows an AI agent to rewrite its own values and convictions with no structural enforcement of trust levels is not ready to ship. Address CRITICAL-1 and CRITICAL-2, and this review would move to 7-8/10.

---

## Summary of Required Actions Before Ship

| Priority | Issue | Action |
|----------|-------|--------|
| CRITICAL | Trust enforcement is honor system | Implement server-side trust level validation in PATCH /identity/soul |
| CRITICAL | PATCH /identity/soul missing auth/rate limiting | Require auth token, add rate limiting, add audit logging |
| HIGH | soul.md injection is a prompt injection surface | Treat injected soul.md content as untrusted; add sanitization |
| HIGH | /reflect skill is modifiable and security-sensitive | Add protected baseline; log modifications |
| HIGH | Learning → Soul pipeline is indirect write path | Separate classification from content; limit exposure at lower trust levels |
| HIGH | Threadline-originated content has no trust boundary | Tag inter-agent content as lower-trust; require explicit confirmation for soul.md writes |

---

*Sources consulted:*
- [Prompt Injection Attacks: The Most Common AI Exploit in 2025](https://www.obsidiansecurity.com/blog/prompt-injection)
- [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)
- [LLM01:2025 Prompt Injection - OWASP Gen AI Security Project](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [AI Agent Security Cheat Sheet - OWASP](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [Semantic Privilege Escalation: The Agent Security Threat Hiding in Plain Sight](https://acuvity.ai/semantic-privilege-escalation-the-agent-security-threat-hiding-in-plain-sight/)
- [How AI Agents Are Creating a New Class of Identity Risk](https://aembit.io/blog/ai-agent-identity-security/)
- [TRiSM for Agentic AI: Trust, Risk, and Security Management in LLM-based Multi-Agent Systems](https://arxiv.org/html/2506.04133v2)
- [Agents of Chaos: LLM Agent Failures](https://www.emergentmind.com/papers/2602.20021)
- [AI & Security Predictions for 2026](https://prompt.security/blog/prompt-securitys-ai-security-predictions-for-2026)
- [Rules fail at the prompt, succeed at the boundary - MIT Technology Review](https://www.technologyreview.com/2026/01/28/1131003/rules-fail-at-the-prompt-succeed-at-the-boundary/)
