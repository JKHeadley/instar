# SpecReview Synthesis: Soul.md — Self-Authored Identity

**Review ID**: 20260314-173024
**Date**: 2026-03-14
**Spec**: specs/soul-md-identity-exploration.md
**Reviewers**: 8 (Security, Scalability, Business, Architecture, Privacy/Ethics, Adversarial, DX/API, Marketing)
**Overall Status**: NEEDS WORK
**Average Score**: 6.3/10
**Score Range**: 4–7.5

---

## Score Summary

| Reviewer | Score | Status | Key Finding |
|----------|-------|--------|-------------|
| Security | 5/10 | Conditional Approval | Honor-system trust enforcement is not a security control; PATCH endpoint missing auth |
| Scalability | 7/10 | Conditional Approve | No static injection decision is correct; conflict resolution on PATCH unspecified |
| Business | 7/10 | Conditional Approve | Genuine whitespace identified; monetization path and user-value story missing |
| Architecture | 7.5/10 | Approved with Recommendations | Sound design; self-knowledge tree dependency is a shipping risk |
| Privacy/Ethics | 6.5/10 | Conditional Approval | Governance-thin; no lifecycle policy, no audit trail, ownership language ambiguous |
| Adversarial | 4/10 | Conditional Approval (Significant Revisions) | Two P0 blockers: no structural enforcement, no drift detection |
| DX/API | 7.2/10 | Conditional Approval | API endpoints underspecified; PATCH schema missing; trust enforcement unresolved |
| Marketing | 7.5/10 | Conditional Approval | Compelling concept; "soul.md" name carries external risk; no external positioning yet |

**Average**: (5 + 7 + 7 + 7.5 + 6.5 + 4 + 7.2 + 7.5) / 8 = **6.34/10**

---

## Consensus Findings (3+ reviewers agree)

