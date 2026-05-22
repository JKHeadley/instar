# ORG-INTENT Session-Start Injection — ELI16

> Plain-English companion to `ORG-INTENT-SESSION-START-INJECTION-SPEC.md`. Read this first.

## What's the problem

We just shipped a change (Phase 1) that lets `ORG-INTENT.md` actually block outbound agent messages that violate the organization's constraints. That works — the gate that reviews every message now reads the file and refuses messages that contradict the constraints.

But there's still a gap: the agent doesn't *know* about the constraints when it's writing the message. It just gets blocked after the fact. So the agent might draft something thoughtful, hit "send," and only then learn that what it wrote violated a constraint. The block is correct, but the agent burned tokens drafting a doomed response.

We can do better. If the agent has the organizational intent in its working context from the start of every session, it can write the right thing the first time. The gate becomes a safety net for the edge cases, not the primary teacher.

## What this change does

We added one new HTTP route and one line in the session-start hook.

1. The route `GET /intent/org/session-context` returns the parsed contents of `ORG-INTENT.md` formatted as a clean text block: constraints first, then goals, then values, then the tradeoff hierarchy. Empty sections are dropped. If the file doesn't exist or is just a template placeholder, the route returns `{ present: false }` and the hook injects nothing.

2. The session-start hook (the script that runs every time a new agent session starts) now fetches that route and prints the block right alongside identity, topic context, and integrated-being. So when the agent reads its first message of the session, it has already seen the organizational contract.

Together with Phase 1, you now have a two-layer system: the agent *knows* the constraints as it drafts (Phase 2), and the gate *enforces* them at delivery time (Phase 1).

## What's deferred

Two more phases coming after this one:

- **Phase 3 — Tradeoff helper**: when two values pull in opposite directions, any part of the code (not just the message reviewer) can ask the hierarchy for the answer.
- **Phase 4 — Drift detection job**: a periodic background check that samples the agent's recent outbound actions and flags accumulated drift even when no single message violates anything.

## What you'll notice

- If you have an `ORG-INTENT.md` authored: every new agent session will print a clean `=== ORGANIZATIONAL INTENT ===` block at the top of its context, showing the four sections. The agent will reference these constraints, goals, values, and tradeoff hierarchy as it works.
- If you don't have an `ORG-INTENT.md`: no change. Zero-cost upgrade.
- The existing offline tools (`instar intent org-init`, `instar intent validate`) work the same way.
- The migrator updates your CLAUDE.md so the agent learns about the new session-start surface — both surfaces (Phase 1 + Phase 2) are now described in one subsection.

## How to roll back

The change is non-destructive. The route can stay; the session-start hook just fetches it. To revert: remove the ORG-INTENT block from the session-start hook (it's a single curl + python3 stanza in `PostUpdateMigrator.getSessionStartHook()`). The gate (Phase 1) keeps working regardless.

## Tests

Three tiers, all passing:

- Unit tests pin the formatter shape (bullet indentation, section order, empty-bucket omission, tradeoff numbering).
- Integration tests prove the HTTP route returns the right body for absent / template-only / populated / partial-bucket ORG-INTENT.md cases.
- E2E tests prove the wiring through `AgentServer` and `createRoutes` — the route returns 200, not 503, in the production boot path.

## Where to look next

- Spec: `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.md`
- Side-effects review: `upgrades/side-effects/org-intent-session-start-injection.md`
- Phase 1 (gate): `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.md` (already shipped as v1.2.23)
- Original intent engineering spec: `docs/specs/INTENT-ENGINEERING-SPEC.md`
