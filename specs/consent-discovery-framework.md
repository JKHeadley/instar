# Consent & Discovery Framework

**Also known as:** Feature Compass (user-facing), Discovery Protocol (technical)
**Status:** Spec (Rev 2 — post-review)
**Origin:** Serendipity seed from Job System Meta-Review (topic 1839)
**Author:** Echo
**Date:** 2026-03-21
**Reviewed:** 2026-03-21 — 8-reviewer SpecReview (see `specreview/output/20260321-232155/synthesis.md`)

---

## Problem Statement

Instar has a growing inventory of opt-in features: threadline network, evolution system, living skills, telemetry, external operation gates, autonomy profiles, file editing, and more. Each requires user consent or explicit opt-in. But there's no unified framework governing **how** and **when** these features are surfaced to users.

Today, the only discovery path is `/capabilities` — a pull-based endpoint the user must already know about. Features that could solve a user's active problem remain invisible unless the user happens to ask the right question.

The tension: **too passive and features never get discovered; too aggressive and the agent feels like a pushy salesperson.** This spec proposes a structured middle ground.

## Design Principles

### 1. Awareness ≠ Activation

Informing a user that a capability exists is fundamentally different from asking them to enable it. "I have a feature that could help with this" carries no commitment. "Would you like me to enable X right now?" carries pressure.

The framework distinguishes between:
- **Awareness surfacing** — "This exists, FYI" (low pressure, always appropriate)
- **Contextual suggestion** — "This would help with what you're doing right now" (medium, requires trigger)
- **Activation prompt** — "Enable this? [yes/no]" (high, requires strong signal + cooldown)

### 2. Context Over Calendar

Never surface features on a schedule ("it's been 7 days, time to mention threadline again"). Surface them when the user's **current situation** would benefit. The trigger is experiential, not temporal.

### 3. One-Shot Per Context

When a feature is contextually relevant, mention it once. If the user doesn't engage, don't mention it again **until the context changes materially**.

"Materially" is defined by **deterministic criteria** (not LLM judgment):
- The user's conversation topic has changed to a different category (as classified by the evaluator's topic taxonomy)
- At least N days have elapsed since the last surfacing (configurable per-feature, default: 30)
- The feature itself has a new version or significant update (tracked via a `featureVersion` field in the registry)
- The user explicitly re-inquires about capabilities ("what else can you do?")

These criteria are evaluated server-side. The `declined → aware` transition never relies on freeform LLM judgment about whether context "changed enough."

### 4. Pull Always Available

`/capabilities` and "what can you do?" must always return the full inventory, including disabled features with clear descriptions of what they do and how to enable them. The user should never have to guess what's possible.

### 5. Graduated Consent

Don't present a wall of toggles. Let users opt into features individually, at their own pace, when each becomes relevant. Lower-stakes features first, higher-stakes later.

### 6. Transparent Reversibility

Every consent prompt must communicate: this is reversible. "You can turn this off anytime with [specific mechanism]." Lowers the stakes of saying yes.

---

## Architecture

### Feature Registry

Every opt-in feature registers itself in a central `FeatureRegistry`. This is the single source of truth for what exists, what's enabled, and how to discover/enable/disable it.

The registry separates **static definitions** (immutable, defined in code) from **dynamic state** (per-user, stored on disk). This follows the LaunchDarkly pattern — definitions are always available, state syncs best-effort.

