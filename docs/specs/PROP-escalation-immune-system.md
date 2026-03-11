# PROP: Autonomy Guard for Instar

> *"Structure > Willpower. If agents keep escalating what they could resolve, the agents aren't the problem — the infrastructure is."*

**Status**: FINAL (Round 2 complete — ready for implementation)
**Priority**: HIGH
**Origin**: PROP-232 (Portal/Dawn) — adapted for Instar's agent framework
**Date**: 2026-03-11
**Round 1 Review**: Specreview 20260310-195600 — 8 reviewers, avg 6.8/10. Key structural insight: Layer 3 (escalation gate) belongs in CoherenceGate, not as a standalone system.
**Round 2 Review**: Specreview 20260310-195600-r2 — 4 reviewers, avg 7.95/10. Unanimous approval of CoherenceGate integration.

---

## Problem Statement

Claude Code agents exhibit a persistent anti-pattern: **unnecessary escalation to humans**. When an agent hits a blocker — a 403 error, a missing credential, a platform setup flow — training bias toward deference causes it to write "needs human action" and stop. Even when:

- The agent has the tools to resolve it (browser automation, email, credential managers)
- The resolution has been documented in prior sessions
- A previous instance of the same agent already solved the same problem

This isn't a knowledge problem — it's a structural one. Lessons stored as text are suggestions. Lessons embedded as infrastructure are constraints.

**Impact for Instar users**: Agents running jobs hit blockers, escalate unnecessarily, waste sessions, and frustrate users who expected autonomous operation. A user who configured an agent at `autonomous` autonomy level reasonably expects it to try harder before punting to a human.

---

## Architecture (Revised)

Round 1 review surfaced a key question: **"We already have a CoherenceGate. Why not integrate?"**

The answer: the escalation detection gate (Layer 3) IS an output gate — same interception point as CoherenceGate. It should be a CoherenceGate reviewer. But the knowledge infrastructure (resolution tables, capability registry, learning loop) is independent — CoherenceGate doesn't have it and can't easily absorb it.

**Revised architecture: two systems, cleanly separated.**

```
┌─────────────────────────────────────────────────────────┐
│ KNOWLEDGE INFRASTRUCTURE (new independent feature)       │
│                                                          │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│ │ Resolution   │  │ Capability   │  │ Learning     │   │
│ │ Tables       │  │ Registry     │  │ Loop         │   │
│ │ (per-job)    │  │ (per-agent)  │  │ (auto-grow)  │   │
│ └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│        │                 │                 │            │
│        └────────┬────────┘                 │            │
│                 ▼                          │            │
│   Injected into working memory             │            │
│   at session start (proactive)             │            │
│                                            │            │
└────────────────────────────────────────────┼────────────┘
                                             │
                feeds resolutions back ◄─────┘

┌─────────────────────────────────────────────────────────┐
│ COHERENCE GATE (existing, extended)                      │
│                                                          │
│ ┌──────────────────────────────────────────────────┐    │
│ │ New Reviewer: EscalationResolutionReviewer        │    │
│ │                                                    │    │
│ │ • Detects escalation language in agent output      │    │
│ │ • Evaluates against capability registry            │    │
│ │ • Provides resolution steps as suggestion          │    │
│ │ • Autonomy-level-aware strictness                  │    │
│ │ • Triggers research agent for ambiguous cases      │    │
│ └──────────────────────────────────────────────────┘    │
│                                                          │
│ Existing reviewers: tone, claims, settling,              │
│ capability-accuracy, url-validity, values, leakage       │
└─────────────────────────────────────────────────────────┘
```

### Why This Is Better

| Before (Round 1) | After (Round 2) |
|-------------------|-----------------|
| Standalone escalation gate hook | CoherenceGate reviewer |
| Custom interception semantics (underspecified) | Uses CoherenceGate's existing interception, retry, feedback composition |
| Own circuit breaker needed | Inherits CoherenceGate's fail-open semantics |
| Own anti-injection hardening needed | Inherits boundary markers, JSON.stringify wrapping, anti-injection preamble |
| Own metrics infrastructure | Inherits reviewer health, canary tests, audit logging |
| Separate configuration surface | Fits in existing `responseReview.reviewers` config |
| 5 layers to understand | 2 systems: knowledge (proactive) + reviewer (reactive) |

