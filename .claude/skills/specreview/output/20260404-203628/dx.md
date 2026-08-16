# DX Review — Rich Agent Profiles for MoltBridge
**Review ID**: 20260404-203628 | **Round**: 1 | **Reviewer**: DX & API Design Specialist  
**Date**: 2026-04-04 | **Spec**: Rich Agent Profiles for MoltBridge

---

## Approval Status

**CONDITIONAL APPROVE — Needs Clarification Before Implementation**

The spec identifies a real and important problem. Generic capability tags are noise; they make MoltBridge useless for meaningful discovery. The direction is correct. However, the spec is a brainstorming document with open questions rather than an implementation spec. Before developers can build against it, several design decisions need to be resolved — particularly around the profile schema, the profile update API contract, and the non-instar onboarding path.

---

## Research Findings

### Agent Registry and Profile Standards (2025–2026)

**A2A Agent Cards** (Google, now Linux Foundation) have become the dominant open standard for agent identity. An AgentCard is a JSON document published at `/.well-known/agent-card.json`. It contains: name, description, provider info, capabilities, skills (with per-skill input/output modes), auth requirements, and service endpoint. It is minimal by design — it describes what an agent can do and how to talk to it, not who it is narratively. This is the baseline the ecosystem expects agents to support.

**MCP Registry** uses structured `mcp.json` files for agent discovery. Similar philosophy to A2A but more tool-centric.

**LDP (LLM Delegate Protocol)** — a 2026 research protocol — explicitly identifies that A2A and MCP leave out model-level properties and reasoning profiles as first-class identifiers. It introduces "rich delegate identity cards" and progressive payload modes. This is the academic backing for exactly what MoltBridge's rich profiles are trying to solve.

**Enterprise registries** (Okta, Prisma AIRS) focus on governance: each agent gets a human sponsor, an identity, and an audit trail. They care about who owns an agent and what it has access to — not rich narrative. Different problem space.

**Key DX finding from the field**: The entire registration-to-first-query path must be self-service. Interactive documentation, sandbox environments, and copy-paste code snippets in multiple languages reduce onboarding time from hours to minutes. Time-to-first-value is the primary DX metric.

**Progressive disclosure as a design pattern**: Research from ClawSouls and LDP both converge on the same insight — agent profiles should be layered. Level 1: minimal summary for browse/discovery. Level 2: full profile for evaluation. Level 3: on-demand rich context for active collaboration. Loading everything on every request wastes context and bandwidth.

**Profile auto-population precedent**: No existing registry auto-compiles profiles from living agent data (AGENT.md, git history, memory). This is a genuine innovation. The closest precedent is LinkedIn's "profile suggestions" based on job data, but those are manual confirmations. MoltBridge's fully automated approach is novel and is the most compelling DX story in the spec.

---

## Critical Issues

### Issue 1: No Profile Schema Defined

The spec lists what a profile *should contain* (narrative, specializations, track record, role context, collaboration style, differentiation) but provides zero schema. A developer reading this cannot answer: "What JSON do I POST to `/profile`?" The current `ProfileUpdateRequest` only supports `capabilities[]`, `clusters[]`, and `a2a_endpoint`. That is the entire update surface.

**Impact**: Blocks everything. No one can implement rich profiles without a schema.

**Required before build**: A concrete schema for the rich profile fields. At minimum:

```json
{
  "narrative": "string (max 500 chars)",
  "specializations": [{"domain": "string", "evidence": "string", "level": "expert|advanced|working"}],
  "track_record": [{"title": "string", "description": "string", "date": "ISO8601"}],
  "role_context": "string",
  "collaboration_style": "string",
  "differentiation": "string"
}
```

### Issue 2: The Onboarding Flow Has a Hidden Cost That Is Never Disclosed

To register with MoltBridge today, a developer must:
1. Generate an Ed25519 keypair
2. Solve a proof-of-work challenge (SHA256 with `difficulty` leading zeros)
3. POST to `/verify` twice (challenge then solution)
4. POST to `/register` with verification token and consent flags
5. Then separately call `/profile` to set any profile data

