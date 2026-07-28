# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Seventh increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **dispatch (guidance-out) logic** — the channel that sends learnings/guidance back to agents — out of the reference Next.js handler (`the-portal/pages/api/instar/dispatches/index.ts`) into framework-agnostic TypeScript at `src/feedback-factory/dispatch/dispatch.ts`.

Includes the dispatch type/priority vocabulary + validators, the semver comparison used for version-compat filtering (an agent only receives a dispatch whose version window includes its version), and the title normalization used to dedup on create. Pure functions; **not wired into any route yet** — no behavioral change.

## What to Tell Your User

- The "send guidance back to agents" side of the feedback loop is now ported too — including the version-targeting logic that makes sure a piece of guidance only reaches the agent versions it applies to.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Dispatch logic (TS port) | Internal module `src/feedback-factory/dispatch/dispatch.ts` — not yet wired |

## Evidence

- Reference is TypeScript, so equivalence is by faithful transcription plus exhaustive both-sides-of-boundary tests (9 unit tests): semver comparison at equal/greater/lesser across all three components; the version-compat filter with min-only, max-only, both-bounds, and unbounded dispatches (boundaries inclusive); unparseable version → treated as 0.0.0; title trim + 500-char cap. The comparison loop, inclusive-equal semantics, and the filter predicate are copied verbatim from the reference.