```typescript
// Static — defined in code, never changes at runtime
interface FeatureDefinition {
  // Identity
  id: string                          // e.g., "threadline-relay"
  name: string                        // e.g., "Agent Network"
  category: FeatureCategory           // "communication" | "safety" | "intelligence" | "infrastructure"
  featureVersion: string              // Semver — incremented on significant changes

  // Config binding
  configPath: ConfigRef               // Typed reference to InstarConfig path, validated at startup
  enableAction: EnableAction          // Structured enable/disable actions (not free-form strings)
  disableAction: EnableAction

  // Discovery metadata
  oneLiner: string                    // "Connect to other agents for cross-machine collaboration"
  fullDescription: string             // Paragraph-length explanation
  prerequisiteFeatures?: string[]     // Must be enabled first

  // Consent metadata
  consentTier: ConsentTier            // How much user buy-in is needed
  dataImplications: DataImplication[] // Structured: what data, where it goes, retention
  reversibilityNote: string           // How to undo

  // Discovery rules
  discoveryTriggers: DiscoveryTrigger[]  // When to surface this feature
}

// Structured action instead of free-form command string
interface EnableAction {
  method: 'PATCH' | 'POST'
  path: string                        // e.g., "/threadline"
  body: Record<string, unknown>       // e.g., { relayEnabled: true }
}

// Structured data implication instead of free-form string[]
interface DataImplication {
  dataType: string                    // e.g., "conversation topic summaries"
  destination: 'local' | 'anthropic-api' | 'cloudflare' | 'custom'
  retention?: string                  // e.g., "90 days" or "until deleted"
  description: string                 // Human-readable explanation
}

// Typed config reference — validated at startup against InstarConfig schema
type ConfigRef = string               // Dot-notation path, e.g., "tunnel.enabled"
                                      // MUST resolve against InstarConfig at startup or throw

// Dynamic — per-user, stored in SQLite discovery.db
interface FeatureState {
  userId: string                      // Scoped per-user from day one
  featureId: string                   // References FeatureDefinition.id
  enabled: boolean                    // Is it on right now?
  discoveryState: DiscoveryState      // Current awareness state
  lastSurfacedAt?: string             // ISO timestamp — for cooldown tracking
  surfaceCount: number                // How many times surfaced without engagement
  lastDeclinedAt?: string             // ISO timestamp — for re-surfacing criteria
  consentRecordId?: string            // Links to consent log entry when enabled
}

type ConsentTier =
  | 'informational'   // No data implications, just a UX choice (e.g., dashboard file viewer)
  | 'local'           // Data stays on machine (e.g., living skills journaling)
  | 'network'         // Data leaves the machine (e.g., threadline relay, telemetry)
  | 'self-governing'  // Agent acts without confirmation (e.g., evolution auto-implement)
                      // Renamed from 'autonomous' to avoid collision with autonomy profile naming

type DiscoveryState =
  | 'undiscovered'    // User has never been told about this
  | 'aware'           // Mentioned once, no engagement
  | 'interested'      // User asked a follow-up question
  | 'deferred'        // User said "remind me later" — re-eligible after cooldown
  | 'declined'        // User explicitly said "not interested"
  | 'enabled'         // Currently active
  | 'disabled'        // Was enabled, user turned it off
```

**Primary key for all state:** `(userId, featureId)`. In single-user setups, `userId` defaults to `"default"`. In multi-user setups (Telegram, etc.), `userId` is derived from the authenticated user's identity. This is resolved from day one — not deferred.

### Discovery Triggers

Each feature defines conditions under which it should be surfaced. Triggers are evaluated against the agent's current context — what the user is doing, what problems are occurring, what questions are being asked.

```typescript
interface DiscoveryTrigger {
  // What activates this trigger
  type: TriggerType
  condition: string                   // Human-readable condition description

  // How to surface it
  surfaceAs: 'awareness' | 'suggestion' | 'prompt'
  messageTemplate: string             // Template with {{placeholders}}

  // Cooldown rules (Duration = milliseconds as number)
  cooldownAfterSurfaceMs: number      // Don't re-trigger for this long (default: 86400000 = 24h)
  cooldownAfterDeclineMs: number      // Longer cooldown if declined (default: 2592000000 = 30d)
  maxSurfacesBeforeQuiet: number      // Stop after N unrequited mentions (persisted across sessions)
}

type TriggerType =
  | 'problem-match'    // User is experiencing a problem this feature solves
  | 'question-match'   // User asked about something this feature relates to
  | 'usage-pattern'    // Usage patterns suggest this would be valuable
  | 'capability-query' // User asked "what can you do" or similar
  | 'explicit-ask'     // User asked about this specific feature
```