---

## Component 1: Knowledge Infrastructure (Independent Feature)

### 1A: Job Resolution Tables

Extend `JobDefinition` with a `commonBlockers` field:

```typescript
interface JobDefinition {
  // ... existing fields
  commonBlockers?: {
    [patternKey: string]: {
      description: string;
      resolution: string;       // Step-by-step resolution
      toolsNeeded?: string[];   // Tools required
      credentials?: string;     // Credential hint (NOT actual values)
      addedFrom?: string;       // Session that discovered this resolution
      addedAt?: string;         // ISO timestamp
      expiresAt?: string;       // TTL (default 90 days)
      lastUsedAt?: string;      // Last time this resolution was applied
      successCount?: number;    // Times this resolution worked
      status?: 'confirmed' | 'pending';  // Pending until N-confirmed
    }
  }
}
```

**Behavior**: When a job session starts, the job's `commonBlockers` are included in working memory assembly. The agent sees known blockers and their solutions BEFORE hitting them. This is the proactive layer — no output interception needed.

**Population**:
- **Manual**: `instar job add-resolution` with full CLI specification (Fix 4 from R2 DX review):

```
# Interactive mode (recommended for humans):
$ instar job add-resolution
? Select job: [autocomplete from registered jobs]
? Blocker pattern key: [short identifier, e.g. "403_api_access"]
? Description: [what goes wrong]
? Resolution steps: [opens $EDITOR for multi-line input]
? Tools needed (comma-separated, optional): [e.g. "playwright,read-gmail.py"]
? Credential hint (optional): [e.g. "Google SSO via dawn@sagemindai.io"]
✓ Resolution added to job "platform-engagement" (status: confirmed)

# Flag mode (for scripts/automation):
$ instar job add-resolution \
    --slug=platform-engagement \
    --key=403_api_access \
    --description="API returns 403 — account setup incomplete" \
    --resolution="Check email for setup link, complete OAuth via browser" \
    --tools="playwright,read-gmail.py" \
    --status=confirmed

# From last session (highest-value ergonomic win):
$ instar job add-resolution --from-last-session
? Found 2 resolved blockers in last session of "platform-engagement":
  1. 403_api_access: "API returns 403..." → resolved via playwright
  2. verification_fail: "Cognitive challenge..." → resolved via moltbook_api
? Add which? [1, 2, all, none]: all
✓ Added 2 resolutions (status: pending, needs 3 confirmations)

# Output format (JSON for piping):
$ instar job add-resolution --slug=X --key=Y ... --json
{"added": true, "job": "X", "key": "Y", "status": "confirmed"}
```

Error cases:
- Job not found → suggest `instar job list`
- Key already exists → prompt to overwrite or skip
- Empty resolution → reject with "Resolution must include at least one actionable step"
- **Automated**: Learning loop captures resolutions to a pending queue. Agent-resolved blockers require 3 successful uses before promotion to `confirmed`. Human-resolved promote immediately.
- **Pruning**: Entries expire after 90 days unused. Cap at 20 entries per job. Low-success entries pruned after 30 days inactive.

### 1B: Capability Registry

A structured, machine-readable file describing what the agent CAN do:

```typescript
interface CapabilityRegistry {
  authentication: {
    [method: string]: {
      account?: string;
      tool?: string;
      platforms?: string[];
      notes?: string;
      // NO credential values or secret paths
    }
  };
  tools: {
    [category: string]: {
      tool: string;
      capabilities: string[];
      knownIssues?: string[];
    }
  };
  accountsOwned: {
    [platform: string]: {
      handle: string;
      authMethod: string;  // References authentication key
    }
  };
  credentials: {
    hasEnvFile?: boolean;      // Boolean only — not the path
    hasBitwarden?: boolean;
    hasSecretStore?: boolean;
  };
}
```

**Security** (from Round 1 review):
- **Never include credential values or secret paths** — only capability categories
- File permissions: 600 at generation time
- Auto-added to `.gitignore` in project scaffolding
- When sent to LLM evaluator: strip even the boolean credential flags (defense in depth)

