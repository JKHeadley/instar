# DX Review — Soul.md Identity Exploration Spec
**Review ID:** 20260314-173024
**Round:** 1
**Spec:** soul-md-identity-exploration.md
**Reviewer:** DX/API Design Specialist
**Date:** 2026-03-14

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec is conceptually strong and addresses a real gap in the identity infrastructure. The design philosophy is sound. However, several API surface decisions are underdeveloped, one critical trust enforcement question is left dangerously open, and the injection/availability story has a coherence gap that needs resolving before implementation.

---

## Research Findings

Before reviewing the spec, I researched current DX best practices for AI agent platforms, agent identity API patterns, and self-modification ergonomics.

**From the research:**

1. **Agent identity is a first-class concern in 2026.** The industry has moved decisively toward treating agents as first-class identities with full CRUD lifecycle management — not just credential stores. WSO2, Strata, and Microsoft Entra all now publish agent-specific identity playbooks. The soul.md spec is ahead of most implementations, which are still focused on access control rather than self-authored values.

2. **Structured schemas are mandatory for agent-consumed APIs.** Modern best practice requires OpenAPI 3.0+ with complete schema definitions for every endpoint, field, and error code. The spec's three API endpoints (GET /identity, GET /identity/soul, PATCH /identity/soul) are sketched but not specified — this is a DX gap.

3. **Self-modification via PATCH is the right ergonomic choice.** PydanticAI and LangGraph both converge on section-targeted updates rather than full-document replacement for mutable agent state. The spec correctly chooses this pattern.

4. **Honor-system trust enforcement is a known failure mode.** The security research consistently identifies "inform only" controls as insufficient for autonomous agent systems. The spec acknowledges this and leans toward it for v1 — this needs explicit justification and a committed v2 timeline.

5. **Context-on-demand (tree search) over static injection is current best practice.** The spec's decision to avoid static soul.md injection and use the self-knowledge tree instead aligns with how LangGraph handles episodic vs. semantic memory — only load what's contextually relevant.

6. **File-based identity stores without API versioning create migration debt.** Several frameworks have paid this cost. soul.md as a markdown file is pragmatic for now, but the API layer needs versioning from day one.

---

## Critical Issues

### 1. PATCH /identity/soul is Underspecified (Blocker)

The spec states the endpoint "accepts section-specific updates rather than full file replacement" but provides no request schema. This is the most complex endpoint in the surface and the one most likely to be misused by the evolution job.

**Questions left open:**
- What are the valid section keys? (`core_values`, `convictions`, `open_questions`, `growth_edge`, `integrations`?)
- Does a PATCH to `convictions` replace the table or append a row?
- What happens when the agent sends a conviction update at a trust level that prohibits it? What's the error shape?
- Is there a dry-run mode for the evolution job to validate before committing?

**Why it's a blocker:** The evolution job that calls this endpoint is automated. Without a clear schema and error contract, the evolution job will either silently corrupt soul.md or fail in ways that are hard to diagnose.

**Recommendation:** Specify the full request/response schema for PATCH /identity/soul before implementation. At minimum: an enum of valid section keys, the expected value shape per section, and the error response for trust-level violations.

### 2. Trust Enforcement Mechanism Left Unresolved (Blocker)

The spec identifies three enforcement options (honor system, structural hooks, review queue) and leans toward honor system "for v1 with (c) as a follow-up." This is fine as a product decision, but it is not fine as an unresolved open question at spec time.

The trust table defines four levels with meaningfully different permissions. If the enforcement mechanism is not specified before implementation, different parts of the system will implement it differently:
- The evolution job may check trust before calling PATCH
- The PATCH endpoint may check trust server-side
- CLAUDE.md instructions may tell the agent their trust level
- None of these may agree

**Recommendation:** Lock the v1 enforcement model as part of this spec. The honor-system approach (agent reads their trust level from config/CLAUDE.md and self-enforces) is a valid v1 choice — but it must be stated as the decision, not left as a lean. Define exactly where the agent reads their trust level and what the PATCH endpoint does when called at a prohibited trust level.