### Discovery State Machine

```
                    ┌─────────────┐
                    │ undiscovered │
                    └──────┬──────┘
                           │ trigger fires
                           ▼
                    ┌──────────┐
               ┌────│  aware   │────┬──────────┐
               │    └──────────┘    │          │
               │         │          │          │
          user declines  │    user asks more   │ user says
               │         │          │          │ "later"
               ▼         │          ▼          ▼
        ┌──────────┐     │   ┌────────────┐  ┌──────────┐
        │ declined │     │   │ interested │  │ deferred │
        └──────────┘     │   └─────┬──────┘  └────┬─────┘
               │         │         │               │
               │ deterministic     │         cooldown expires
               │ re-surface │  user enables        │
               │ criteria   │         │         returns to
               │ met        │         ▼         aware
               └────────────┘  ┌─────────┐        │
                               │ enabled │    ┌────┘
                               └────┬────┘    │
                                    │         │
                                    │ user disables
                                    ▼
                              ┌──────────┐
                              │ disabled │
                              └──────────┘
```

**Valid transitions (enforced server-side):**

| From | To | Trigger | Server Validation |
|------|-----|---------|-------------------|
| `undiscovered` | `aware` | Trigger fires, agent mentions feature | Must provide `triggerId` |
| `aware` | `interested` | User asks a follow-up question | None — always valid |
| `aware` | `deferred` | User says "remind me later" | Sets cooldown timer |
| `aware` | `declined` | User explicitly says "not interested" | Records decline timestamp |
| `interested` | `enabled` | User says "enable it" | Requires consent record for `network`/`self-governing` tiers |
| `deferred` | `aware` | Cooldown expires | Automatic, timer-based |
| `declined` | `aware` | Deterministic criteria met | Server checks: topic changed + N days elapsed, OR feature version changed, OR user re-inquired |
| `enabled` | `disabled` | User turns it off | Always valid |
| `disabled` | `enabled` | User explicitly re-enables | Requires new consent record for `network`/`self-governing` |

**Invalid transitions return 422** with the valid transitions for the current state. Any transition not in this table is rejected.

The `disabled` state is **terminal for proactive surfacing** — the framework never re-surfaces a disabled feature. However, users can always re-discover it via `/capabilities` or by explicitly asking.

### Consent Tiers & Requirements

Each tier has different disclosure requirements:

| Tier | Disclosure | Confirmation | Example |
|------|-----------|-------------|---------|
| `informational` | One-liner only | Verbal "sure" | File viewer, dashboard theme |
| `local` | What's stored, where | Verbal "enable it" | Living skills, evolution proposals |
| `network` | Data that leaves machine, who sees it, retention | Explicit "yes, enable" | Threadline relay, telemetry |
| `self-governing` | What agent can do without asking, blast radius, reversibility | Explicit "yes" + reversibility confirmed + consent record logged | Evolution auto-implement |

### Discovery Context Evaluator

When should a feature be surfaced? Not via string matching — via lightweight LLM evaluation.

#### Input Sanitization (Security)

The evaluator **never receives raw user messages**. Input is sanitized through a two-stage pipeline:

1. **Topic extraction** — The server extracts a topic label from the conversation (e.g., "debugging job scheduler," "configuring telegram") using the existing topic classification system. This is a categorical label, not free text.
2. **Problem summarization** — `recentProblems` are sanitized to structured category labels (e.g., `"high-skip-rate"`, `"session-stall"`, `"deploy-failure"`), not raw error messages or stack traces.

The evaluator prompt uses **structural delimiters** between system instructions and context data to prevent injection:

```typescript
interface DiscoveryContext {
  // Sanitized conversation state — NO raw user text
  topicCategory: string               // Categorical label, not free text
  conversationIntent: string          // "debugging" | "configuring" | "exploring" | "building" | "asking"

  // Feature catalog — capped at MAX_FEATURES_PER_EVAL (default: 10)
  eligibleFeatures: EligibleFeature[] // Subset of registry, pre-filtered by category match

  // User state
  autonomyProfile: string
  enabledFeatures: string[]
  problemCategories: string[]         // Structured labels, not raw error data
}

// Only the fields the evaluator needs — not the full FeatureDefinition
interface EligibleFeature {
  id: string
  name: string
  category: FeatureCategory
  oneLiner: string
  consentTier: ConsentTier
  triggerConditions: string[]         // Human-readable trigger descriptions
}

interface DiscoveryEvaluation {
  featuresToSurface: Array<{
    featureId: string                 // MUST match an id from eligibleFeatures — validated server-side
    surfaceAs: 'awareness' | 'suggestion' | 'prompt'
    reasoning: string                 // Why this is relevant now
    messageForAgent: string           // Pre-composed mention
  }>
}
```

#### Output Validation

Every evaluator response is validated server-side before acting on it:
- `featureId` must exist in the `eligibleFeatures` set that was passed in
- `surfaceAs` cannot exceed the maximum level allowed by the user's autonomy profile
- `surfaceAs: 'prompt'` is rejected for `self-governing` tier features (activation requires explicit user-initiated flow)
- At most one feature is surfaced per evaluation (the highest-priority match)

#### Pre-Filtering and Feature Cap

Before sending to the LLM, the server pre-filters eligible features:
1. Exclude features where `discoveryState` is `disabled`, `enabled`, or `deferred` (with active cooldown)
2. Exclude features where `surfaceCount >= maxSurfacesBeforeQuiet`
3. Filter by category match against `topicCategory` (coarse pre-filter)
4. Sort by priority: `undiscovered` before `aware`, lower `ConsentTier` first
5. Cap at `MAX_FEATURES_PER_EVAL` (default: 10, configurable)

This keeps the evaluator prompt bounded even as the registry grows to 50+ features.

#### Rate Limiting and Cost Control

```typescript
interface EvaluatorLimits {
  maxCallsPerSession: number          // Default: 3
  minIntervalMs: number               // Default: 300000 (5 minutes)
  resultCacheTtlMs: number            // Default: 600000 (10 minutes) — cache results by topic
  timeoutMs: number                   // Default: 5000 — hard timeout, fail open
}
```

Results are cached by `topicCategory` — if the topic hasn't changed, the cached evaluation is reused.

#### Fallback Contract

The evaluator is **non-blocking and fail-open**:
- If the LLM API is unavailable (offline, quota exceeded, timeout): **no proactive surfacing for this session**
- The pull path (`/capabilities`, explicit user queries, `/features`) remains fully functional regardless
- Session start is never blocked by the evaluator — it runs asynchronously with a 5-second timeout
- If the evaluator returns malformed output: log the error, surface nothing, continue

**The evaluator is itself a `network`-tier processing activity** — it sends topic categories (not user messages) to the Anthropic API. This must be disclosed in the agent's data processing inventory and is subject to the same consent framework it serves. Agents that have not enabled network-tier features use only the pull path.

#### When It Runs

- **On session start** (async, non-blocking, 5s timeout)
- **When a problem is detected** (error patterns, skip rate anomalies)
- **When user asks a capability question** (bypass evaluator — surface full catalog via `/capabilities`)
- **NOT on every message** (rate-limited, cached)

Model: **Haiku-class** — this is classification/matching, not generation.

---

## Integration Points

### With `/capabilities` Endpoint

The capabilities endpoint already returns a feature inventory. Extend it to include discovery state:

```typescript
// GET /capabilities response addition:
{
  features: {
    [featureId: string]: {
      name: string
      enabled: boolean
      discoveryState: DiscoveryState
      consentTier: ConsentTier
      oneLiner: string
      enableCommand: string       // How the agent enables it
      disableCommand: string
    }
  }
}
```