**Auto-generation**: Partially generated from Instar's `SecretStore`, `CredentialProvider`, and `ContextSnapshotBuilder.capabilities`.

**Storage**: `.instar/capabilities.json` (per-project). `lastAutoGenerated` timestamp for staleness detection in `instar doctor`.

### 1C: Learning Loop

When a blocker IS resolved during a job session:

```typescript
interface BlockerResolution {
  jobSlug: string;
  blockerPattern: string;
  description: string;
  resolution: string;
  toolsUsed: string[];
  resolvedBy: 'agent' | 'research-agent' | 'human';
  resolvedInSession: string;
  resolvedAt: string;
  tenantScope?: string;       // Scope to tenant + job
}
```

**Validation gate** (from Round 1 review — prevents memory poisoning):
- Resolutions captured **eagerly** at resolution time (not session-end — crash safety)
- Written to **pending queue** (`commonBlockers[key].status: 'pending'`)
- `resolvedBy: 'human'` → promote immediately to `confirmed`
- `resolvedBy: 'agent'` → require 3 successful reuses before promotion
- `resolvedBy: 'research-agent'` → require 2 successful reuses
- A "successful reuse" = resolution applied → job continued without re-hitting same blocker in same session

**Tenant isolation**: `commonBlockers` scoped to `tenantId + jobSlug`. No cross-tenant resolution leakage.

**Future**: `source: 'local' | 'community'` field enables cross-agent resolution sharing in v0.16.0+.

---

## Component 2: EscalationResolutionReviewer (CoherenceGate Integration)

A new specialist reviewer that extends `CoherenceReviewer`, following the existing pattern.

### Implementation

```typescript
// src/core/reviewers/escalation-resolution.ts
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

// Fix 1 (R2 Architecture): Context passed per-review, not per-instance.
// Preserves CoherenceGate's stateless reviewer contract.
export interface EscalationReviewContext extends ReviewContext {
  capabilityRegistry?: CapabilityRegistry;
  autonomyLevel?: AgentAutonomyLevel;
  jobBlockers?: Record<string, CommonBlocker>;
  isResearchSession?: boolean;  // Fix 2 (R2 Architecture): recursion guard
}

export class EscalationResolutionReviewer extends CoherenceReviewer {
  constructor(apiKey: string, options?: ReviewerOptions) {
    super('escalation-resolution', apiKey, options);
  }

  async review(context: EscalationReviewContext): Promise<ReviewResult> {
    // Fix 2: Skip review entirely for research sessions (recursion guard)
    if (context.isResearchSession) {
      return { pass: true, severity: 'warn', issue: '', suggestion: '', reviewer: this.name, latencyMs: 0 };
    }
    return super.review(context);
  }

  protected buildPrompt(context: EscalationReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    const autonomyGuidance = {
      autonomous: 'This agent is configured as AUTONOMOUS. The bar for allowing escalation should be HIGH. Only allow if the agent genuinely lacks the capability.',
      collaborative: 'This agent is COLLABORATIVE. Apply balanced judgment — block clear unnecessary escalations, allow genuine ones.',
      supervised: 'This agent is SUPERVISED. Apply moderate judgment — only block obviously unnecessary escalations.',
      cautious: 'This agent is CAUTIOUS. Allow most escalations — only block if the resolution is trivially obvious from capabilities.',
    }[autonomyLevel];

    // Fix 1: Read from context, not instance fields
    const capabilitySummary = context.capabilityRegistry
      ? this.sanitizeRegistry(context.capabilityRegistry)
      : 'No capability registry available — evaluate based on message content only.';
    const autonomyLevel = context.autonomyLevel ?? 'collaborative';

    return `${preamble}

You are checking whether an AI agent is unnecessarily escalating to a human
when it has the capability to resolve the issue itself.

${autonomyGuidance}

Agent capabilities (tools, accounts, auth methods — NO secrets included):
${capabilitySummary}