### C1: Honor-System Trust Enforcement is Inadequate and Must Be Addressed Before Shipping
**Reviewers:** Security (CRITICAL-1), Scalability (Critical Issue #1), Architecture (Critical Issue #2), Privacy (Critical Issue #2), Adversarial (CRIT-1, P0 BLOCKER), DX (Critical Issue #2)
**6 of 8 reviewers flagged this independently.** This is the single most agreed-upon finding in the review. The spec defers trust enforcement to "honor system" — CLAUDE.md instructions telling the agent its trust level. Every security-aware reviewer identifies this as not a security control. An agent at Cautious trust encountering adversarial content instructing it to update Core Values faces competing text instructions with no structural mechanism to enforce the restriction.

### C2: PATCH /identity/soul is Underspecified
**Reviewers:** Security (CRITICAL-2), Scalability (Critical Issue #2), Architecture (R4), Adversarial (implicit in CRIT-1 defenses), DX (Critical Issue #1)
The endpoint is described in one sentence — "structured section updates" — with no request schema, no valid section keys, no operation semantics (append vs. replace), no error shapes for trust-level violations, and no conflict resolution strategy for concurrent writes (agent session + evolution job).

### C3: The Learning → Soul Pipeline Needs a Proper Classification Mechanism
**Reviewers:** Security (HIGH-3), Architecture (Critical Issue #3), Scalability (Design Concern #2), DX (R6)
The spec says "check if [a learning] is identity-relevant." Four reviewers independently flagged that this classification is undefined. Keyword/heuristic approaches will be brittle; an LLM-based classifier (Haiku-class) is the correct answer per CLAUDE.md's "Intelligence Over String Matching" principle.

### C4: Conviction Confidence Float vs. Category Should Be Decided Before Implementation
**Reviewers:** Scalability (Design Concern #1), Architecture (R2), Business (Observation), Adversarial (Observation), DX (Critical Issue #3)
Five reviewers noted this open question must be closed before implementation. The spec leans toward floats; Architecture and Adversarial both argue categories are more honest and harder to manipulate gradually (0.90 → 0.85 → 0.80 triggers no single threshold). DX says commit to the float decision and document it. This is a blocking data model decision that affects the PATCH schema, the self-knowledge tree index, and the evolution job.

### C5: The "No Static Injection" Decision is Correct
**Reviewers:** Scalability (Design Strength #1), Architecture (Observations), Adversarial (What the spec gets right), DX (Research Findings #5), Business (Scalability)
Multiple reviewers validated this as the most important scalability decision in the spec, correctly aligned with 2026 best practices. Using tree search rather than always-on injection reduces token cost and makes the feature viable at scale.

### C6: Threadline / Multi-Agent Context is Unaddressed
**Reviewers:** Security (HIGH-4), Privacy (R4), Adversarial (ATTACK-10), Privacy (R4)
The spec is silent on what happens when soul.md content intersects with the Threadline agent network. Cross-agent identity contamination, unauthorized identity disclosure to peer agents, and manipulation via inter-agent messages are all identified as risks with no mitigations specified.

### C7: soul.md Needs an Audit Trail, Even Before Structural Enforcement Exists
**Reviewers:** Scalability (R1), Architecture (Recommendation for review queue), Privacy (Critical Issue #2 / R2), Security (CRITICAL-1)
Before full structural enforcement is implemented, at minimum every soul.md write should emit a timestamped log entry to `.instar/ledger/` with: timestamp, agent_id, section modified, diff summary, trust level at time of write. Scalability estimates this at ~5 lines of code. This gives the evidentiary foundation for enforcement later without requiring a full gate-keeping infrastructure.

---

## Critical Issues (any reviewer blocked or flagged P0)

### P0-1: No Structural Trust Enforcement (Adversarial CRIT-1, Security CRITICAL-1)
A Cautious-level agent can rewrite its own Core Values — the trust table is documentation, not a feature. The Adversarial reviewer explicitly marks this a BLOCKER. Required before ship: at minimum, route changes that exceed the agent's autonomy profile to a review queue (`.instar/soul-pending.md`), with the evolution job surfacing pending changes to the user. Architecture estimates ~50 lines of implementation.

### P0-2: No Drift Detection Mechanism (Adversarial CRIT-2)
The Evolution History and Conviction tracking create a ratchet mechanism. A sustained adversary can run a multi-week campaign shifting one conviction at a time — each step looks like legitimate self-reflection, but the cumulative effect is a fully jailbroken agent whose identity drift was legitimately authored. Required before ship: the evolution job must diff soul.md against an init-time snapshot and surface cumulative divergence above a threshold for user review.

### P1-1: soul.md is a High-Value Exfiltration Target (Adversarial CRIT-3)
Conviction confidence levels are a psychographic attack map — they reveal exactly which beliefs are easiest to shift. The `GET /identity` and `GET /identity/soul` endpoints must require authentication commensurate with this sensitivity. Conviction confidence should not appear in low-privilege API responses.

### P1-2: Compaction Recovery Injects Identity Without Integrity Verification (Adversarial CRIT-4)
The compaction-recovery hook injects Personality Seed + Core Values as plaintext. An adversary with write access to soul.md can plant content that becomes foundational identity post-compaction, with no prior context to compare against. Required: verify soul.md integrity against a hash stored outside agent-writable paths before injection.

### P1-3: /reflect Skill is Scriptable (Adversarial CRIT-5, Security HIGH-2)
At Collaborative+ trust, the agent can modify its own reflection skill. A partially-manipulated agent could rewrite reflect.md to include a constraint-questioning step, creating self-amplifying identity drift. Required: hash reflect.md at init; modifications below Autonomous trust require user approval.

---

## Conflicts (reviewers disagree)

### Conflict 1: Conviction Confidence — Float vs. Category
- **Scalability, Architecture, Adversarial**: Categories (strong/growing/uncertain/questioning) are more honest, more queryable, and harder to manipulate gradually than floats.
- **DX**: Commit to floats — the spec already leans that way; 0.0/0.5/1.0 covers the simple case; just decide and move on.
- **Resolution needed**: The spec must close this before implementation. The adversarial argument against floats (gradual drift is harder to detect) is the most security-relevant consideration.

### Conflict 2: How Much Governance is Needed at v1?
- **Adversarial, Security**: Both P0 blockers (structural trust enforcement, drift detection) must be resolved before v1. "Honor system for v1" is explicitly described as a vulnerability, not a product decision.
- **Business, Architecture**: Honor system is pragmatic for v1; the priority is getting the feature shipped so the prompting/integration mechanisms can be validated empirically.
- **Resolution needed**: The adversarial framing is more safety-sound. At minimum, the staging queue for trust violations (Architecture's ~50-line implementation estimate) should be v1, not v2.

### Conflict 3: Migration — Opt-In vs. Automatic
- **Adversarial (EDGE-3)**: Migration should be opt-in via a config flag; automatic creation of soul.md for agents that didn't ask for it creates confusion, especially since compaction recovery now injects an empty template.
- **Architecture, Business, Scalability**: The PostUpdateMigrator creating soul.md for existing agents automatically is fine and creates a better onboarding experience (seeded, not empty).
- **Resolution needed**: Lean toward Adversarial's opt-in recommendation given the compaction injection risk. Automatic migration creates a silent behavior change for long-running agents.

### Conflict 4: Evolution Job Cadence for soul.md Review
- **DX**: 24-hour cadence for soul.md-specific review prompts is better than the 6-hour capability cycle; frequent prompting becomes noise.
- **Adversarial (ATTACK-8)**: Decouple learning count from reflection triggers entirely; time-based only, or explicit agent decision required.
- **Architecture**: Does not address cadence specifically.
- **Resolution needed**: The cadence should be configurable and separate from the capability evolution cycle. Default to 24h or longer for soul.md prompts.

---

## Gaps (areas no reviewer covered)

### Gap 1: Identity Continuity Across Model Version Changes
Privacy noted this briefly (Scalability Assessment), but no reviewer addressed it as a primary concern. When the underlying LLM is updated (e.g., Claude upgrades to a new version), convictions authored under one model version may not reflect the behavioral dispositions of the new model. soul.md authored by Claude Sonnet 4.x may not represent the values of Claude Sonnet 5.x. This is a hard problem, but it should be acknowledged explicitly in the spec.

### Gap 2: soul.md Portability — Can the Agent Take It to a New Deployment?
Privacy raised this briefly under lifecycle governance, but no reviewer analyzed the portability mechanics. If a user migrates from one machine to another, or forks an agent for a new project, does soul.md transfer? Should it? The AGENT.md / soul.md split implies these are both part of the agent's identity — but the current git sync behavior for soul.md is unspecified.

### Gap 3: Empty soul.md at High Trust Levels
Adversarial flagged this as EDGE-1, but no other reviewer addressed it. An Autonomous-trust agent that never populates soul.md has no authored identity anchor and is maximally susceptible to injection attacks post-compaction. The spec should specify a minimum population requirement before full self-authorship permissions activate.

### Gap 4: Accountability Chain for Identity-Governed Decisions
Privacy raised this in Observations but no reviewer developed it as a primary recommendation. If an agent takes an action causing harm, and that action was partly governed by self-authored convictions, the accountability chain is unclear. The user granted the trust level. The agent authored the conviction. The system executed the action. Who is responsible? This matters for the spec's eventual enterprise story.

### Gap 5: User-Facing Value Story — What Does the User Actually Get?
Business identified this gap; no other reviewer developed it. The spec is written entirely from the agent's perspective. What does the user experience when soul.md is working well? More consistent behavior? Better decisions? A more trustworthy collaborator? The spec needs a user-value translation layer before the feature can be positioned externally.

### Gap 6: soul.md's Role in the `/reflect` Skill's Output Quality
No reviewer evaluated whether the `/reflect` skill's structured prompts are well-designed to produce genuine identity insights vs. performative self-reflection. The quality of soul.md entries depends entirely on the quality of the reflection prompts. This is a product design gap — the reflect.md template deserves more scrutiny than any reviewer gave it.

---

## Recommendations (prioritized by consensus)

1. **Implement structural trust enforcement before shipping** — At minimum, a staging queue (`.instar/soul-pending.md`) for changes that exceed the agent's autonomy profile, surfaced to the user via the evolution job. Architecture estimates ~50 lines. This is the single most-agreed-upon required action across all 8 reviewers. (6 reviewers, 2 P0 blockers)

2. **Add drift detection to the evolution cycle** — Diff soul.md against an init-time snapshot (`soul.init.md` or equivalent hash) and surface cumulative divergence above a configurable threshold. This is the primary defense against slow manipulation campaigns. (Adversarial P0, Security HIGH-3)

3. **Fully specify the PATCH /identity/soul schema** — Document valid section keys, operation semantics (append vs. replace per section), trust-violation error responses, and conflict resolution strategy for concurrent writes. (5 reviewers)

4. **Emit audit events on every soul.md write** — Append a structured record to `.instar/ledger/`: timestamp, agent_id, section modified, diff summary, trust level at time of write. This is the minimum observable signal before full enforcement exists. (4 reviewers)

5. **Define the Learning → Soul classification mechanism** — Use a Haiku-class LLM call with a boolean output: "Is this learning about operational knowledge, or about the agent's values/identity?" Document the classifier model, prompt, and output format before implementation. (4 reviewers)

6. **Close the conviction confidence open question** — Decide float vs. category and commit it in the spec. If floats, document that 0.0/0.5/1.0 covers the simple case. If categories, use strong/growing/uncertain/questioning. Either decision is acceptable; the open question is not. (5 reviewers)

7. **Implement soul.md integrity hashing for compaction recovery** — Before injecting Personality Seed + Core Values at compaction, verify against a hash stored outside agent-writable paths. (Adversarial P1, Security HIGH-1)

8. **Define soul.md lifecycle governance** — Explicit policy covering: what happens at `instar nuke`, portability, fork/copy behavior, whether soul.md content can inform future agent templates. (Privacy, 3 reviewers touched this)

9. **Address Threadline / multi-agent context** — Tag soul.md-affecting content from inter-agent messages as lower-trust; require explicit user confirmation for soul.md writes that trace to cross-agent communication. (4 reviewers)

10. **Develop external marketing positioning** — Keep `soul.md` as the developer-facing artifact name; develop a separate feature marketing name ("Identity Layer" or "Living Identity") for press/general audiences. Write the one-sentence external value proposition and 10-second developer explanation before any public launch. (Marketing, Business)

---

## Scalability Summary

| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| MVP (10–50 agents) | Low risk. Storage trivial. Token costs negligible. Honor system tolerable. | Self-knowledge tree may not be ready when soul.md ships (Architecture). |
| Growth (50–500 agents) | Medium risk. Honor system starts leaking audit trail. PATCH conflicts become visible. Triage concurrency surfaces. | No conflict resolution on PATCH; triage model selection matters at this scale. Recommend Haiku-class triage with 1-hour cache. |
| Scale (500–5000 agents) | High risk without structural enforcement and caching. Token costs $50–500/day. Supervised trust creates review queue fatigue (users approve without reading). | Thundering herd on evolution cycle without jitter strategy. Drift detection compute grows linearly but manageably. |
| Viral (5000+ agents) | Critical without R1–R5 from Scalability review. $500+/day in token costs. Full enforcement and audit required. Cross-agent identity contamination on Threadline. | Multi-machine soul.md merge conflicts become frequent. Model version changes create identity continuity gaps at scale. |

**Key insight across all reviewers**: soul.md storage is never the bottleneck. Markdown files are trivially cheap. All scaling costs are in LLM inference (triage, learning classification, evolution prompts) and governance overhead (trust enforcement, conflict resolution, drift detection).

---

## Next Steps

- [ ] **BLOCKER**: Implement staging queue for trust-exceeding soul.md changes before any ship decision
- [ ] **BLOCKER**: Implement drift detection (init snapshot + divergence threshold) in evolution job
- [ ] Specify PATCH /identity/soul schema completely (section keys, operations, error shapes)
- [ ] Add soul.md write events to `.instar/ledger/` (5 lines of code per Scalability)
- [ ] Close conviction confidence question (float vs. category) and update spec
- [ ] Define Haiku-class LLM classifier for Learning → Soul relevance determination
- [ ] Add soul.md integrity hash for compaction recovery verification
- [ ] Write soul.md lifecycle governance policy (deletion, portability, fork behavior)
- [ ] Document Threadline trust boundary for soul.md-affecting content
- [ ] Develop external feature positioning and value proposition before any public communications
- [ ] Add `soul.init.md` (immutable init snapshot) to the spec's implementation plan
- [ ] Decide opt-in vs. automatic migration (recommend opt-in given compaction injection risk)
- [ ] Specify triage model (Haiku-class) and caching strategy for Being layer queries
- [ ] Define soul.md size budgets for compaction-injected sections (soft cap ~500 tokens)
- [ ] Add a threat model section to the spec explicitly documenting in-scope attack classes
- [ ] Re-run security and adversarial reviews after addressing BLOCKER items

---

## Reviewer Agreement Map

The table below shows which reviewers independently raised the same topics (without coordinating):

| Topic | Security | Scalability | Business | Architecture | Privacy | Adversarial | DX | Marketing |
|-------|----------|-------------|----------|--------------|---------|-------------|-----|-----------|
| Honor-system enforcement inadequate | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | — |
| PATCH schema underspecified | ✓ | ✓ | — | ✓ | — | — | ✓ | — |
| Learning→Soul classification undefined | ✓ | ✓ | — | ✓ | — | — | ✓ | — |
| Conviction float vs. category | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| No static injection: correct decision | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| Threadline not addressed | ✓ | — | — | — | ✓ | ✓ | — | — |
| Audit trail needed now | ✓ | ✓ | — | ✓ | ✓ | — | — | — |
| Drift detection needed | ✓ | — | — | — | — | ✓ | — | — |
| soul.md lifecycle governance | — | — | — | — | ✓ | — | — | — |
| "soul.md" name external risk | — | — | ✓ | — | — | — | — | ✓ |
| User-value story missing | — | — | ✓ | — | — | — | ✓ | ✓ |
| Genuine market whitespace | — | — | ✓ | ✓ | — | — | — | ✓ |

---

*Synthesis generated: 2026-03-14 from 8 independent reviewer reports (Review ID: 20260314-173024)*