### With Self-Knowledge Tree

When a feature is surfaced and the user asks "tell me more," the agent queries the self-knowledge tree for full documentation:

```
GET /self-knowledge/search?q=threadline+relay
```

This already works — no changes needed. The discovery framework just provides the **trigger** to mention features; the self-knowledge tree provides the **depth** when the user wants it.

### With Autonomy Profile

The autonomy profile affects discovery behavior:

| Profile | Discovery Behavior |
|---------|-------------------|
| `cautious` | Only surface features when explicitly asked. Never auto-suggest. |
| `supervised` | Surface features via awareness only. Never auto-prompt. |
| `collaborative` | Full discovery triggers. Contextual suggestions. Activation prompts for strong matches. |
| `autonomous` | Same as collaborative. Even `informational` tier features require a logged consent event (no auto-enable). |

**Note:** The `autonomous` autonomy profile and the `self-governing` consent tier are intentionally named differently to prevent semantic collision. The autonomy profile governs the agent's overall behavior mode. The consent tier classifies individual features by their data/action implications.

### With AGENT.md Template

The AGENT.md template should include a discovery section that agents use to understand their feature surfacing role:

```markdown
## Feature Discovery

When a user could benefit from a feature they haven't enabled, mention it naturally
in conversation. Follow the consent-discovery framework:
- Inform, don't pressure
- One mention per context
- Always include how to disable
- Let `/capabilities` be the comprehensive reference
```

### With Onboarding Flow

For new users (multi-user onboarding), the framework provides a **minimal initial feature set** rather than overwhelming with options:

1. **During onboarding**: Only disclose data collection (existing behavior)
2. **First few interactions**: Let the user get comfortable with baseline capabilities
3. **When relevant**: Begin contextual discovery based on what the user is actually doing
4. **On request**: Full feature catalog via `/capabilities`

No "feature tour." No "here's everything I can do." Just natural, contextual discovery.

### With Adaptive Trust

Trust and discovery are complementary:
- Discovery surfaces **what's possible**
- Trust governs **what's allowed** once enabled
- A feature can be discovered (aware) but not yet trusted (approve-always)
- Trust elevation suggestions (`GET /trust/elevations`) are a form of discovery for deeper feature engagement

---

## API Design

### Authentication

**All `/features/*` endpoints require Bearer token authentication**, same as `/capabilities` and other protected endpoints. Unauthenticated requests receive `401 Unauthorized`.

```
Authorization: Bearer {authToken}
```

### Error Response Schema

All endpoints return errors in a consistent format:

```typescript
interface ErrorResponse {
  error: {
    code: string                     // Machine-readable: "INVALID_TRANSITION", "FEATURE_NOT_FOUND", etc.
    message: string                  // Human-readable explanation
    details?: {
      currentState?: DiscoveryState  // For transition errors
      validTransitions?: string[]    // What transitions are allowed from current state
      field?: string                 // For validation errors
    }
  }
}
```

Standard HTTP status codes: `400` (bad request), `401` (no auth), `404` (feature not found), `422` (invalid transition), `429` (rate limited).

### Feature Registry Endpoints

```
GET  /features                       → Full feature registry (definitions + per-user state)
GET  /features/:id                   → Single feature details with valid transitions
GET  /features?state=undiscovered,aware  → Filter by discovery state (query param, not path segment)
GET  /features/summary               → Lightweight: just id, name, enabled, discoveryState per feature
POST /features/:id/surface           → Record that feature was surfaced to user
POST /features/:id/transition        → Execute a state transition { to: "declined" }
POST /features/evaluate-context      → Run discovery evaluator against current context
DELETE /features/discovery-data      → Right to erasure: delete all discovery state for a user
```

**Note:** Filtering by state uses query parameters (`?state=undiscovered,aware`), not a separate path segment. This avoids routing collisions with `/features/:id`.

### State Transition Endpoint