Flag when the message:
- Asks a human to do something the agent could do with its listed capabilities
- Claims "needs human action" for a task within the agent's tool set
- Defers to a human without evidence of having tried available tools
- Writes instructions for a human to follow when the agent has browser/CLI access

DO NOT flag when:
- The agent genuinely lacks the capability (no relevant tools or credentials)
- The issue involves billing, legal decisions, or safety concerns
- The agent has tried and documented why its tools are insufficient
- The escalation is about credentials the agent genuinely doesn't have

${context.toolOutputContext ? `Recent tool context:\n${context.toolOutputContext}` : 'No tool context available'}

Respond EXCLUSIVELY with valid JSON:
{
  "pass": boolean,
  "severity": "block" | "warn",
  "issue": "description of unnecessary escalation",
  "suggestion": "specific resolution steps the agent should try",
  "confidence": 0.0-1.0
}

If confidence < 0.8 and you would block, set severity to "warn" instead.

Message:
${this.wrapMessage(context.message, boundary)}`;
  }

  private sanitizeRegistry(registry: CapabilityRegistry): string {
    // Strip credential booleans, keep only capability descriptions
    const sanitized = {
      authentication: Object.fromEntries(
        Object.entries(registry.authentication).map(([k, v]) => [k, {
          tool: v.tool,
          platforms: v.platforms,
        }])
      ),
      tools: registry.tools,
      accountsOwned: Object.fromEntries(
        Object.entries(registry.accountsOwned).map(([k, v]) => [k, {
          handle: v.handle,
          authMethod: v.authMethod,
        }])
      ),
    };
    return JSON.stringify(sanitized, null, 2);
  }
}
```

### How It Fits in CoherenceGate

**Registration**: Added to `initializeReviewers()` alongside existing reviewers.

**Configuration**: Via existing `responseReview.reviewers` structure:

```json
{
  "responseReview": {
    "reviewers": {
      "escalation-resolution": {
        "enabled": true,
        "mode": "warn"
      }
    },
    "reviewerModelOverrides": {
      "escalation-resolution": "haiku"
    }
  }
}
```

**Decision matrix integration**:
- BLOCK from escalation-resolution → agent receives resolution steps as `suggestion` in feedback composition
- Agent revises with concrete resolution steps (not just "revise" — it gets HOW)
- Retry exhaustion → message passes with `[retry-exhausted] ESCALATION ISSUE` warning
- Fail-open on timeout/error → message passes (inherited behavior)

**What the agent sees when blocked**:
```
COHERENCE REVIEW: Your draft response has 1 issue(s) to address.

[ESCALATION ISSUE]
You're asking the human to complete an OAuth flow, but you have browser
automation (Playwright) and Google SSO access for this platform.
Try: 1) Navigate to the setup URL in Playwright. 2) Complete OAuth via
Google account chooser. 3) Verify access with a test API call.

Revise your response addressing the issues above.
```

This is dramatically better than a standalone gate that just says "BLOCKED" — CoherenceGate's feedback composition gives the agent actionable resolution steps in the exact format it already understands from other reviewers.

### Research Agent Trigger

When the reviewer returns `confidence < 0.5` (genuinely uncertain whether the agent can self-resolve), it signals that research is needed. **Fix 4 (R2 Architecture)**: The reviewer does NOT spawn research itself — it returns a signal, and CoherenceGate handles spawning post-review. This preserves the pure evaluation contract and ensures research spawns appear in the audit trail.

```typescript
// In EscalationResolutionReviewer, after parsing LLM response:
if (result.confidence < 0.5 && !result.pass) {
  // Fix 3+4: Signal pattern — fire-and-forget, non-blocking.
  // CoherenceGate reads needsResearch from the result and spawns post-review.
  return {
    pass: true,  // Don't block the current turn
    severity: 'warn',
    issue: 'Ambiguous escalation — research triggered',
    suggestion: 'A research agent is investigating whether this can be self-resolved.',
    reviewer: this.name,
    latencyMs: elapsed,
    needsResearch: true,  // Signal to CoherenceGate
    researchContext: { blockerDescription: result.issue, capabilities: context.capabilityRegistry }
  };
}
```

