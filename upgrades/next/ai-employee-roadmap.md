# Upgrade Fragment — ai-employee-roadmap

<!-- bump: patch -->

## What Changed

Added `docs/AI-EMPLOYEE-ROADMAP.md` — the program-level roadmap that maps the
apprenticeship program onto instar's top-level goal: an agent that works as a
fully engaged AI employee. It defines the three capabilities that make up that
posture — multi-machine coherence (3–4 machines, one identity), first-class
chat-platform citizenship (Telegram today, Slack as the primary workplace
surface next), and multi-principal service (every staff member served by the
same agent with no identity bleed) — and lays each out as a stage ladder
(A1→A4, B1→B3, C1→C3) with an explicit, evidence-gated exit bar. The method is
prove-it-on-the-apprentice-first: every capability is developed and de-risked
on a prototype agent under observation, through the same user channels a human
would use, before any production agent inherits the configuration. Graduation
is serial and evidence-gated — recorded, artifact-backed acceptances, never a
vibe.

This is documentation only. No code, config, hook, job, template, or test
changes; no runtime surface; no behavior change for any deployed agent.

## Evidence

- `docs/AI-EMPLOYEE-ROADMAP.md` — the roadmap itself (deliberately
  organization-agnostic for this public repo).
- `docs/specs/ai-employee-roadmap.eli16.md` — plain-English explainer.
- `upgrades/side-effects/ai-employee-roadmap.md` — side-effects review; every
  question resolves to "documentation-only, no runtime surface";
  multi-machine posture unified-via-git; rollback = revert the doc.
- Sanity: the whole-tree stall-coverage CI ratchet
  (`tests/unit/stall-coverage-ratchet.test.ts`) runs green on this tree —
  the change coexists with the freshly-landed PR-A ratchet.

## What to Tell Your User

Nothing changes in how your agent behaves. The project now carries a public
roadmap document describing where the platform is headed — an agent that works
like a real employee: present on several machines as one coherent identity, a
well-mannered citizen of workplace chat (Slack next), and able to serve a whole
team without mixing people up — and how each step gets proven on a supervised
prototype before it ever reaches a production agent.

## Summary of New Capabilities

- None (documentation only). New artifact: `docs/AI-EMPLOYEE-ROADMAP.md`, the
  program-level map from the apprenticeship program to the full AI-employee
  posture, with evidence-gated graduation criteria per capability.
