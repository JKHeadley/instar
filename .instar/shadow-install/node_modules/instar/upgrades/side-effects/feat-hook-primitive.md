# Side-Effects Review — Hook primitive + parity rule

**Version / slug:** `feat-hook-primitive`
**Date:** 2026-05-19
**Author:** Echo (autonomous mode, hybrid C)

## Summary of the change

Lands the Hook primitive prototype: concept spec, two framework rendering specs, parity rule registered in the existing registry. v0.1 covers the `session-start` event only; remaining events tracked as mechanical extensions of the EVENT_NAME_MAPPING table.

**Files changed (specs):**
- specs/instar-concepts/hook.md (new, converged + approved per pre-auth)
- specs/instar-concepts/hook.eli16.md (new)
- specs/frameworks/claude-code/hooks.md (new)
- specs/frameworks/codex-cli/hooks.md (new)
- docs/specs/reports/hook-concept-convergence.md (new)

**Files changed (source):**
- src/providers/parity/rules/hookParityRule.ts (new)
- src/providers/parity/registry.ts (hookParityRule registered)

**Files changed (tests):**
- tests/unit/providers/parity/hookParityRule.test.ts (new — 22 tests)
- tests/unit/providers/parity/registry.test.ts (updated for 2-rule registry)

**Files changed (release notes):**
- upgrades/NEXT.md (new)
- package.json (version bump)

## Decision-point inventory

- **Canonical path location**: `.instar/hooks/<event>/<name>.<ext>` — mirrors `.instar/skills/<name>/` pattern.
- **Event vocabulary**: canonical kebab-case (`session-start`, `pre-compact`, ...); per-framework mapping in code.
- **v0.1 event scope**: session-start only — proves the pattern; extension is mechanical.
- **Script extension allowlist**: .sh, .js, .mjs, .cjs, .ts.
- **Stamp format**: leading `# x-instar-stamp: <sha256>` comment line; sha256 of canonical body (with stamp stripped) is the stamp value.
- **settings.json merge semantics**: only manages entries whose script paths live under `.claude/hooks/<canonical-event>/`. Other user-added hook entries are preserved.
- **hooks.json merge semantics**: only manages entries whose script paths live under `.agent/openai/hooks/<canonical-event>/`. Other entries preserved.
- **Migration backfill**: DEFERRED (same shape as Skill backfill; one follow-up PR can cover both primitives).

---

## 1–7. Analysis

### Over-block
None. Parity rule is opt-in; no auto-run point.

### Under-block
Same as Skill v0.1: no atomic writes, no executable-bit explicit verification (set on render, presumed to persist), no backfill migration (existing agents' canonical empty). All tracked.

### Level-of-abstraction fit
Correct. hookParityRule lives alongside skillParityRule in `src/providers/parity/rules/`; shares the same `ParityRule` contract. Event-name mapping is a per-rule concern; types layer doesn't need changes.

### Signal vs authority
Same as Skill — rule emits signals (mismatches), sentinel (future) is the authority.

### Interactions
- **`refreshHooksAndSettings()`** — currently installs hooks via `installInstarHooks()`; not touched here. Future migration story covers the canonical-vs-direct-install reconciliation.
- **`migrateHooks()` in PostUpdateMigrator** — currently always-overwrites built-in hooks under `.claude/hooks/instar/`. This continues to work; the parity rule is opt-in and doesn't conflict.

### External surfaces
- Public API: new `hookParityRule` export from `src/providers/parity/`.
- Process surface: only when remediate() invoked explicitly — writes script + chmod + settings/config merge.

### Rollback cost
Trivial. Revert removes the rule + registry entry; no on-disk state changed by this PR alone.

## Tests
22 new tests in `hookParityRule.test.ts` covering slug grammar (path traversal, capitals, spaces rejected; only v0.1 events listed), canonical-read errors tagged with framework: 'canonical', remediate (claude script + settings.json entry, codex script + hooks.json entry, executable bit, settings preservation, idempotent), user-edit-conflict via stamp, orphan detection + removal, rule metadata. Plus 4 updated registry tests for 2-rule registry.

Total parity tests: 53/53 passing (27 Skill + 22 Hook + 4 registry). Typecheck clean.

## Evidence
Abbreviated convergence — see docs/specs/reports/hook-concept-convergence.md. Bug found during test development (stamp-strip regex was leaving trailing whitespace, causing post-render verify to flag user-edit-conflict on freshly-rendered files) — fixed by tightening STAMP_COMMENT_STRIP_RE to consume the trailing newline.
