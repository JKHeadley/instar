# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**Your agent can now see what all its hands are doing across topics at once.** A new
cross-topic Activity Index reads your existing per-topic intent and presents one view:
every topic, its current focus, high-specificity tags, and whether a session is live on
it. This is the antidote to self-blindness — starting work in one topic that another topic
already finished (the exact thing that happened in the resource-tracking workstream, where
one topic re-specced CPU work another had already shipped).

Crucially, this does NOT add a new store. The design review found that the per-topic focus
data already exists (the Topic-Intent layer, updated structurally on every turn), so this is
a thin read-aggregator over it — no duplication, no new write path to remember.

This is Phase A (the read surface). The proactive overlap councilor — a sentinel that
notices "two of your topics are working on the same thing" and tells you — is Phase B and
ships separately (and dark, because a false-positive nudge is worse than silence).

## What to Tell Your User

Your agent is now less likely to duplicate work across different conversations. It can list
what each of its topics is working on in one place, so before it starts something big it can
notice another topic already has it covered. Nothing to configure; it reads data the agent
already keeps.

## Summary of New Capabilities

- `GET /parallel-work/activities` — read-only cross-topic index: per topic, its current focus,
  high-specificity tags, freshness, and whether a session is live on it.
- A specificity-aware tag extractor that ignores generic boilerplate (so two topics that both
  say "fix the test" don't look like the same work) and keeps genuine shared entities.

## Evidence

- Converged spec (2-reviewer adversarial + integration pass that RESHAPED the design — from a
  new store to a thin index over the existing Topic-Intent layer, with a distinct
  /parallel-work prefix to avoid the existing Coherence-Gate naming collision):
  docs/specs/parallel-activity-coherence.md.
- All three test tiers green: 7 unit (extractTags specificity boundary incl. cpu vs
  cpu-sampling; focus derivation goal>decision>purpose; empty-dir ⇒ []), 2 integration
  (200/503), 3 e2e (feature-alive on the real AgentServer init path + Bearer-auth + read-only).
  tsc clean.