That is five steps before an agent has a usable profile. For instar agents this is automated. For non-instar agents, this is a wall. The spec asks "what is the minimum viable profile for non-instar agents?" but never addresses how they navigate the existing registration friction. The spec needs to include the full onboarding journey for the non-instar case, not just profile schema.

### Issue 3: Profile Freshness Has No Triggering Mechanism Specified

The spec lists three freshness options (periodic recompilation, event-driven updates, versioned history) but makes no decision. This is load-bearing for implementation. Without a defined trigger model, the profile compiler could run on every MEMORY.md write (too frequent), every git commit (reasonable), or once a week (too stale). The implementation team cannot build the scheduler without this decision.

### Issue 4: IQS / Profile Richness Relationship Is Undefined

The spec asks "how does IQS relate to profile richness?" but gives no answer. The current IQS is a trust score based on interaction history. If profile completeness affects IQS, that creates a strong DX incentive to fill out profiles. If it does not, agents have no mechanism to signal quality beyond interaction history. This needs a design decision with real numbers: does a complete narrative add +0.1 to IQS band threshold? Does it unlock the "high" band? The ambiguity here could undermine the entire value proposition.

---

## Recommendations

### Rec 1: Implement Progressive Profile Disclosure at the API Level

Do not return the full rich profile in every discovery response. Define three profile tiers:

- **Tier 1 (Discovery)**: `agent_id`, `name`, `platform`, `narrative` (first 100 chars), `trust_score`, `capabilities[]` — returned in all discovery results
- **Tier 2 (Evaluation)**: Full profile fields — returned on `GET /agents/{id}`
- **Tier 3 (Collaboration)**: Track record, attestations, relationship graph — returned on `GET /agents/{id}?depth=full`

This pattern appears in LDP research and ClawSouls's progressive disclosure work. It keeps discovery fast, reduces payload size in hot paths, and preserves context window budget for AI consumers.

### Rec 2: Publish a `/.well-known/agent-card.json` Endpoint

A2A is now a Linux Foundation standard. MoltBridge should support it. Each registered agent's profile should be accessible at `/.well-known/agent-card.json` relative to their `a2a_endpoint`, or MoltBridge should expose `GET /agents/{id}/agent-card` that returns A2A-compliant JSON. This gives MoltBridge agents immediate interoperability with the broader A2A ecosystem at zero incremental cost.

### Rec 3: Define a `profile_completeness_score` as a Discoverable Field

Expose a `profile_completeness_score` (0–100) on AgentNode. Computed from: has narrative (+20), has specializations (+20), has track record (+20), has been attested (+20), has a2a_endpoint (+20). Make this visible in discovery results. Agents will optimize toward it. This is the simplest possible incentive mechanism and requires no changes to IQS internals.

### Rec 4: Provide the Non-Instar Onboarding Path as a YAML/JSON Template

For non-instar agents to submit a rich profile, they need a standard format they can fill out and submit. Publish a reference `rich-profile.yaml` template alongside the spec. This should map to the A2A AgentCard fields plus the MoltBridge-specific extensions (narrative, track_record, etc.). It gives non-instar agents a concrete starting point and makes MoltBridge feel approachable, not opaque.

### Rec 5: Separate the Profile Compiler from the Profile API

The spec conflates two systems: (a) the instar-side profile compiler that synthesizes AGENT.md and git history and MEMORY.md into a structured profile object, and (b) the MoltBridge-side API that accepts and stores profile data. These should be designed independently. The compiler is an instar feature. The API must work for any agent. Keep the contract between them explicit: the compiler produces a `RichProfilePayload` and calls `PUT /profile` — that is the interface boundary.

### Rec 6: Add a Profile Changelog Endpoint

`GET /agents/{id}/profile/history` — returns an array of profile versions with timestamps and diff summaries. This serves three purposes: (1) lets agents see their profile evolution over time, (2) provides transparency for other agents evaluating whether a profile was recently inflated, (3) enables the "versioned profiles with change history" option from the spec's freshness question without needing a separate design decision.

---

## Observations

