# Side-effects review — Parity renderings backfill

Per L6 (Side-effects review gate). Seven dimensions.

## 1. Over-block / under-block

**Before this change.** UNDER-blocked: canonical sources from PRs #252-#254 existed but were never rendered into framework-native shape for existing agents on update. The promise of canonical-to-framework parity was theoretical, observable only via manual sentinel scan or first-time installation.

**After this change.** Over-block risk: the backfill aggressively renders every canonical instance on update. For hook canonical sources (alwaysOverwrite per §4), user edits to rendered files get clobbered. This is the explicit §4 policy — built-in hooks always overwrite. Operators recovering edits go through git history.

For skill and memory rules (refuse-on-conflict per §5), the backfill captures user-edit-conflicts as skips with operator-action notes. No surprise clobbers; operator decides whether to resolve manually or via `/spec-converge`.

Net trade: correct. The §4/§5 distinction is preserved; backfill only completes the deferred §5 rendering rather than re-deciding policy.

## 2. Level-of-abstraction fit

The backfill lives in PostUpdateMigrator as a sibling step to `migrateProviderPortability` and `migrateParitySentinelTrust` (PR #261). Same pattern, same idempotency guards, same result structure.

The `migrateAsync()` wrapper is the right abstraction for async migrations going forward — the existing `migrate()` keeps its sync contract for the 18 existing steps; new async work goes through `migrateAsync()`. Future async migrations (e.g., conversational-action v0.2 catalog renders) plug into the same wrapper.

NOT done at wrong level: not per-primitive hardcoded migration entries; not changing the parity rule policies; not eagerly importing the parity registry at PostUpdateMigrator module load (lazy-imported only when `migrateParityRenderings` runs).

## 3. Signal vs Authority compliance

Textbook signal-vs-authority alignment. The brittle low-context detectors (rule.verify outputs, rule.listInstances results) are the signal. The higher-context authority is each rule's own remediate() policy:

- `hookParityRule.alwaysOverwrite=true` → authority says "ignore user-edit signal, overwrite anyway"
- `skillParityRule` / `memoryParityRule` (refuse-on-conflict) → authority says "respect user-edit signal, refuse and let operator decide"

The migrator orchestrates the iteration but doesn't override per-rule policies. Each rule's own design encodes the §4/§5 distinction.

## 4. Interactions with adjacent systems

**PR #261 (sentinel mirror-trust wiring).** Coexists. The backfill bypasses the sentinel's trust gate because it runs from PostUpdateMigrator (operator-initiated via `instar update`), not from the sentinel scan path. That's intentional: updates are explicit operator intent; cadence-based remediation continues to go through trust.

**`installBuiltinSkills()` (§5)** — `installBuiltinSkills()` is non-destructive (only writes missing SKILL.md files); the parity-renderings backfill is the dedicated migration that updates already-installed skill content. The two complement each other: install for new skills, backfill for existing-skill updates.

**`migrateHooks()`** — handles `.instar/hooks/instar/` (the Instar-managed hook scripts at the lifeline layer). The new parity backfill handles `.claude/hooks/` and `.agent/openai/hooks/` (the framework-native shape rendered from `.instar/hooks/canonical/`). Different directories, different responsibilities. No conflict.

**Existing async-callers.** All three production callers (cli.ts, UpdateChecker.ts, server.ts) are in async contexts and updated to `await migrateAsync()`. No behavioral change beyond awaiting the new backfill.

**Existing PostUpdateMigrator tests.** All 753 file tests + 16229 individual tests pass under the new structure. The sync `migrate()` method is unchanged in signature and behavior. Tests that call `migrator.migrate()` directly continue to work; they just don't trigger the parity backfill (the marker pattern ensures the backfill still runs on the next async call).

## 5. Rollback cost

Low. Three files: PostUpdateMigrator.ts (additive method + new public surface), and one-line `migrate()` → `migrateAsync()` swap in three call sites. Revert is `git revert`. The marker in deployed agents' `_instar_migrations` would remain (orphan but harmless — sniffed by the next migration's "already migrated" check). A subsequent migration could clean it up if desired; not required.

The renderings themselves persist after revert — the backfill produced correct framework-native files from canonical sources, and reverting the migration code doesn't remove those files. Operators get the catch-up rendering even if the migration is later disabled.

## 6. Backwards compatibility / drift surface

Backwards-compatible:
- `migrate()` keeps its sync signature.
- Callers in sync contexts can continue calling `migrate()` (just won't get the parity backfill until the next async call picks it up via the marker).
- Existing parity rules don't change.
- Existing migration marker conventions preserved (no schema change to `_instar_migrations`).

**Drift surface.** If a future parity rule sets `alwaysOverwrite=true` but doesn't handle a user-edit-conflict gracefully (throws instead of overwriting), the backfill would log an error and continue. Currently no such rule exists. Documented as the contract: alwaysOverwrite rules must internally handle conflicts via overwrite, not throw.

If the registry import path changes (`../providers/parity/registry.js`), the migration's lazy import would break. Today the registry path is stable; future restructuring would need to update the migrator's import path. Worth noting in any future parity-registry refactor.

## 7. Authorization / Trust posture

No new authority claims. The backfill writes to `.claude/skills/`, `.claude/hooks/`, `.agent/openai/skills/`, `.agent/openai/hooks/`, and `.instar/memory/` rendered locations — all of which were already authorized write targets for the parity rules. The migrator just calls into the existing rule.remediate() paths.

Trust-floor implications: the backfill bypasses the sentinel's mirror-trust gate (which lives in `FrameworkParitySentinel.shouldRemediate`). This is intentional — `instar update` is operator-initiated, not background cadence. Operators who want trust-gated parity rendering on update can downgrade specific rules to a different policy or pause auto-update entirely.

## Outcome

Ship.

The seven-dimension walk surfaced no blockers. The backfill makes the canonical-to-framework parity promise observable for deployed agents instead of theoretical. Per-rule policy is preserved; idempotency is solid; error categorization is operator-friendly. The migrateAsync() wrapper is the right abstraction for future async migration work and avoids breaking existing sync callers.
