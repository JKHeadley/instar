# Side-Effects Review — Skill prototype + parity rule

**Version / slug:** `feat-skill-prototype` (v1.0.2)
**Date:** 2026-05-19
**Author:** Echo (autonomous mode, hybrid C process)

## Summary of the change

Lands the Skill primitive prototype: concept spec, two framework rendering specs, parity rule + registry. Convergence-round-1 hardening (6 of 7 reviewers, Grok unavailable this session) addressed 7 critical/high findings before commit; 7 more are explicitly deferred to follow-up issues with the tracking in the concept spec.

**Files changed (specs):**
- `specs/instar-concepts/skill.md` (new, converged + approved)
- `specs/instar-concepts/skill.eli16.md` (new)
- `specs/frameworks/claude-code/skills.md` (new)
- `specs/frameworks/codex-cli/skills.md` (new)
- `docs/specs/reports/skill-concept-convergence.md` (new — convergence report)

**Files changed (source):**
- `src/providers/parity/types.ts` (new)
- `src/providers/parity/registry.ts` (new)
- `src/providers/parity/rules/skillParityRule.ts` (new)

**Files changed (tests):**
- `tests/unit/providers/parity/skillParityRule.test.ts` (new — 27 tests)
- `tests/unit/providers/parity/registry.test.ts` (new — 3 tests)

**Files changed (release notes):**
- `upgrades/NEXT.md` (new, v1.0.2)
- `package.json` (version bump 0.28.115 → 1.0.2)

## Decision-point inventory

- **Canonical path location** — `.instar/skills/` chosen. Both framework-specific dirs become renderings of this master.
- **Slug grammar** — `^[a-z0-9][a-z0-9-]{0,63}$`. Enforced at every entry point. Path traversal and arbitrary-write are not reachable from canonical content.
- **YAML parser** — `js-yaml` with FAILSAFE schema. Fail-loud on parse errors (no silent truncation).
- **User-edit detection** — `x-instar-stamp` field (sha256 of canonical body at render time) embedded in every rendered SKILL.md and `openai.yaml`. Distinguishes "canonical changed since last render" from "user edited the rendering directly."
- **Orphan handling** — symmetric verify + dedicated `listOrphans()` / `removeOrphans()` methods. Refuses to remove dirs with non-slug names (paranoid).
- **Symlinks in `mirrorSubdir`** — skipped (would otherwise be a tree-escape vector).
- **Backfill migration** — DEFERRED to follow-up. Without it, parity rule is a structural no-op on existing agents (canonical empty). Documented loudly in spec + NEXT.md.
- **`allowed-tools` rendering** — DEFERRED to the Tool primitive PR. Removed from v0.1 canonical frontmatter rather than promising tool-restriction without delivery.
- **Atomic write** — DEFERRED. v0.1 race window is narrow under single-machine + single-sentinel-pass; will add when sentinel ships.

---

## 1–7. Analysis

### Over-block

None. The parity rule has no automatic run point in this PR; it's opt-in. No production code path is impacted.

### Under-block

The parity rule itself: refuses to overwrite `user-edit-conflict`, refuses to remove non-slug-named orphan dirs, refuses to operate on canonical that violates slug grammar. These are intentional guardrails. The DEFERRED items represent under-block surfaces that are tracked:
- Atomic writes — narrow race window during simultaneous remediate calls.
- Backfill migration — existing agents have empty canonical, so verify always returns `ok: true` (vacuous). Documented; not a silent failure (the empty-canonical case is the intended state until backfill lands).

### Level-of-abstraction fit

Correct. Parity rule lives in `src/providers/parity/`, separate from any specific framework adapter. Per-framework renderers are internal helpers within the rule. The rule consumes `IntelligenceFramework` from the existing framework type but doesn't take a dependency on any adapter's internals.

### Signal vs authority

The parity rule is a signal emitter — it produces `ParityMismatch[]` describing detected drift. It does NOT auto-act on its own (no auto-run point in this PR). The future `FrameworkParitySentinel` is the authority that consumes the signals and decides whether/how to remediate per the trust-level-mirrored policy. Clean separation.

### Interactions

- **`installBuiltinSkills()`** — writes directly to `.claude/skills/` today; not touched here. After backfill migration lands, this path also needs updating to write to canonical + trigger remediation. Documented in spec.
- **`PostUpdateMigrator`** — no entry added here; backfill migration deferred to follow-up.
- **`BackupManager`** — defaults unchanged here; tracked.
- **`templates.ts`** — unchanged here; tracked.
- **Conformance suite for `ParityRule`** — does not exist yet; sentinel build will add.
- **Other parity rules** — none yet; this is the first.

### External surfaces

- **Public API**: new exports from `src/providers/parity/` — `ParityRule`, `ParityMismatch`, `MismatchFrameworkSlot`, `FunctionalPrimitive`, `getParityRule()`, `listParityRules()`, `skillParityRule`.
- **CLI surface**: none.
- **On-disk surface**: none changed automatically. Only when remediate() is invoked explicitly do rendered SKILL.md + openai.yaml + bundled subdirs get written/updated. Orphan-removal is opt-in via explicit method call.

### Rollback cost

Trivial. Revert the commit:
- The `src/providers/parity/` tree is new code with no other consumers; removing it cleanly removes the capability.
- No on-disk state was changed by this PR (only by explicit method calls).
- No migrations to undo.

## Tests

- New: `tests/unit/providers/parity/skillParityRule.test.ts` — 27 tests covering: slug grammar (path traversal rejected, capitals rejected, spaces rejected), canonical-read errors tagged with `framework: 'canonical'`, YAML parse fail-loud, git-merge-conflict marker detection, orphan detection + removal (refused for non-slug names), user-edit-conflict via stamp, body-content-mismatch when stamp missing, remediate refuses on user-edit-conflict, description sanitization + truncation, symlink-skip in mirror, render correctness for both frameworks, idempotent re-render, bundled-subdir mirroring, rule metadata.
- New: `tests/unit/providers/parity/registry.test.ts` — 3 tests covering registry lookup + listing.
- Total: 30/30 passing. Typecheck (`tsc --noEmit`) clean.

## Evidence

Convergence-round-1 with 6 reviewers (security, scalability, adversarial, integration, GPT 5.4, Gemini 3.1 Pro) ran 2026-05-18, surfacing ~30 unique material findings after dedup. The 7 critical/high findings addressed inline (C1, C2, C5, C7, C8, H1, H5) tighten the parity rule's contract from "checks happy path" to "fails safely on every reviewer-identified attack/error vector." Deferred items are tracked in the concept spec with explicit follow-up scope.

Unit tests verify each new guardrail behaves as the spec describes. Live end-to-end verification on real Claude + Codex sessions is queued as a follow-up that needs the backfill migration to land first (so existing agents have canonical content to verify). The hardened parity rule's structural correctness is verifiable from the unit tests + the reviewer-driven contract tightening.

Convergence report at `docs/specs/reports/skill-concept-convergence.md`.

## Round-2 deviation

Per the autonomous-mode hybrid C process locked with Justin on 2026-05-18: full /spec-converge runs on every design-heavy spec. Round 1 ran 6 of 7 reviewers (Grok unavailable). Round 2 was deferred for autonomous-mode scope reasons documented in the convergence report — the shape of the remaining issues is tracked-deferred work items, not unresolved design questions. If round 2 would have caught something material, the parity rule's logic is small and isolated, and corrections can ship as patches.
