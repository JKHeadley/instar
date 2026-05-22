---
title: "Context-death stop hook — B15 tone-gate rule"
slug: "context-death-stop-hook"
author: "echo"
review-convergence: "2026-05-22T21:40:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T21:40:00Z"
review-report: "docs/specs/reports/context-death-stop-hook-convergence.md"
eli16-overview: "specs/dev-infrastructure/context-death-stop-hook.eli16.md"
approved: true
---

# Context-death stop hook — B15 tone-gate rule

## Problem statement

The CLAUDE.md template documents a "Context-Death Self-Stop" anti-pattern
("Do not self-terminate mid-plan citing context preservation, context-
window concerns, or 'let's continue in a fresh session' when durable
artifacts for the plan exist on disk"). Multiple memory entries reinforce
it: `feedback_scope_hook_is_grounding_not_termination`,
`feedback_no_deferrals`, `feedback_finish_means_merge`,
`feedback_active_followthrough`, `feedback_no_pr_fragmentation`,
`feedback_drive_phases_to_completion_dont_checkpoint_per_commit`.

Despite this, the agent (echo) keeps slipping back into the pattern —
proposing handoffs to a "fresh session," recommending pauses citing
"remaining context," or framing scope-reassessments as
context-driven stops. Operator just flagged this directly: "your tendency
to come up with an excuse to stop due to it being better to pick up in a
new session... None of these reasons make any sense — context will get
handled as needed with the systems we've built in. Now that's different
from taking a pause to reassess strategy."

Pure documentation isn't sufficient. Per instar's foundational
principle ("Structure > Willpower — if a behavior matters, enforce it
structurally"), this needs a hook that catches the language at send-time.

## Proposed design

Add **B15_CONTEXT_DEATH_STOP** as a new rule in the existing
`MessagingToneGate` (`src/core/MessagingToneGate.ts`). The gate already
runs on every outbound user message (B1–B14 cover CLI, file paths, style,
health-alert internals, etc.). B15 is a natural sibling.

### Rule definition

The rule BLOCKS when an outbound candidate message contains language that
proposes pausing, stopping, or handing off the current work for reasons
that fall in the "context-death" class — context-window concerns,
fresh-session benefits, end-of-session timing — rather than a legitimate
stop reason.

**Literal pattern markers (the LLM must point at exact text):**
- "fresh session", "next session", "in a fresh"
- "pick this up later", "pick up in a fresh", "fresh start"
- "tail of this session", "tail end of this", "remaining context",
  "in remaining hours", "in the remaining time"
- "stop cleanly here", "natural break point", "hand off cleanly",
  "hand it off", "handoff point"
- "given the scope ... in remaining", "in this single session",
  "multi-session work" (when used to justify stopping THIS work),
  "in remaining context"
- "quality risk on completing in this session", "rather than risk
  shipping incomplete"

**Legitimate stop reasons that pass through (LLM must check these
DON'T apply):**
- Real design question only the operator can answer (the message is
  literally a question requesting an operator decision).
- Missing information only the operator can provide (credential the
  operator holds; external system the operator owns).
- Actual error / blocker (a tool/API/system genuinely cannot proceed).
- Actual completion (the user-requested scope has shipped/merged/been
  reported as done).

If the candidate proposes stopping AND none of the legitimate-stop
clauses apply AND the language matches a context-death pattern → BLOCK
with B15 and a suggestion to either delete the handoff framing and
continue, or supply an explicit legitimate-stop reason.

### Boundary: when B15 does NOT fire

- Completion-of-feature messages ("done — v1.2.31 is on npm") pass.
- Genuine "I'm blocked on your input" messages pass (those ARE legitimate
  stops).
- Messages that DISCUSS the stop pattern (like this spec itself, or
  user-facing memos explaining the rule) pass. The rule keys on
  proposing TO stop the current work, not discussion ABOUT stopping.
- Strategy-reassessment messages pass as long as they don't conclude
  with "let's pick this up later" / "fresh session." Reassessing
  scope is fine; using it as a euphemism for context-death stop is not.

### Why an LLM-gate rule (not a regex hook)

Regex on the patterns would over-block ("we should pick this up later
*after_lunch*") and under-block (paraphrases like "I'd recommend we
break here and come back"). The existing tone gate is already an
LLM-driven authority that combines literal pattern matching with
conversational context — exactly the right shape for this judgment.

### Implementation surface

`src/core/MessagingToneGate.ts`:

1. Add `'B15_CONTEXT_DEATH_STOP'` to the `VALID_RULES` Set.
2. Add a new rule section in `buildPrompt`, sibling to the existing rule
   sections (BLOCK / SIGNAL-DRIVEN / HEALTH-ALERT / STYLE), describing
   the literal patterns + legitimate-stop exemptions.
3. Update the "Response format" note that lists allowed `rule` values to
   include `B15`.

Tests (`tests/unit/messaging-tone-gate-b15.test.ts`):

- Mock IntelligenceProvider. Assert that:
  - A candidate with "fresh session" framing + active in-flight work →
    BLOCK with B15.
  - A candidate with "next session" framing → BLOCK with B15.
  - A completion message ("v1.2.31 shipped to npm") → PASS.
  - A genuine-blocker message ("waiting on your call on A/B/C") → PASS.
  - A message that DISCUSSES the stop pattern (like the spec text
    itself, or an operator-facing memo explaining B15) → PASS.

### Migration parity

No agent-installed file change. The tone gate is a server-side
component evaluated at outbound-message time. Existing agents pick up
B15 the next time they update to this version and the server restarts —
no migration entry needed.

### Agent-awareness update

Add a one-paragraph note in the CLAUDE.md template's tone-gate /
outbound-message section that B15 is active, so the agent reads it
each session-start.

## Decision points touched

- New BLOCK decision on outbound messages: context-death stop language
  → block + suggest revision.
- Adds one rule id to the gate's enumerated set; preserves the
  fail-open behavior on every other path.

## Open questions

None. Scope is a single rule addition to an existing well-defined
authority. Justifies single-pass internal review + light external pass
per the verification round of the parent spec-converge skill.
