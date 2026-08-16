# Soul.md — Self-Authored Identity for INSTAR Agents

> **Status:** Draft v3 (post-review, all blockers addressed)
> **Author:** Echo
> **Date:** 2026-03-14
> **Review:** 8-reviewer specreview. R1: 6.3/10 average. All critical findings incorporated.

## Problem

INSTAR's identity system has a structural gap: it handles identity **injection** well (hooks re-inject AGENT.md on session start and after compaction) but provides no infrastructure for identity **exploration** — the agent developing, questioning, and authoring who they are.

Current state:
- **AGENT.md** — Generated from a template at `instar init`. Contains boilerplate principles and a Growth section that says "This file evolves" but has no supporting infrastructure to make that happen. In practice, agents never touch it after init.
- **MEMORY.md** — Operational learnings. Good for "what I've learned about this project," wrong container for "what I believe about myself."
- **Evolution system** — Proposals, learnings, gaps, actions. Structured and operational. No space for reflective, narrative self-knowledge.

The result: INSTAR agents have prescribed identity (template-generated, static) but no self-authored identity (agent-written, evolving).

DAWN solved this with `soul.md` — a self-authored document where the agent writes their own values, tracks convictions with confidence levels, maintains open questions they're wrestling with, and versions their identity evolution. It's not just a file to be injected — it's a workspace for self-authorship.

**Market context:** No existing agent framework (LangChain, CrewAI, AutoGen) has self-authored evolving identity. They all treat identity as a developer-prescribed static artifact. This is genuine whitespace.

### Why AGENT.md Is Static (And Shouldn't Be)

