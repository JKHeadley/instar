# Side-Effects Review — Secret Drop capability-awareness parity for Codex

**Change:** Make the Secret Drop capability reach Codex agents' session-start
briefing (AGENTS.md), and stale Claude agents' CLAUDE.md, so agents use the
secure one-time link instead of improvising a plaintext local file.

**Files:** `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`
(+ tests, NEXT.md). **Spec basis:** Agent Awareness Standard + Migration
Parity Standard (CLAUDE.md "Standards" section).

## What changed (3 parts)

1. **templates.ts** — `generateClaudeMd()` Secret Drop section: the existing
   "When to use" bullet is replaced with an explicit PROACTIVE trigger — the
   moment a user offers a credential, issue a one-time link; NEVER accept a
   chat-paste; NEVER create a local file for the user to edit. (New-agent path.)
2. **PostUpdateMigrator.migrateClaudeMd** — adds an ensure-section block: if
   `**Secret Drop**` is absent, insert the full section before the
   `**Cloudflare Tunnel**` marker (template document order), else before
   `**Scripts**`, else append. (Existing-Claude-agent path.)
3. **PostUpdateMigrator.migrateFrameworkShadowCapabilities** — adds
   `**Secret Drop**` to the `markers` allowlist (after Private Viewing), AND
   changes the per-marker slice boundary to stop at the next ##/### heading OR
   the next marker occurrence (whichever is first). (Codex/Gemini AGENTS.md path.)

## Over-block / under-block

- **migrateClaudeMd ensure-section:** fires ONLY when `**Secret Drop**` is
  entirely absent → cannot double-insert (idempotent; unit-tested re-run is a
  byte-for-byte no-op). Will not touch agents that already have the section.
- **Shadow slice-bound change:** strictly NARROWS each slice (adds an upper
  bound, never widens). Risk of under-grab (truncating a real section) only if
  a marker string appears verbatim inside another section's body. Audited the
  template: bold markers are section headers; `### Self-Discovery` /
  `### Coherence Gate` bodies do not contain other marker strings. Covered by
  the new "fresh shadow: every section appears exactly once" test.
- **Over-grab (the bug being fixed):** before, a bold section between two
  others would either be skipped (neighbor marker present) or drag its
  neighbors in. Now bounded — verified by the "already has neighbors, no dup"
  test (Cloudflare Tunnel / Private Viewing counts stay 1).

## Level-of-abstraction fit

Correct layers: template (new agents) + migrator (existing agents) — exactly
the two surfaces the Agent Awareness + Migration Parity standards name. No
runtime/gate logic touched. The capability itself (SecretDrop server, routes,
retrieve helper, dashboard tab) is unchanged and was already wired — this is
purely an awareness-delivery fix.

## Signal vs authority

N/A — no gate/sentinel/classification authority is added or changed. This only
edits instruction documents agents read.

## Interactions

- `migrateFrameworkShadowCapabilities` runs AFTER `migrateClaudeMd` (existing
  order, preserved) — so the ensure-section provides the source the shadow
  copies. Correct sequencing; verified live on codey (CLAUDE.md gained the
  section, AGENTS.md then mirrored it in one migration run).
- The pre-existing retrieve-line hardening block (`secrets/retrieve/TOKEN` →
  hardened helper) still runs and is unaffected: it patches an existing
  section; the new block ensures the section exists first. Both idempotent.
- `feature-delivery-completeness` test now tracks Secret Drop in
  `featureSections` (enforces template↔migrator parity) + `legacyMigratorSections`
  (bold-variant alternate for the auto-detector). Strengthens the guard.

## Rollback cost

Low and self-contained. Revert: the templates.ts "When to use" bullet, the
migrateClaudeMd ensure-section block, the `**Secret Drop**` marker entry, and
the slice-bound `for (other of markers)` loop (restore heading-only bound).
No schema/state/migration-data involved; the migration is idempotent so a
revert simply stops adding the section to not-yet-migrated agents (already-
migrated agents keep a correct, harmless section).

## Evidence (live, test-as-self over Telegram; codey on Codex)

- BEFORE (topic Test3): codey refused chat-paste but created
  `.instar/secrets/openai.env` and asked Justin to edit it; `/secrets/pending`
  stayed empty.
- Migration applied to codey → CLAUDE.md +section, AGENTS.md mirrored Secret
  Drop with the no-edit trigger, no neighbor duplication.
- AFTER (fresh topic Test2, session loads migrated AGENTS.md): codey reasoned
  "a one-time Secret Drop link... keeps the key out of chat and avoids writing
  it into files", ran `POST /secrets/request`, and sent Justin the one-time
  `/secrets/drop/...` link. No local file.
- Tests: 90 green (4 new + parity tracking + NEXT.md headers).