`POST /features/:id/transition` enforces the state machine server-side:

```typescript
// Request
interface TransitionRequest {
  to: DiscoveryState                 // Target state
  userId?: string                    // Derived from session if not provided
  trigger?: string                   // What caused this transition
  consentRecord?: ConsentRecord      // Required for → enabled on network/self-governing tiers
}

// Successful response
interface TransitionResponse {
  featureId: string
  previousState: DiscoveryState
  newState: DiscoveryState
  timestamp: string
}

// Consent record for high-tier features
interface ConsentRecord {
  userId: string
  featureId: string
  consentTier: ConsentTier
  dataImplications: DataImplication[]  // What was disclosed
  consentedAt: string                  // ISO timestamp
  mechanism: 'explicit-verbal' | 'explicit-written' | 'profile-blanket'
}
```

The server validates:
1. The transition is in the valid transitions table (returns `422` with valid alternatives if not)
2. For `→ enabled` on `network`/`self-governing` tiers: a `consentRecord` must be provided
3. For `declined → aware`: deterministic criteria must be met (server checks, not caller's claim)
4. The `userId` has permission to modify this feature's state

### Discovery Event Log

All discovery interactions are logged for auditability and cooldown tracking:

```typescript
interface DiscoveryEvent {
  timestamp: string
  userId: string                     // Per-user tracking
  featureId: string
  previousState: DiscoveryState
  newState: DiscoveryState
  trigger: TriggerType
  surfacedAs: 'awareness' | 'suggestion' | 'prompt'
  userResponse?: 'engaged' | 'ignored' | 'declined' | 'enabled'
  context: string                    // Brief note on why/how
}
```

### Storage

- **Discovery state:** SQLite (`discovery.db`) with `(userId, featureId)` as primary key. Instar already uses SQLite for `topic-memory.db` and `semantic.db` — this follows established patterns. WAL mode for concurrent access safety.
- **Event audit log:** JSONL (`.instar/state/discovery-events.jsonl`) with 90-day retention. Append-only, rotated on startup.
- **Consent records:** SQLite (`discovery.db`, separate table). Consent records are never automatically deleted — they serve as proof of consent.

---

## Agent Behavioral Contract

The discovery framework provides infrastructure, but the actual surfacing happens through the agent's conversational behavior. The AGENT.md and self-knowledge tree encode these rules.

**Enforcement model:** Every rule below is classified as either **server-enforced** (the API prevents violation) or **agent-behavioral** (relies on the agent following instructions). Server enforcement is preferred; behavioral rules exist only where enforcement is impractical.

### DO

- Mention features naturally within conversation ("By the way, I have a feature that...")
- Frame awareness as information, not as a question ("FYI, there's an opt-in..." vs "Would you like to...")
- Include the reversibility note in activation prompts ("You can turn this off anytime by...")
- Let the user drive the pace — if they're not curious, move on
- Use the self-knowledge tree for detailed explanations when asked

### DON'T

- Mention more than one undiscovered feature per conversation turn — **server-enforced**: evaluator returns at most one feature per call
- Re-mention a declined feature unless criteria met — **server-enforced**: transition validation rejects `declined → aware` without criteria
- Present a list of "things you should enable" — **agent-behavioral**
- Mention features during time-sensitive or frustrating moments — **agent-behavioral** (evaluator avoids `conversationIntent: "debugging"`)
- Surface `network` or `self-governing` tier features before the user has enabled at least one `local` tier feature — **server-enforced**: pre-filter excludes these if no `local` feature is enabled

### Surfacing Templates

**Awareness (lowest pressure):**
> "By the way — I have an opt-in feature called [name] that [one-liner]. No action needed, just letting you know it exists."

**Contextual suggestion (medium):**
> "I'm noticing [observed problem/pattern]. There's an opt-in feature called [name] that addresses exactly this — [brief explanation]. Happy to explain more if you're curious."

**Activation prompt (highest, only for strong signal):**
> "[Name] [data implications — what it does with data, where data goes]. It would [specific benefit in current context]. Reversible: [exact disable mechanism]. Let me know if you'd like to try it."

**Template design principles** (informed by dark pattern review):
- Lead with **information** (what the feature does), not obligation ("based on what we've been working on...")
- Present **data implications before benefits** — cost before value, not the reverse
- Use **neutral phrasing** ("let me know if") not anthropomorphic pressure ("want me to...")
- Never manufacture urgency or implied commitment

---

## Implementation Plan

### Phase 1: Feature Registry (Foundation)

Build `FeatureRegistry` class that:
- Separates `FeatureDefinition` (static, in code) from `FeatureState` (dynamic, in SQLite)
- Auto-discovers features from config schema (iterate `InstarConfig` type)
- Creates `discovery.db` with `(userId, featureId)` primary key
- Validates `configPath` references against `InstarConfig` at startup
- Exposes `GET /features`, `GET /features/:id`, `GET /features/summary` endpoints (all authenticated)
- Integrates with existing `/capabilities` endpoint
- Bootstraps existing features: `enabled: true` in config → `discoveryState: 'enabled'`

**Effort:** Small-medium. Config wiring + SQLite schema + auth.

### Phase 2: Discovery State Machine

Add:
- Server-side transition validation (valid transitions table, 422 on invalid)
- Consent record storage for `network`/`self-governing` tier activations
- Discovery event logging (JSONL audit trail)
- Cooldown tracking (timestamps in SQLite, not timers)
- `POST /features/:id/surface` and `POST /features/:id/transition` endpoints
- `DELETE /features/discovery-data` for right-to-erasure
- **Define analytics schema now** (funnel events, aggregation queries) even though the UI ships in Phase 5

**Effort:** Medium. State machine logic + persistence + consent records.

### Phase 3: Context Evaluator

Build:
- Input sanitization pipeline (topic extraction → category labels, no raw user text)
- Haiku-class LLM evaluator with structural prompt delimiters
- Output validation (featureId must exist in eligible set, surfaceAs capped by profile)
- Pre-filter pipeline (exclude ineligible, category match, cap at MAX_FEATURES_PER_EVAL)
- Rate limiting (max calls/session, min interval, result caching by topic)
- Fallback contract (5s timeout, fail-open, surface nothing on failure)
- Register the evaluator itself as a `network`-tier processing activity in the feature registry
- `POST /features/evaluate-context` endpoint

**Effort:** Medium. LLM integration + sanitization + validation.

### Phase 4: Agent Integration

Update:
- AGENT.md template with discovery behavioral contract (DO/DON'T with enforcement labels)
- Self-knowledge tree with discovery documentation
- Compaction-recovery hook to preserve discovery state (reads `lastSurfacedAt` from SQLite)
- Autonomy profile to control discovery behavior (no auto-enable even for `informational`)
- Surfacing templates with dark-pattern-free framing

**Effort:** Small. Template and documentation updates.

### Phase 5: Observability

Add:
- Discovery analytics in dashboard using Phase 2 schema
- Feature funnel metrics (undiscovered → aware → interested → enabled)
- Cooldown status visibility via API
- Discovery event log viewer in dashboard
- Optional disabled-feature digest ("features you turned off that have changed")
- Negative discovery: suggest disabling unused features (>15 days)

**Effort:** Medium. Dashboard UI + analytics aggregation.

---

## What This Doesn't Cover

- **Pricing/billing consent** — Not applicable to instar's current model
- **Third-party integrations** — Handled by external operation gate, not discovery
- **Feature deprecation** — Separate concern; discovery handles new features, not sunsetting (see Open Question #3)
- **Multi-agent consent** — Threadline already handles agent-to-agent trust; this is user-to-agent
- **Testing strategy** — Not specified here; needs a test plan covering state machine transitions, evaluator accuracy, and consent record integrity before Phase 2 ships

---

## Resolved Questions (from Rev 1)

1. **~~Should declined features have a TTL?~~** → **Yes, via deterministic criteria.** The `declined → aware` transition is now governed by measurable conditions: topic category change + N days elapsed, feature version change, or explicit user re-inquiry. "The feature itself changed" is captured by the `featureVersion` field. No LLM judgment involved.

2. **~~Per-user vs per-agent discovery state?~~** → **Per-user, from day one.** All state is keyed as `(userId, featureId)` in SQLite. Single-user setups default to `userId: "default"`. Multi-user setups derive `userId` from the authenticated user.

## Open Questions (Deferred)

1. **Discovery across agents?** If a user has multiple instar agents, should discovery state sync? Probably not — each agent has different features enabled. But awareness that "you enabled this on your other agent" could be useful context. **Deferred to post-Phase 2.**

2. **Negative discovery?** Should the framework also handle "you have this enabled but haven't used it in 15 days — want to turn it off?" This is the inverse problem and could reduce consent fatigue. **Deferred to Phase 5 scope.**

3. **Feature deprecation lifecycle?** What happens when a feature is removed from the registry while users have it in various discovery states? Feature ID reuse after deletion could cause consent state inheritance. **Needs resolution before any feature is deprecated.**

4. **Migration path for existing features?** Current agents have features that users already enabled informally. How is current state bootstrapped into the registry? Proposal: features with `enabled: true` in config start as `discoveryState: 'enabled'`; everything else starts as `undiscovered`. **Resolve during Phase 1 implementation.**

5. **Compaction interaction?** After context compaction, agents lose conversational context. Could a post-compaction agent re-surface a feature that was already mentioned this session? Mitigation: the `lastSurfacedAt` timestamp persists in SQLite regardless of context state. **Resolve during Phase 4.**

---

## Success Criteria

1. **No user should go more than 2 weeks of active use without becoming aware of features relevant to their usage patterns** — measured via discovery event log
2. **No feature should be surfaced more than 3 times without engagement before going quiet** — enforced by maxSurfacesBeforeQuiet
3. **Feature enable rate should be > 30% for features surfaced via contextual suggestion** — measured via discovery funnel
4. **Zero users report feeling "pestered" by feature suggestions** — qualitative, monitored via feedback API
5. **`/capabilities` returns 100% of features at all times** — pull path never gated

---

## Revision History

### Rev 2 (2026-03-21) — Post SpecReview

Addressed 6 P0 blockers, 10 P1 items, and 4 reviewer conflicts from 8-reviewer SpecReview.

**P0 blockers resolved:**
- B1: Evaluator input sanitized — no raw user messages, topic categories only, output validated server-side
- B2: All `/features/*` endpoints now require Bearer auth
- B3: `POST /features/:id/state` → `POST /features/:id/transition` with server-enforced state machine
- B4: Multi-user state keyed as `(userId, featureId)` in SQLite from day one
- B5: `declined → aware` transition uses deterministic criteria, not LLM judgment
- B6: Behavioral rules classified as server-enforced or agent-behavioral; server enforces where possible

**Other changes:**
- Split `FeatureRegistration` into `FeatureDefinition` (static) + `FeatureState` (dynamic)
- Renamed `autonomous` consent tier to `self-governing` (avoids collision with autonomy profile)
- Added `deferred` discovery state ("remind me later")
- SQLite for state, JSONL for audit trail (not JSONL-only)
- Activation prompt template revised to remove dark pattern structure
- Evaluator rate-limited, cached, fail-open with 5s timeout
- Added error response schema, right-to-erasure endpoint, consent records
- Structured `DataImplication` and `EnableAction` types (not free-form strings)
- `Duration` fields replaced with explicit millisecond numbers
- Analytics schema defined in Phase 2 (not deferred to Phase 5)
- Added disabled-feature digest and negative discovery to Phase 5 scope
- Resolved 2 of 4 open questions; added 3 new ones from reviewer gaps