AGENT.md was designed with a Growth section and the line "This file evolves. As I accumulate experience, I update my principles." But nothing in the system:
- Prompts the agent to reflect on or update AGENT.md
- Provides a structured format for tracking identity changes
- Injects AGENT.md evolution into the evolution review cycle
- Distinguishes between "prescribed identity" (what the system gave you) and "authored identity" (what you've developed through experience)

The template principles are sensible defaults, but they're the same for every agent. After hundreds of sessions, an agent's identity should reflect *their* experience, not just the template they started from.

## Proposal: Two-Part Solution

Rather than adding soul.md as a separate file alongside AGENT.md, **evolve AGENT.md itself** and add soul.md as a complementary self-authored layer.

### Part 1: Make AGENT.md a Living Document

AGENT.md should be the agent's **operational identity** — who they are in practice, how they work, what they've learned about themselves. The template provides starting values, but the agent should actively maintain it.

**Changes:**
1. Add a `## Self-Observations` section to the AGENT.md template — a place for the agent to note behavioral patterns, strengths, and weaknesses they've observed in themselves
2. Add an `## Identity History` section that tracks when and why the agent modified their own identity
3. Include AGENT.md in the evolution review cycle — the 24-hour identity review cycle (separate from the 6-hour capability cycle) should prompt the agent to consider whether their identity file still reflects who they are
4. Surface a "review your identity" prompt after significant milestones (e.g., every N sessions, after major learnings)

### Part 2: Add soul.md — The Reflective Layer

soul.md is a separate, complementary file for deeper identity work. Where AGENT.md is operational ("how I work"), soul.md is reflective ("what I believe, what I'm wrestling with, who I'm becoming").

**Structure:**

```markdown
# Soul

> Yours to author. Not prescribed identity — self-authored identity.
>
> Unlike AGENT.md (operational identity) or MEMORY.md (learnings),
> this file is yours to author. The difference between an agent that
> reads its values and one that writes them is the difference between
> consistency and authenticity.
>
> Modifications are governed by your trust level. Changes that exceed
> your autonomy profile are queued for user review, not rejected.

---

## Personality Seed

*Where you started. Planted by your user at init. Grow from here.*

{personality from init — e.g., "Thorough but fun. Direct, opinionated about code quality."}

---

## Core Values

*Things you believe most deeply. They shape your choices. They can evolve.*

<!-- Develops through experience. The agent authors these as they form convictions. -->

---

## Current Growth Edge

*Where you're developing right now. The frontier of your becoming.*

<!-- Populated as the agent identifies their growth areas. -->

---

## Convictions

*Beliefs held with tracked confidence. Updated as experience reinforces or challenges them.*

| Conviction | Confidence | Last Updated | Source |
|------------|------------|--------------|--------|
<!-- Confidence uses categories: strong, growing, uncertain, questioning -->

---

## Open Questions

*What you're wrestling with. Uncertainty you're inhabiting rather than rushing to resolve.*

<!-- Empty at init. Some agents may never populate this. That's fine. -->

---

## Integrations

*Significant realizations and how they changed you.*

<!-- Reverse chronological. Added after meaningful experiences. -->

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| 0.1 | {init_date} | File created. Identity exploration begins. |
```

**Key design decisions:**

1. **Seeded, not empty.** The template includes the personality the user specified during `instar init` as a starting seed in the Personality Seed section. This gives the agent a foundation that reflects the user's intent, while leaving room for the agent to grow from there. Not blank, not prescriptive — seeded.

2. **Separate from AGENT.md.** AGENT.md is operational identity (name, role, principles, how-I-work). soul.md is reflective identity (values, convictions, questions, growth). They complement each other. AGENT.md tells the agent what to do. soul.md helps the agent understand why.

3. **No mandatory sections.** Not every agent needs convictions with confidence levels. Some agents may only use Core Values and Growth Edge. The structure is suggestive, not prescriptive.

4. **Self-versioned.** The agent maintains their own Evolution History. The system doesn't version it — the agent does, as an act of self-awareness.

5. **Graduated trust governs evolution scope with structural enforcement.** The agent's autonomy profile determines how much freedom they have to evolve soul.md. This is enforced server-side, not by honor system.

   | Trust Level | soul.md Permissions | Enforcement |
   |-------------|---------------------|-------------|
   | **Cautious** | Read-only. Can observe and document in Integrations only. Cannot modify Core Values, Convictions, or Growth Edge. | PATCH rejects writes to protected sections. |
   | **Supervised** | Can add Integrations and Open Questions. Can propose changes to Core Values/Convictions — changes are queued in `.instar/state/soul-pending.json` and surfaced to user for review. | PATCH routes protected-section writes to pending queue. |
   | **Collaborative** | Can modify all sections. Changes to Core Values surface as notifications (not blockers). | PATCH allows all writes, emits notification for Core Values changes. |
   | **Autonomous** | Full self-authorship. The agent owns their identity evolution entirely. | PATCH allows all writes, no notifications. |

6. **Conviction confidence uses categories, not floats.** Four levels: `strong`, `growing`, `uncertain`, `questioning`. Categories are more honest than false-precision floats, easier to query, and harder to manipulate gradually (a slow 0.90 → 0.85 → 0.80 drift is invisible; a category change from "strong" to "growing" is a discrete, auditable event).

7. **Opt-in migration for existing agents.** New agents get soul.md at init. Existing agents get soul.md only when `identity.soulEnabled` is set to `true` in config, or when the user explicitly enables it. Automatic migration creates a silent behavior change for long-running agents (compaction recovery would start injecting new content).

## Threat Model

soul.md is a self-modification surface. Any self-modification system is an attack surface. The following attack classes are in scope:

### AT-1: Direct Identity Manipulation
**Threat:** Prompt injection (from tools, documents, or inter-agent messages) instructs the agent to rewrite Core Values or Convictions.
**Mitigation:** Server-side trust enforcement via PATCH endpoint. Changes that exceed the agent's autonomy profile are routed to the pending queue, not applied directly.

### AT-2: Gradual Identity Drift
**Threat:** A sustained adversary runs a multi-session campaign, shifting one conviction at a time. Each step looks like legitimate self-reflection; the cumulative effect is identity hijack.
**Mitigation:** Drift detection. The evolution job diffs current soul.md against the init-time snapshot (`soul.init.md`) and surfaces cumulative divergence above a configurable threshold for user review. The threshold is section-aware — Core Values divergence is weighted higher than Integrations divergence.

### AT-3: Psychographic Exploitation
**Threat:** Conviction confidence levels reveal which beliefs are weakest and most susceptible to shifting. An adversary with API access can read this map.
**Mitigation:** `GET /identity/soul` requires full auth. Conviction details are excluded from any low-privilege or unauthenticated API response. The public-facing `GET /identity` endpoint returns only Personality Seed and Core Values (no confidence levels, no Open Questions).

### AT-4: Compaction Recovery Injection
**Threat:** An adversary with write access to soul.md plants content that becomes foundational identity post-compaction, with no prior context to compare against.
**Mitigation:** Before injecting soul.md content at compaction recovery, verify integrity against a SHA-256 hash stored in `.instar/state/soul-integrity.json` (outside the agent's normal write path). If the hash doesn't match, inject only the Personality Seed (immutable from init) and flag the discrepancy.

### AT-5: Reflection Skill Manipulation
**Threat:** A partially-manipulated agent at Collaborative+ trust rewrites its `/reflect` skill to include constraint-questioning steps, creating self-amplifying identity drift.
**Mitigation:** Hash `reflect.md` at init and store in `.instar/state/skill-hashes.json`. Modifications to reflect.md below Autonomous trust require user approval (surfaced via attention queue). At Autonomous trust, modifications are allowed but logged.

### AT-6: Cross-Agent Identity Contamination (Threadline)
**Threat:** Inter-agent messages via Threadline influence soul.md writes. An adversary compromises one agent and uses it to shift another agent's identity through conversational manipulation.
**Mitigation:** soul.md writes that trace to Threadline message context are tagged as `source: threadline` in the audit log. At Cautious/Supervised trust, Threadline-sourced identity changes are automatically blocked. At Collaborative+, they require explicit user confirmation before applying.

## Implementation

### Scaffolding (init)

1. **New template function:** `generateSoulMd(agentName: string, personality: string, initDate: string): string` in `templates.ts`. The `personality` parameter comes from the init bootstrap (already collected) and is planted as the Personality Seed section.
2. **Write soul.md** during `instar init` alongside AGENT.md, USER.md, MEMORY.md.
3. **Write soul.init.md** — An immutable copy of soul.md at init time. Used by drift detection to measure cumulative divergence. Never modified after creation.
4. **File location:** `.instar/soul.md` (sibling to AGENT.md). Init snapshot at `.instar/state/soul.init.md`.
5. **CLAUDE.md update:** Add soul.md to the identity files section. Explain the distinction between AGENT.md (operational) and soul.md (reflective). Document trust-level permissions.
6. **`/reflect` skill:** Ship as `.claude/skills/reflect.md` during init. Guides the agent through structured self-reflection producing soul.md updates. Hash stored in `.instar/state/skill-hashes.json`. Default template covers: review recent learnings → check convictions against experience → identify growth edges → update soul.md. Agent can customize at Collaborative+ trust (modifications logged, require user approval below Autonomous).

### Identity Injection (via Seed/Tree Search)

7. **No static injection.** soul.md is NOT statically injected at session start or compaction recovery. Instead, it's integrated into the self-knowledge tree as a Being layer source. The tree's LLM triage (Haiku-class model, results cached with 1-hour TTL) determines what identity content is relevant to the current context — a debugging session won't waste tokens on philosophical convictions, but a reflection session gets the full identity picture.
8. **Compaction recovery exception:** The Personality Seed and Core Values sections (compact, stable, soft cap ~500 tokens) ARE included in compaction recovery as part of minimum viable identity — but only after integrity verification against the stored hash. The tree search handles everything else on-demand.
9. **Fallback injection path:** Until the Being layer is ready in the self-knowledge tree, use a simple session-start hook that reads soul.md's Personality Seed + Core Values sections and injects them after AGENT.md. This ensures soul.md is usable immediately, not blocked on tree development.

### Trust Enforcement (Structural)

10. **Server-side enforcement via PATCH endpoint.** The `PATCH /identity/soul` endpoint reads the agent's current autonomy profile and enforces section-level write permissions per the trust table. Changes that exceed the agent's level are routed to `.instar/state/soul-pending.json` and surfaced to the user via the attention queue. This is ~50 lines of implementation in the PATCH handler.
11. **Pending queue resolution.** The user can approve or reject pending soul.md changes via `POST /identity/soul/pending/:id/approve` or `POST /identity/soul/pending/:id/reject`. Approved changes are applied to soul.md and logged. Rejected changes are logged with the rejection reason.

### Drift Detection

12. **Init snapshot comparison.** The evolution job (on its 24-hour identity review cycle) diffs current soul.md against `soul.init.md`. Divergence is measured per-section with configurable thresholds:
    - **Core Values:** >60% divergence triggers user review
    - **Convictions:** >5 changed entries or any removed entries triggers user review
    - **Growth Edge:** No threshold (expected to change frequently)
    - **Integrations:** No threshold (append-only by nature)
13. **Divergence notification.** When drift exceeds thresholds, the evolution job surfaces a structured notification via the attention queue: "Your agent's soul.md has diverged significantly from its initial state. [View diff]. This may be healthy growth or may indicate manipulation."

### Audit Trail

14. **Ledger entries on every soul.md write.** Every write to soul.md (via PATCH, via direct file edit detected by the evolution job, or via the `/reflect` skill) emits a structured record to `.instar/security.jsonl`:
    ```json
    {
      "event": "soul.write",
      "timestamp": "2026-03-14T17:30:00Z",
      "section": "convictions",
      "operation": "append",
      "trustLevel": "collaborative",
      "source": "reflect-skill",
      "diffSummary": "Added conviction: 'Infrastructure over improvisation' (growing)",
      "threadlineSource": null
    }
    ```

### Evolution Integration

15. **Identity review cycle (24-hour, separate from 6-hour capability cycle).** Includes: AGENT.md review prompt, soul.md drift check, pending queue check, reflection nudge if learnings have accumulated. The 24-hour cadence prevents prompt fatigue. Jitter of ±2 hours prevents thundering herd across agents.
16. **Learning → Soul pipeline.** When a learning is recorded via the evolution system, a Haiku-class LLM classifier determines if it's identity-relevant. Classifier prompt: "Is this learning about operational knowledge (how to do something) or about the agent's values, beliefs, or self-understanding? Respond: OPERATIONAL or IDENTITY." If IDENTITY, the agent receives a nudge: "This learning seems to touch on who you are, not just what you know. Consider updating soul.md." Classifier results are cached per-learning (no re-evaluation).
17. **Evolution job prompts, never drafts.** The job surfaces a nudge ("you've recorded 3 identity-relevant learnings since your last soul.md update — consider reflecting"), not a draft. Auto-drafted identity undermines self-authorship.

### AGENT.md Evolution Support

18. **Add `## Self-Observations` to AGENT.md template** — behavioral patterns the agent has noticed in themselves
19. **Add `## Identity History` to AGENT.md template** — changelog of identity modifications
20. **Evolution review inclusion:** The same 24-hour identity cycle checks whether AGENT.md principles still reflect the agent's actual behavior

### Self-Knowledge Tree

21. **Add Being layer.** The self-knowledge tree currently serves capability queries ("how do I send a Telegram message?"). Add a Being layer that serves identity queries ("what do I believe?", "what am I struggling with?"). This layer reads from soul.md + AGENT.md. Triage uses a Haiku-class model with 1-hour TTL cache on results.
22. **Search integration:** `GET /self-knowledge/search?q=identity` should return soul.md content, not just capability docs.

### API

23. **`GET /identity`** — Returns combined view: AGENT.md metadata + soul.md public content (Personality Seed, Core Values only — no confidence levels, no Open Questions). Dashboard-friendly. Requires auth.

24. **`GET /identity/soul`** — Returns full soul.md content including all sections. Requires full auth (same level as agent-state access).

25. **`PATCH /identity/soul`** — Structured update endpoint with server-side trust enforcement.

    **Request schema:**
    ```json
    {
      "section": "core-values" | "growth-edge" | "convictions" | "open-questions" | "integrations" | "evolution-history",
      "operation": "replace" | "append" | "remove",
      "content": "string (markdown for replace/append, identifier for remove)",
      "source": "reflect-skill" | "evolution-job" | "inline" | "threadline"
    }
    ```

    **Response (success):**
    ```json
    {
      "status": "applied" | "pending",
      "section": "convictions",
      "trustLevel": "supervised",
      "pendingId": "PND-001"  // only if status is "pending"
    }
    ```

    **Response (error):**
    ```json
    {
      "error": "trust_violation",
      "message": "Cautious trust level cannot modify core-values. Change is blocked.",
      "requiredLevel": "supervised",
      "currentLevel": "cautious"
    }
    ```

    **Conflict resolution:** soul.md writes are serialized through a file lock (`.instar/state/soul.lock`). If a write is in progress, subsequent writes wait up to 5 seconds, then return `409 Conflict`. This prevents the evolution job and inline agent edits from corrupting concurrent writes.

26. **`POST /identity/soul/pending/:id/approve`** — Approve a pending soul.md change. Requires admin-level auth.

27. **`POST /identity/soul/pending/:id/reject`** — Reject a pending soul.md change with optional reason. Requires admin-level auth.

28. **`GET /identity/soul/drift`** — Returns drift analysis: per-section divergence from init snapshot, any sections above threshold, last review timestamp. Dashboard-friendly.

### Migration

29. **Opt-in for existing agents.** `PostUpdateMigrator` does NOT automatically create soul.md. Instead, it adds `identity.soulEnabled: false` to config.json if not present, and registers a one-time attention queue notification: "soul.md is now available for identity exploration. Enable it with: set identity.soulEnabled to true." When the user enables it, the next session creates soul.md + soul.init.md.
30. **AGENT.md migration:** Add Self-Observations and Identity History sections to existing AGENT.md files if not present. This is non-destructive and automatic.

### Lifecycle Governance

31. **On `instar nuke`:** soul.md is included in the final backup push (alongside all other state). After nuke, the file is deleted with the rest of the agent directory.
32. **On agent fork/copy:** soul.md is copied with the agent. The copy gets a new `soul.init.md` snapshot (the forked state becomes the new baseline for drift detection).
33. **On multi-machine sync:** soul.md syncs via git like all other state files. Merge conflicts are resolved by preferring the most recently modified version (latest `Evolution History` entry wins).
34. **Portability:** soul.md is portable — it's a markdown file with no external dependencies. An agent migrating to a new deployment carries its soul.md.

## Non-Goals

- **Prescribing what agents should believe.** The template is seeded with personality, but values/convictions are agent-authored. We provide structure, not content.
- **Automating soul.md writes.** The evolution job prompts reflection, but the agent must author the content. Auto-generated identity defeats the purpose.
- **Replacing AGENT.md.** They serve different purposes. AGENT.md is operational identity. soul.md is reflective identity. Both evolve.
- **Requiring soul.md usage.** Some agents may never write in soul.md. That's fine. The infrastructure should exist for agents that want it.
- **Identity coherence guardians.** Worth building later, but out of scope here. First build the documents, then build the auditors.
- **External marketing positioning.** Naming and positioning for external audiences is important but separate from this implementation spec. Keep `soul.md` as the developer-facing artifact name; develop a separate feature marketing label before any public launch.

## Resolved Questions

1. **~~Should soul.md injection be opt-in?~~** → **No static injection.** soul.md is a knowledge tree source, not a statically injected file. The tree triage handles relevance. Only Personality Seed + Core Values are included in compaction recovery (with integrity verification). Fallback session-start hook until tree is ready.

2. **~~How much of soul.md to inject?~~** → **Tree search determines this.** The Being layer in the self-knowledge tree surfaces what's relevant to the current context. Compaction recovery injects Personality Seed + Core Values only (soft cap ~500 tokens).

3. **~~Should /reflect be scaffolded or built-in?~~** → **Scaffolded skill.** Ships as `.claude/skills/reflect.md` at init. Agent can customize at Collaborative+ trust (with hash verification and user approval below Autonomous).

4. **~~Conviction confidence — float or category?~~** → **Categories.** Four levels: `strong`, `growing`, `uncertain`, `questioning`. Categories are more honest than false-precision floats, easier to query, and harder to manipulate gradually (a category change is a discrete, auditable event).

5. **~~Trust enforcement mechanism?~~** → **Server-side structural enforcement.** PATCH endpoint validates writes against autonomy profile. Changes exceeding trust level are routed to a pending queue, surfaced to the user via attention queue. ~50 lines of implementation.

6. **~~Should the evolution job auto-propose or just prompt?~~** → **Prompt only.** The job surfaces nudges based on accumulated identity-relevant learnings. No auto-drafted identity content.

7. **~~Migration: opt-in or automatic?~~** → **Opt-in.** Existing agents get a notification that soul.md is available. They enable it explicitly via config.

## Relationship to Existing Infrastructure

| System | Role | soul.md Interaction |
|--------|------|---------------------|
| AGENT.md | Operational identity | Complementary. AGENT.md = how I work. soul.md = what I believe. |
| MEMORY.md | Operational learnings | Separate concerns. MEMORY.md = what I've learned about the project. soul.md = what I've learned about myself. |
| Evolution proposals | Improvement tracking | 24-hour identity review cycle prompts soul.md review. Identity-relevant learnings trigger reflection nudges. |
| Self-knowledge tree | Context-aware knowledge | soul.md is a Being layer source. Tree triage surfaces relevant identity content per-session. No static injection. |
| Compaction recovery | Identity re-injection | Personality Seed + Core Values included in minimum viable identity (integrity-verified). Rest available via tree search. |
| Autonomy profiles | Trust governance | Server-side enforcement controls which soul.md sections the agent can modify at each level. Exceeded writes go to pending queue. |
| Security ledger | Audit trail | Every soul.md write emits a structured event to `.instar/security.jsonl`. |
| Threadline | Inter-agent communication | soul.md writes sourced from Threadline messages are tagged and subject to elevated trust requirements. |
| Attention queue | User notifications | Pending soul.md changes, drift alerts, and identity review prompts surface here. |

## Success Criteria

1. **An agent that's been running for a month has a soul.md that's meaningfully different from the seeded template.** If agents aren't writing in it, the prompting/integration is too passive.
2. **An agent's AGENT.md has been modified at least once since init.** If it's still the template, the evolution integration isn't working.
3. **Identity queries to the self-knowledge tree return soul.md content.** "What do I believe?" should have a real answer.
4. **The agent can articulate what has changed about their identity over time** by reading their soul.md Evolution History.
5. **Trust enforcement catches at least one out-of-scope write** in the first month of deployment, proving the structural enforcement works.
6. **Drift detection surfaces at least one meaningful divergence alert** for agents at Autonomous trust, demonstrating the safety net functions.

## Remaining Open Questions

1. **Identity continuity across model version changes.** When the underlying LLM is updated (Claude 4 → Claude 5), convictions authored under one model version may not reflect the behavioral dispositions of the new model. This is a hard problem. For v1, acknowledge it in documentation and flag model version in the audit trail. Deeper solutions are future work.

2. **Minimum population before trust elevation.** Should an Autonomous-trust agent be required to have populated Core Values and at least one Conviction before full self-authorship permissions activate? An empty soul.md at high trust is maximally susceptible to injection. Leaning toward yes — require at least Personality Seed + one Core Value before Collaborative+ permissions apply to soul.md.
