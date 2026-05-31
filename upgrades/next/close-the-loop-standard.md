# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Instar's constitution gains a new standard: **Close the Loop (Untracked =
Abandoned)**. Every loop an agent opens — a promise to a user, a feature shipped
dark, an LLM gate deployed, a flagged issue — must be durably registered and
re-surfaced on a cadence until it reaches a deliberate close. Capturing it once
isn't enough; if nothing brings it back for review, it rots silently. It is the
lifecycle half of the existing **Deferral = Deletion** standard (which governs
the moment of capture), and it expresses the founding goal — *coherence* — across
the time axis, the way "Structure beats Willpower" expresses it across the
willpower axis.

This is a documentation + awareness change: the standard is declared in
`docs/STANDARDS-REGISTRY.md`, and the operating principle is added to every
agent's Core Principles (template for new agents, migration for existing ones).
**No runtime behavior changes.**

## What to Tell Your User

Nothing required — this is an internal engineering principle. If asked: the
agent now treats anything it starts and means to revisit as something that must
be tracked on a cadence until it's truly finished, rather than relying on
remembering to come back to it.

## Summary of New Capabilities

- New constitution standard: **Close the Loop (Untracked = Abandoned)** in
  `docs/STANDARDS-REGISTRY.md`.
- The principle is present in the agent CLAUDE.md template Core Principles and is
  migrated into existing agents' CLAUDE.md (idempotent, content-sniffed, no
  double-patch).

## Evidence

- Spec: `docs/specs/close-the-loop-standard.md` (+ `.eli16.md`), review-convergence
  + approved by Justin (Telegram topic 13435, 2026-05-31).
- Tests: `tests/unit/PostUpdateMigrator-closeTheLoop.test.ts` (+7), plus the
  `feature-delivery-completeness` registration; 69 pass, `tsc --noEmit` clean.
