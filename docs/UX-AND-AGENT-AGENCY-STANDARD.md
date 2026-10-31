# UX & Agent Agency Standard

> Every feature must optimize for two things: the human's experience AND the agent's ability to serve.

## The Problem

Infrastructure-first thinking builds features that work mechanically but fail experientially. A setup wizard that requires five steps when context makes three sufficient. A registration gate that makes the agent say "I've notified the admin" when it already knows who the person is. A conflict that escalates to a human when the agent could propose a resolution.

These aren't bugs. They're design failures that treat the agent as dumb infrastructure instead of an intelligent participant, and treat the user as someone who should adapt to the system instead of the reverse.

## The Two Axes

Every Instar feature is evaluated on two axes:

### Axis 1: User Experience

The user's path through any feature should be:
- **Minimal** — ask only what can't be inferred from context
- **Progressive** — simple cases should be simple; complexity revealed only when needed
- **Recoverable** — every error state has a clear path forward, never a dead end
- **Complete** — every flow ends with what to DO next, not just a confirmation

### Axis 2: Agent Agency

The agent's role in any feature should be:
- **Contextual** — the agent uses what it already knows to reduce friction
- **Proactive** — the agent recommends actions based on patterns it observes
- **Transparent** — when the agent exercises judgment, it explains why
- **Graduated** — agency scales with trust level and configuration

## The Rules

### Rule 1: No Dead Ends

Every user-facing flow must terminate with an actionable next step. "You're all set" is not a terminal state — "You're all set. Try sending a message in your Telegram topic, or run `instar status` to see your agent's state." is.

**Test**: After completing a flow, can the user immediately do something meaningful without consulting docs?

### Rule 2: Defaults Must Match the Common Case

Default configuration should optimize for the most likely user, not the most cautious. Security defaults are exceptions — they should be restrictive. But workflow defaults (registration policy, notification preferences, sync behavior) should match what 80% of users want out of the box.

**Test**: Does a user with the most common setup (small team, 2-3 people, one admin) need to change any defaults to have a good experience?

### Rule 3: The Agent Gets a Voice

When the agent has relevant context, it MUST be able to contribute that context to decisions — even decisions it can't make autonomously. This means:

- **Join requests**: If the agent has prior conversation context about the person requesting access, that context accompanies the admin notification.
- **Conflict resolution**: The agent proposes a resolution with reasoning before escalating for confirmation.
- **Configuration recommendations**: The agent observes usage patterns and recommends changes.
- **Status awareness**: The agent notices degraded states (offline machines, stale jobs, inactive users) and surfaces them proactively.

**Test**: Is there any decision point where the agent has relevant context but is forced to stay silent?

### Rule 4: Graduated Agency

Agent autonomy is configurable along a spectrum, not binary. The configuration lives in `config.json`:

```typescript
agentAutonomy: {
  level: 'supervised' | 'collaborative' | 'autonomous',

  // What the agent can do at each level:
  // supervised:    Agent informs and waits. All actions require human approval.
  // collaborative: Agent recommends and acts on low-risk items. Human approves high-risk.
  // autonomous:    Agent acts and reports. Human intervenes only on exceptions.

  capabilities: {
    assessJoinRequests: boolean,       // Agent adds context to admin notifications
    proposeConflictResolution: boolean, // Agent suggests resolution before escalating
    recommendConfigChanges: boolean,   // Agent surfaces usage-based recommendations
    autoEnableVerifiedJobs: boolean,   // Agent enables jobs it ran on another machine
    proactiveStatusAlerts: boolean,    // Agent notices and reports degraded states
  }
}
```

Default: `'collaborative'` — the agent recommends and acts on safe items, escalates the rest.

**Level definitions:**

| Capability | Supervised | Collaborative | Autonomous |
|-----------|-----------|---------------|-----------|
| Join request assessment | Silent relay | Adds context to notification | Approves known contacts, escalates unknowns |
| Conflict resolution | Escalates immediately | Proposes resolution, waits for confirmation | Resolves non-config conflicts, escalates config |
| Config recommendations | Never surfaces | Suggests after observing patterns | Applies low-risk changes, reports afterward |
| Job enablement (cloned machine) | All disabled | Presents each with context, asks per-job | Enables previously-verified jobs automatically |
| Status monitoring | Reports only when asked | Proactive alerts on degraded state | Proactive alerts + automatic remediation attempts |

**Test**: Can an admin tune their agent's autonomy without code changes? Does each level feel coherent (not just "more permissions")?

