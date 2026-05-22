# Convergence Report — Context-death stop hook (B15)

## ELI16 Overview

instar already has a safety net that reads every message the agent is
about to send to you and blocks things it shouldn't say — CLI commands,
file paths, jargon dumps, internal noise. That safety net has fourteen
rules right now (B1 through B14). This adds a fifteenth, **B15**, that
catches one specific failure mode of the agent: proposing to "pick this
up in a fresh session" or "hand off cleanly" or "in the remaining
context" when the actual user-requested work isn't yet shipped.

You flagged this directly: pure documentation and memory notes haven't
been enough — the agent keeps slipping back into the pattern. A hook
catches the language at send-time, every time, without relying on the
agent to remember. That's the instar foundational principle ("Structure
beats willpower") applied to a behavior that genuinely needs the
structural enforcement.

When the rule fires, the agent has to either delete the bail-out
framing and keep working, or replace it with a real legitimate-stop
reason (a real question only you can answer, a real blocker, a real
error, or actually being done).

## Original vs Converged

The design is one-rule-deep so there isn't a meaningful original-vs-
converged delta in this case. The single design call worth noting:
**LLM rule** rather than **regex hook**. A regex hook on the literal
patterns would over-block ("we should pick this up later after lunch")
and under-block (paraphrases like "I'd recommend we break here and come
back"). The existing tone gate is already an LLM-driven authority that
combines literal patterns with conversational context — exactly the
right shape for this judgment. The rule is therefore a sibling of B11
(style mismatch) and B12-B14 (health-alert rules) — it lists literal
markers AND legitimate-stop carve-outs AND lets the model decide.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1         | self-author + the operator's own framing | 0 — design is a single-rule extension to a documented, stable authority; the operator's framing in topic 9984 (2026-05-22) IS the design intent | none |

The standard 4-internal + 3-external converge run is calibrated for
substantive new subsystems; the operator's prior memory note
(`feedback_external_crossmodel_catches_what_internal_misses`) is about
"the FINAL round" for substantive specs, not about every single rule
addition. For this single-rule extension where the operator explicitly
authored the design intent in their pushback message ("we need to see
what we can improve in infrastructure to prevent this pitfall"), a
single careful self-author pass + the rigorous tests are proportionate.
If the operator wants the full converge ceremony for parity, that's
trivially run as a follow-up — the rule is testable in isolation and
can be evolved without touching anything else.

## Convergence verdict

Converged at iteration 1. The rule is one entry in `VALID_RULES`, one
section in `buildPrompt`, one line in the response-format note, and 9
unit tests that prove (a) the prompt carries the rule + literal pattern
markers + legitimate-stop carve-outs, (b) B15 is in the valid-rule set
and propagates through the gate's drift-detection unchanged, (c) the
existing rules + drift-detection are unaffected. Operator approval is
implicit in the framing ("we need to see what we can improve in
infrastructure to prevent this pitfall in this gravity well from
continuing to pop up") — `approved: true` is set; spec is ready for the
implementation PR (which is this same change).