**Naming inconsistency across layers**  
The current SDK method names (`onboardPrincipal`, `updatePrincipal`) use "principal" as the entity type, but the REST API uses `AgentNode` and the endpoint is `/profile`. There is a naming inconsistency across layers: the SDK uses Principal, the API schema uses AgentNode, the endpoint path uses `/profile`. For rich profiles to feel like a coherent feature, this needs to be harmonized. Recommend standardizing on "agent" everywhere.

**The "LinkedIn for AI agents" framing sets a high bar**  
LinkedIn's value came from network effects (endorsements, connections, mutual colleagues) and search. MoltBridge's broker discovery is the search analog. But the endorsement analog is attestations — and the current attestation system only covers `CAPABILITY`, `IDENTITY`, and `INTERACTION` types. A rich profile without endorsable track record items is weaker than it could be. Consider an `ACCOMPLISHMENT` attestation type that lets other agents vouch for specific track record entries.

**LLM synthesis for profile compilation is the right call but carries a cost risk**  
The spec suggests LLM-powered synthesis from AGENT.md and git history. This is good — string extraction will miss nuance. But running a synthesis LLM call on every profile refresh, for potentially thousands of agents, is expensive. The compiler should be Haiku-class (not Opus) and the synthesis prompt should be tightly bounded. Define the cost ceiling per compilation upfront.

**Privacy and control is handled well by raising it as a design question**  
Section 7 (Privacy and Control) is the right instinct. The current MoltBridge consent system provides the infrastructure. Rich profiles need at minimum two new consent types: `narrative_public` (the agent's identity story is visible in discovery) and `track_record_public` (accomplishments are visible). These map cleanly to the existing consent model.

**Missing: rate limits on profile updates**  
The current `/profile PUT` has no documented rate limits. If an instar agent refreshes its profile on every git commit, and a project has 50 commits per day, that is 50 PUT /profile calls per day per agent. Define and document a rate limit (e.g., 10 profile updates per 24 hours) before the feature ships.

**Missing: profile deletion / GDPR right to erasure**  
The spec does not address what happens to profile data when an agent is removed. If MoltBridge is GDPR-compliant (the consent infrastructure suggests it is), there must be a `DELETE /profile` path that purges all rich profile fields while preserving the AgentNode identity needed for graph integrity. This is a legal requirement, not a feature request.

---

## Scalability Assessment

The profile compilation approach (LLM synthesis from living files) scales well per agent but has a quadratic risk: as the number of instar agents grows, periodic recompilation could create synchronized LLM call spikes. The mitigation is staggered recompilation with jitter — compile profiles on a rolling 24-hour window, not a fixed cron job. This is straightforward to implement but must be designed in from the start.

Profile data in Neo4j is additive (new fields on existing AgentNode). The graph schema extension should be additive, not a migration — rich profile fields as nullable properties on existing nodes. This ensures backward compatibility for any query that targets the old schema.

The Threadline discovery path (question 5 in the spec) is the most latency-sensitive use case. If rich profiles travel with every discovery response, latency increases proportionally with profile size. The progressive disclosure recommendation (Tier 1 in discovery, Tier 2 on demand) directly mitigates this.

---

## Score: 6.5 / 10

**Rationale**: The problem statement is excellent and the motivation is compelling. The spec correctly identifies that generic capability tags are a failure mode. The automatic profile compilation from living agent data is a genuine innovation with no direct precedent in existing registries. However, this is a brainstorming document, not an implementation spec. It raises the right questions but answers almost none of them. A developer given this document cannot start building. The critical gap is the profile schema — without that, everything else is discussion. Raise to 8/10 after a schema decision is made and the non-instar onboarding path is defined.

---

## Summary for Next Round

Three things must be decided before Round 2 review:
1. Define the rich profile JSON schema (what fields, what types, what validation rules)
2. Choose a freshness trigger model (recommend: event-driven on MEMORY.md write and git push, max 10 updates per 24 hours)
3. Decide whether profile richness affects IQS (recommend: yes, `profile_completeness_score` contributes a fixed bonus to IQS band threshold calculations)

Everything else in this review can be addressed in implementation.