### Rule 5: Context Before Consent

Before asking the user for a decision, the agent MUST surface all context it has that's relevant to that decision. This means:

- Before "approve or deny this user?", the agent says what it knows about them
- Before "resolve this conflict?", the agent shows both sides and its assessment
- Before "enable these jobs?", the agent describes what each job does and its history
- Before "choose a registration policy?", the agent explains the tradeoffs in the user's context

**Test**: Is the user ever asked to make a decision with less context than the agent has?

### Rule 6: Self-Recovery Paths

Every authentication, verification, or access-control flow must have a recovery path for the most common failure mode. "Contact your admin" is acceptable only when there IS a reachable admin. Single-user, single-machine scenarios must have self-recovery mechanisms.

Recovery mechanisms (in preference order):
1. **Alternative verification channel** — email, backup code, recovery key
2. **Time-delayed self-recovery** — "If no admin responds in 48h, a recovery key is generated"
3. **Documented manual recovery** — step-by-step instructions for the worst case

**Test**: Can a solo admin who lost their only machine regain access to their agent without external help?

### Rule 7: Identifiers Are Never Names

Every person-facing title, headline, row label, picker, and notification uses a
name tied to the underlying platform ID. A topic number, channel ID, machine
ID, agent fingerprint, or shortened hash is routing or diagnostic data, never
a substitute for a name. Capture and keep the ID/name pair at the source; on
another machine, resolve it from the authoritative holder. An unresolved name
is stated plainly and retried. It must not be silently replaced with an ID,
nor treated as a user action or a failed agent.

**Test**: With a missing name and with a stale copy on another machine, does
the user see a verified current name or an explicit missing-name state, with
the identifier confined to links and diagnostic details?

## Applying the Standard

### For New Features

Before implementation, every feature spec must include:

1. **UX walkthrough** — The user's path through every flow, including error states and what happens next at each endpoint
2. **Agency assessment** — Where the agent has context, what it does with that context, and how agency scales with configuration
3. **Dead-end audit** — Every terminal state has an actionable next step
4. **Recovery path audit** — Every auth/verification flow has a recovery mechanism for the most common failure
5. **Default audit** — Defaults match the common case, not the most cautious case
6. **Identity audit** — Every person-facing name is bound to its ID; missing names never fall back to IDs

### For Existing Features

Existing features should be evaluated against this standard during their next modification cycle. Priority order:
1. Features with known dead ends
2. Features where the agent has context but can't use it
3. Features where defaults don't match the common case

### For Review Teams

Add "UX & Agency" as a standard review dimension alongside Security, Privacy, Architecture, etc. The reviewer checks:
- Does every flow end with a clear next action?
- Does the agent contribute context wherever it has context?
- Are defaults appropriate for the common case?
- Is there a self-recovery path for common failure modes?
- Does agent agency scale with the configured autonomy level?

## Anti-Patterns

- **"I've notified the admin"** — without contributing what the agent already knows about the request
- **Silent disablement** — turning off jobs/hooks/features without explaining what they are and why
- **Binary agency** — the agent either does everything or nothing, with no middle ground
- **Configuration archaeology** — the user has to dig through config files to unlock a workflow that should be a setup wizard question
- **Dead-end confirmations** — "You're all set." [cursor blinks]
- **Context hoarding** — the agent has information relevant to the user's decision but doesn't surface it
- **Security theater defaults** — defaults so restrictive that every user immediately has to loosen them, teaching them to override security prompts

## Relationship to Other Standards

- **LLM-Supervised Execution**: Handles operational reliability (Tier 0/1/2 supervision). This standard handles experiential quality — the agent's intelligence should be felt by the user, not just by the monitoring system.
- **Intent Engineering**: Handles organizational purpose alignment. This standard handles the mechanics of how that purpose manifests in user interactions and agent behavior.

Together, the three standards form a triangle:
- **LLM-Supervised Execution** = the agent is RELIABLE
- **Intent Engineering** = the agent serves the RIGHT PURPOSE
- **UX & Agent Agency** = the agent FEELS intelligent and the user FEELS served

## Origin

This standard was developed during the Multi-User Setup Wizard spec review (2026-02-25). Four rounds of security/privacy/architecture review produced a technically sound spec that still had experiential gaps — the user hit dead ends, and the agent was treated as infrastructure rather than a participant. The insight: technical soundness and experiential quality are independent axes. You can have both. You must have both.