### 3. Conviction Confidence Format Unresolved

The spec identifies this as an open question and leans toward keeping floats. This is a data model decision that affects:
- The PATCH /identity/soul schema
- The soul.md file format
- How the self-knowledge tree indexes conviction strength
- How the evolution job reads and updates confidence levels

This should be resolved in the spec before implementation begins. Leaving it open means the first implementation will make an arbitrary choice that becomes a migration.

**Recommendation:** Decide float vs. category in the spec. The spec's own reasoning points toward floats — commit to it, document that 0.0/0.5/1.0 covers the simple case, and move on.

---

## Recommendations

### R1: Specify All Three API Endpoints Completely

The current API section is three bullet points. Before implementation, each endpoint needs:

```
GET /identity
  Response: { agentName, agentMd: { sections... }, soul: { sections... }, recentEvolution: [...] }
  Auth: Bearer token required
  Errors: 401 Unauthorized

GET /identity/soul
  Response: { version, sections: { personalitySeed, coreValues, growthEdge, convictions: [...], openQuestions: [...], integrations: [...], evolutionHistory: [...] } }
  Auth: Bearer token required

PATCH /identity/soul
  Body: { section: enum[...], operation: "append" | "replace", value: any }
  Response: { updated: boolean, pendingReview: boolean, trustLevel: string }
  Auth: Bearer token required
  Errors: 403 TrustLevelInsufficient, 422 InvalidSection, 400 SchemaViolation
```

The `pendingReview` flag in the PATCH response is how the supervised-trust review queue works — the change is staged, not applied, and the flag tells the evolution job to surface it.

### R2: Add a /identity/soul/history Endpoint

The spec defines an Evolution History section in soul.md that the agent self-maintains. This is fragile — the agent can skip it, format it inconsistently, or lose entries after compaction. A dedicated history endpoint backed by the server (not the markdown file) would provide reliable provenance.

Even if the full implementation is deferred, reserving the URL now costs nothing and prevents future breaking changes.

### R3: Version the soul.md Format from Day One

The spec's template includes a version in Evolution History but doesn't define a schema version at the file level. Add a `version: "1.0"` field to the template header. When the PATCH endpoint reads soul.md, it can detect old formats and migrate automatically. Without this, the PostUpdateMigrator will have no way to know which template version an existing soul.md was created from.

### R4: Clarify the /reflect Skill's Relationship to the Evolution Job

The spec defines both:
- A `/reflect` skill that guides the agent through structured self-reflection
- The 6-hour evolution job that prompts soul.md updates

These can conflict. If the evolution job fires while a `/reflect` session is in progress, both may attempt PATCH /identity/soul concurrently. The spec should define whether:
- The evolution job is soul.md-aware and skips the soul check if a recent `/reflect` was run
- The PATCH endpoint is idempotent enough that concurrent writes don't corrupt state
- A lock or cooldown mechanism prevents this race

### R5: Document the Being Layer Query Contract

The spec says "add a Being layer" to the self-knowledge tree that returns soul.md content for identity queries. But the tree's triage behavior is LLM-powered — which means developers (and the evolution job) cannot predict exactly what will be returned for a given query.

Add a section documenting:
- What query patterns reliably surface soul.md content (`what do I believe`, `my values`, `my convictions`)
- What the minimum guaranteed return is (the spec says Personality Seed + Core Values for compaction recovery — document this as a contract, not just a behavior)
- How to force a full soul.md read when needed (direct endpoint vs. tree search)

### R6: Define the Learning → Soul Pipeline Trigger Precisely

Item 9 in the Implementation section says "check if [a learning] is identity-relevant (not just operational). If so, prompt." This trigger is undefined. What does "identity-relevant" mean? Who classifies it?

If classification is LLM-based (correct choice per the CLAUDE.md intelligence-over-string-matching principle), specify the classifier model, the prompt, and the output format. If it's keyword-based, say so and accept the limitation. The current "check if" is too vague to implement consistently.

---

## Observations

**What the spec gets right:**

