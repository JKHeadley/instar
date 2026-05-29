# Side-Effects Review — Session Pool Track B: agent awareness (CLAUDE.md Tier-0 blurb)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §"Migration Parity & Agent Awareness" (approved)
**Track:** B (agent awareness). Completes Track B's user-facing + awareness surface.
**Files:** src/scaffold/templates.ts (generateClaudeMd), src/core/PostUpdateMigrator.ts (migrateClaudeMd)

## What changed
1. **`generateClaudeMd()` (templates.ts):** added a Tier-0 "Multi-Machine Session Pool" blurb to the capabilities section (right after Cross-Machine Seamlessness) — explains the active-active pool, the **Machines tab**, `GET /pool`, `PATCH /pool/machines/:id` (with curl), and the proactive triggers ("run this on / move this to <nickname>", "where is this running?"). New agents get it via `init`.
2. **`migrateClaudeMd()` (PostUpdateMigrator.ts):** content-sniff append (idempotent on the marker `Multi-Machine Session Pool (active-active` / `/pool/machines/`) so EXISTING agents get the same section on update — Migration Parity.

## Blast radius
- **Docs/awareness only** — no behavioral code path. `generateClaudeMd` produces the CLAUDE.md template for new agents; `migrateClaudeMd` appends to existing agents' CLAUDE.md (idempotent, content-sniffed — never duplicates). No runtime behavior changes.
- The blurb describes a DARK feature (sessionPool ships off) + points to real endpoints (`/pool`, `/pool/machines/:id`) that exist (Track B(2b)) and the Machines tab that exists (Track B(2c)). No dangling references: "deep mechanics" points at the Machines tab + the spec (the code-enforced Playbook deep-entry is a tracked enhancement, not asserted here).

## Risk + mitigation
- **Risk:** migration appends to existing CLAUDE.md repeatedly. **Mitigation:** idempotent content-sniff on the unique marker (skips if present) — verified by the existing migration-parity test (13 green).
- **Risk:** blurb claims a capability that isn't live. **Mitigation:** the blurb explicitly states "Ships DARK behind `multiMachine.sessionPool.stage`" + "a single-machine agent is a no-op" — honest about the dark state.

## Migration parity
- This IS the migration-parity work for the Agent Awareness Standard: `generateClaudeMd` (init) + `migrateClaudeMd` (existing agents) both add the section, sniff-guarded. migration-parity.test.ts green.

## Rollback
- Remove the blurb from `generateClaudeMd` + the `migrateClaudeMd` block. Docs-only; nothing depends on it.

## Tests
- tests/unit/migration-parity.test.ts (13) — enforces generateClaudeMd↔migrateClaudeMd consistency; green with the additions. tsc clean.

## Agent awareness
- This change IS the agent-awareness deliverable. The code-enforced Playbook deep-trigger (`multiMachine-placement-deep` + SelfKnowledgeTree probe — the spec's Structure>Willpower enhancement for on-demand deep mechanics) is tracked as a follow-up (decision D9). <!-- tracked: session-pool-track-b -->