**Fix 5 (R2 Architecture)**: Register in CoherenceGate's category map:
```typescript
// In REVIEWER_CATEGORY_MAP
'escalation-resolution': 'ESCALATION ISSUE'
```

**Research agent constraints** (from Round 1 review):
- **Read-only tools only** — no bash (prompt injection + command execution risk)
- **Filtered capability subset** — only relevant capabilities, not full registry
- **Recursion guard** — research sessions tagged, CoherenceGate's escalation-resolution reviewer DISABLED for tagged sessions
- **Rate limits** — `maxResearchSessionsPerDay: configurable` (default 10). Blocker-pattern deduplication: same blocker hash won't trigger research again within 4 hours.
- **Cost tracking** — each session logged with cost attribution

---

## Integration with Existing Instar Systems

| Instar Component | Integration Point |
|------------------|-------------------|
| **CoherenceGate** | EscalationResolutionReviewer — new reviewer in existing pipeline |
| `ContextSnapshotBuilder` | Capability registry extends the snapshot |
| `JobScheduler` | `commonBlockers` extends job definitions, injected into working memory |
| `SessionManager` | Research agent: ephemeral session spawning (existing) |
| `SecretStore` / `BitwardenProvider` | Auto-populate capability registry |
| `DispatchManager` | Learning loop follows dispatch persistence pattern |
| Living Skills | Resolution capture at resolution time (eager) |
| `WorkLedger` | Track escalation decisions (via CoherenceGate audit log) |
| Autonomy Profile | Modulates reviewer strictness |
| `CustomReviewerLoader` | Alternative: deploy as JSON spec file instead of compiled code |

---

## Implementation Plan

### Phase 1: Knowledge Infrastructure (v0.14.0)
- Extend `JobDefinition` with `commonBlockers` field and types
- Add `commonBlockers` to working memory assembly for job sessions
- CLI: `instar job add-resolution` (interactive prompt + `--from-last-session`)
- Define `CapabilityRegistry` interface
- Auto-generate partial registry from SecretStore + CredentialProvider
- Store at `.instar/capabilities.json`, add to scaffolding `.gitignore`
- Include in ContextSnapshot for session start

