# Side-Effects Review — WS5.2 Step 9: Migration parity + CLAUDE.md awareness (live credential re-pointing)

**Version / slug:** `ws52-step9-migration-docs`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** not required (no gate/sentinel/session-lifecycle/messaging-block surface — docs + migration only)

## Summary of the change

Closes the Migration Parity + Agent Awareness gap for live credential re-pointing (spec §4). Two src files touched, both doc/migration content with NO runtime behavior: `src/scaffold/templates.ts` (`generateClaudeMd` — adds a "Live Credential Re-pointing" awareness section for new agents) and `src/core/PostUpdateMigrator.ts` (`migrateClaudeMd` — the same section, content-sniffed + idempotent, for existing agents). Plus `tests/unit/PostUpdateMigrator-credentialRepointing.test.ts` proving the CLAUDE.md migration AND the config-defaults parity (the dark `subscriptionPool.credentialRepointing` block already rides the generic `ConfigDefaults`→`getMigrationDefaults`→`applyDefaults` add-missing path; the test proves it installs on a config lacking it and never clobbers an operator's explicit `enabled:true`).

## Decision-point inventory

- No decision point added, modified, or removed. The change is agent-awareness documentation + a content-sniffed CLAUDE.md migration + a migration-parity test. The only conditional is the existing `if (!content.includes(marker))` idempotency guard, which is a presence check, not a behavioral gate.

---

## 1. Over-block
No block/allow surface — over-block not applicable.

## 2. Under-block
No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit
Correct layer. The Agent Awareness Standard requires the CLAUDE.md template to document any new capability, and the Migration Parity Standard requires existing agents to receive it via `migrateClaudeMd` — this change does exactly both, at the documented layer. The config-defaults half is deliberately NOT a new dedicated `migrateConfig` block (which would duplicate logic): it rides the canonical `ConfigDefaults` registry + the generic `applyDefaults` add-missing merge, which is the standard's prescribed single-source mechanism. The test asserts that path works rather than re-implementing it.

## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface.

It is documentation + a presence-guarded text append + a test. No brittle logic holds any authority. (Ref: docs/signal-vs-authority.md.)

## 5. Interactions
- **Shadowing:** none. The new `migrateClaudeMd` block is appended after the existing section blocks, guarded by a distinctive content-sniff marker (`Live Credential Re-pointing (move a pool account`) that no other section contains — it cannot shadow or be shadowed by another block, and re-running is a no-op (idempotency test).
- **Config migration interaction:** the parity test relies on the generic `applyDefaults` add-missing recursion already exercised by every other ConfigDefaults entry; it adds the missing `subscriptionPool.credentialRepointing` block without touching an operator's existing values (verified both directions: installs when absent; preserves explicit `enabled:true`/`dryRun:false`, fills only the missing sibling).
- **Double-fire / race:** none — migration runs once per update, single-threaded.

## 6. External surfaces
- Changes the CLAUDE.md that ships to / is migrated into agents (agent-facing awareness text). No runtime behavior, no API surface change (the `/credentials/*` routes already existed from Step 7; this only documents them). The documented levers all remain DARK (503) until `subscriptionPool.credentialRepointing.enabled` is flipped — so the awareness text describes a capability that is off, and says so explicitly. No timing/conversation-state dependency.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** CLAUDE.md is a per-agent-install file; the migration runs per-machine on update, and the awareness text is identical fleet-wide (no per-machine state). The documented feature's own state (the credential ledger) is machine-local by the feature's design (each machine's keychain is its own), already covered in Steps 1-8's posture. Nothing here replicates or proxies; no URL is generated; no durable state strands on topic transfer. Correct posture — there is no cross-machine surface to get wrong.

## 8. Rollback cost
Trivial. Revert the commit: the appended CLAUDE.md section is inert text and the migration's content-sniff guard means a reverted template simply stops appending the section to not-yet-migrated agents (already-migrated agents keep the harmless, accurate-but-dark text). No data migration, no state repair, no credential touch. The config defaults are unaffected by a revert (they live in ConfigDefaults from Steps 1/7).
