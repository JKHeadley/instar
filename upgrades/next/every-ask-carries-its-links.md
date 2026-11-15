<!-- bump: patch -->
## What Changed

Every agent's CLAUDE.md now carries the owner's rule **"Every ask carries its links."** Any message that needs the operator to review, approve or decide ends with a short *What I need from you* section. That section has one line per ask in plain words, a working link to each item, and the exact reply that settles it. An authority grant links to its Approve/Decline page instead.

- **Template.** `generateClaudeMd()` emits the line just before the "Sending the operator to a page" paragraph.
- **Migration.** `migrateClaudeMd` inserts it once for existing agents, using a content sniff. If an agent already has a hand-written variant, it is replaced with the canonical text. The line is also on the framework-agnostic marker list, so Codex and Gemini agents get it too.
- **Standard.** There is a new named clause, "Every ask carries its links", under *Agent Proposes, Operator Approves* in `docs/STANDARDS-REGISTRY.md`, ratified by the owner (Telegram topic 141868, 2026-11-11).

Two more pieces are tracked as their own work: the send helper that checks links, together with the daily retrospective review (initiative `ask-links-helper-and-review`), and the escalation ladder for repeat violations (initiative `owner-expectation-ladder`).

## What to Tell Your User

When I need you to review, approve or decide something, my message now ends with a short "What I need from you" list. It has one line for each item, a link to it, and the exact reply that settles it.

## Summary of New Capabilities

- The "Every ask carries its links" rule in every agent's standing instructions, including existing agents.

## Evidence

- Unit: `tests/unit/PostUpdateMigrator-askLinks.test.ts` (9 tests).