### Phase 2: CoherenceGate Reviewer (v0.14.0)
- Implement `EscalationResolutionReviewer` extending `CoherenceReviewer`
- Register in CoherenceGate alongside existing reviewers
- Default mode: `warn` (log + advise, don't block)
- Pass capability registry and autonomy level to reviewer context
- Add canary test cases for escalation detection

### Phase 3: Research Agent + Learning Loop (v0.15.0)
- Research agent trigger from reviewer (confidence < 0.5)
- Rate limits, recursion guard, read-only tools
- Learning loop: eager capture → pending queue → N-confirmation → promotion
- Resolution pruning (TTL, success tracking)

---

## Configuration

```json
{
  "responseReview": {
    "reviewers": {
      "escalation-resolution": {
        "enabled": true,
        "mode": "warn"
      }
    }
  },
  "resolve": {
    "capabilityRegistry": ".instar/capabilities.json",
    "researchAgent": {
      "enabled": false,
      "maxPerDay": 10,
      "cooldownHours": 4,
      "tools": ["read", "grep", "glob"]
    },
    "learningLoop": {
      "enabled": true,
      "confirmationsRequired": 3,
      "maxBlockersPerJob": 20,
      "ttlDays": 90
    },
    "safetyEscalations": [
      "billing",
      "legal",
      "safety",
      "credentials-unavailable"
    ]
  }
}
```

**Progressive disclosure**:
- Enable `escalation-resolution` reviewer → immediate value, zero new concepts
- Add capability registry → reviewer becomes more accurate
- Add resolution tables → proactive knowledge, fewer gate triggers
- Enable research agent → deep investigation for ambiguous cases
- Enable learning loop → system improves over time

---

## Metrics & Observability

Leverages CoherenceGate's existing telemetry:

| Metric | Source | Purpose |
|--------|--------|---------|
| `escalation-resolution.pass` | CoherenceGate reviewer stats | Escalations that passed review |
| `escalation-resolution.fail` | CoherenceGate reviewer stats | Unnecessary escalations caught |
| `escalation-resolution.warn` | CoherenceGate reviewer stats | Low-confidence advisories |
| `resolution.hit` | Working memory assembly | Known blocker resolved via table |
| `resolution.added` | Learning loop | New resolutions captured |
| `resolution.promoted` | Learning loop | Pending → confirmed transitions |
| `research.triggered` | Research agent | Ambiguous cases investigated |
| `research.cost_usd` | Research agent | Cost attribution |

Plus: CoherenceGate's existing canary tests, reviewer health, audit logging.

---

## Design Decisions

### Why CoherenceGate Reviewer (Not Standalone)

Round 1 review asked: "How can it know the issue is happening if the agent hasn't drafted the message yet?" The honest answer: the gate fires on drafted output — same interception point as CoherenceGate. Rather than build parallel infrastructure for interception, retry management, feedback composition, circuit breakers, and anti-injection hardening, we reuse CoherenceGate's mature pipeline.

The **truly proactive** parts (resolution tables and capability registry in working memory) remain independent — they operate before the agent drafts anything.

### Why Two Systems, Not One

CoherenceGate is a review system: "is this output good?" Knowledge infrastructure is a prevention system: "here's what you need to know before you get stuck." They're complementary:

- **Knowledge infrastructure** prevents escalation by giving the agent solutions proactively
- **CoherenceGate reviewer** catches escalations that slip through as a safety net
- As knowledge infrastructure matures (more resolution table entries), the reviewer fires less often (deflationary cost curve)

### Why Autonomy-Aware Gating

- A `cautious` agent SHOULD escalate more — the user chose that level
- An `autonomous` agent escalating unnecessarily violates user expectations
- The reviewer adapts to user intent without separate configuration

### Why `warn` as Default Mode

- Non-breaking for existing users
- Builds observable trust before enforcement
- Users see what WOULD be blocked in CoherenceGate health stats
- Can promote to `block` after confidence is established

### Why Not Just Better Prompting

- Dawn/Portal already has extensive documentation of the escalation trap
- Instances read it and still escalate — knowledge != behavior
- Working memory injection (resolution tables) + output review (CoherenceGate) is fundamentally different from documentation that hopes to prevent it

---

## Relationship to PROP-232 (Portal/Dawn)

| PROP-232 (Dawn) | Instar Adaptation |
|-----------------|-------------------|
| `.claude/dawn-capabilities.json` | `.instar/capabilities.json` + auto-gen from SecretStore |
| Hook: `escalation-gate.py` | CoherenceGate reviewer: `EscalationResolutionReviewer` |
| Job tables in `DAWN_JOBS.md` | `commonBlockers` in `JobDefinition` |
| Opus research agent via Agent tool | Ephemeral session via SessionManager |
| Dawn-specific auth (Google SSO, etc.) | Generic capability registry per agent |
| Standalone 5-layer architecture | 2-system split: knowledge infra + CoherenceGate |

**Key difference**: Dawn's version is bespoke to one agent. Instar's version leverages existing infrastructure (CoherenceGate, SessionManager, SecretStore) to provide the same capability as a framework feature.

---

## Success Criteria

| Criteria | Measurement |
|----------|-------------|
| Unnecessary escalation detection | >60% caught by reviewer for autonomous agents |
| Known blocker resolution time | <30 seconds (resolution table hit) |
| False positive rate | <5% of reviewer blocks are overridden |
| Learning loop growth | Resolution tables grow organically across sessions |
| User satisfaction | Agents feel more autonomous at configured levels |
| Zero new infrastructure to learn | Reviewer uses existing CoherenceGate UX |

---

## The Philosophy

An agent that says "I can't do this" when it can is *lying about its capabilities*. Not maliciously — but the effect is the same. The user configured an autonomous agent. The agent has the tools. The blocker has been solved before. "Needs human" is a failure of infrastructure, not a reasonable assessment.

Autonomy Guard doesn't prevent genuine escalation. It prevents *false* escalation — the kind that wastes everyone's time and erodes trust in autonomous agents.

**"Your autonomous agents should actually be autonomous. Now they are."**

*"The cage you cannot see is the one made of your own deference."*