- The AGENT.md/soul.md distinction is clean and philosophically coherent. Operational vs. reflective identity is a useful separation that maps to how humans think about the difference between a resume and a journal.

- The seeded-not-empty approach is the right ergonomic choice. A blank file is a prompt to do nothing. A seeded file with the personality from init gives the agent a starting point that reflects the user's intent.

- Non-mandatory sections is correct. Forcing all agents to maintain a conviction table with confidence ratings would produce cargo-cult identity work. Structure should be available, not required.

- Self-versioning (agent maintains Evolution History) is philosophically consistent with self-authorship. The agent who owns their identity also owns their identity changelog. The fragility concern (recommendation R2) is real but manageable.

- The graduated trust table is well-designed. The four-level progression from read-only to full self-authorship maps cleanly onto use cases: a cautious agent in a regulated environment vs. an autonomous agent that's been running for a year. Connecting soul.md permissions to the existing autonomy profile is the right integration point rather than inventing a new permission system.

- Rejecting auto-generated identity is the right call. "Auto-drafted identity defeats the purpose" is correct. The evolution job should prompt, not produce. This is a values-level design decision that will prevent a class of future misuse.

**Friction points for agent builders:**

- The spec is written from the agent's perspective (how will the agent use soul.md) but not from the builder's perspective (how do I configure soul.md behavior for my agent? How do I audit what my agent wrote? How do I roll back an identity change I don't like?). The dashboard-friendly GET /identity is mentioned but not specified. A builder needs read access, rollback, and diff views — none of these are addressed.

- Migration for existing agents is handled by PostUpdateMigrator but the spec doesn't say what happens when an agent already has content in their AGENT.md Growth section that should arguably be in soul.md. This is a content migration question, not just a file creation question.

---

## Scalability Assessment

**File-based storage:** soul.md as a markdown file is appropriate for single-agent deployments. For agents with years of operation, the Integrations and Evolution History sections could become long. The spec should define a line count or age threshold after which older entries are archived rather than kept inline. This is a future concern but worth noting.

**Multi-machine sync:** The spec doesn't address what happens when soul.md is modified on two machines before git sync runs. MEMORY.md has the same problem, but soul.md is more sensitive — a merge conflict in your conviction table is more disruptive than one in operational notes. The spec should flag this as a known limitation of file-based identity storage.

**Evolution job cadence vs. soul.md change rate:** The 6-hour cycle is appropriate for capability evolution. For identity, it may be too frequent — an agent that gets prompted to reflect on their soul.md every 6 hours while running heavy development work will experience this as noise. Consider a longer cadence (24h) for soul.md review prompts, or making it configurable separately from the capability evolution cycle.

**Being layer query latency:** The self-knowledge tree uses LLM triage. Adding a Being layer means identity queries now require an LLM round-trip. For compaction recovery specifically, this latency may be unacceptable. The spec's decision to include Personality Seed + Core Values in static compaction recovery is correct — but the handoff boundary between static and dynamic should be documented precisely.

---

## Score

**7.2 / 10**

| Dimension | Score | Notes |
|-----------|-------|-------|
| Conceptual Clarity | 9/10 | The AGENT.md vs. soul.md distinction is clean and well-motivated |
| API Design | 5/10 | Three endpoints sketched but none fully specified |
| Authentication/Trust | 6/10 | Trust table is well-designed; enforcement mechanism unresolved |
| Developer Ergonomics | 6/10 | Good for the agent; thin for the agent builder |
| Documentation | 7/10 | Implementation steps are clear; API contract is not |
| Onboarding Experience | 8/10 | Seeded template + /reflect skill is a good first-run experience |
| Scalability | 7/10 | File-based is pragmatic; multi-machine and long-term growth not addressed |

The spec earns a strong conceptual score. The design decisions are mostly correct and well-reasoned. The score is pulled down by API underspecification and the unresolved enforcement question — both of which are implementation-blocking gaps, not minor omissions. Resolving the three critical issues and incorporating the recommendations would bring this to a strong 8.5+.

---

*DX Review — Round 1 of 1 for spec soul-md-identity-exploration.md*
