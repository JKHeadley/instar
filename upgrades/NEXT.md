# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new capability (ORG-INTENT runtime gate). Aggregates docs(openclaw-t22) from PR #313 too. -->

## What Changed

**feat(org-intent-runtime): wire `ORG-INTENT.md` into the Coherence Gate so organizational intent actually shapes outbound message review.**

The `ORG-INTENT.md` format, parser, CLI surface (`instar intent org-init`, `validate`, `reflect`), and HTTP routes (`GET /intent/org`, `/intent/validate`) shipped in v0.9.11. What did not ship was the runtime integration — the Coherence Gate that reviews every outbound message only knew about `ORG-INTENT.md` through a deterministic markdown extraction that produced a flat ~150-token blob. The structured three-rule contract (constraints mandatory, goals defaults, values shape, tradeoff hierarchy resolves ties) was invisible to the reviewer. An agent with a fully-authored `ORG-INTENT.md` on disk behaved identically to one without it.

Phase 1 of the org-intent runtime project closes that gap on the message-review surface:

1. **Structured parser wired into the gate.** `loadValueDocs()` now invokes `OrgIntentManager.parse()` and stores the structured `{ name, constraints[], goals[], values[], tradeoffHierarchy[] }` shape alongside the legacy flat blob. Both are surfaced to reviewers; the structured form takes priority.
2. **Three-rule contract enforced explicitly in the value-alignment reviewer prompt.** The prompt now says constraint violations MUST block; goal contradictions warn or block by severity; value drift warns; the tradeoff hierarchy resolves ties (earlier entry wins). Constraints, goals, values, and tradeoff hierarchy appear in the prompt as separate labeled sections rather than a mashed-up blob.
3. **Criticality auto-promotion.** When `ORG-INTENT.md` contains constraints, the value-alignment reviewer is auto-promoted to `high` criticality. Timeouts on external channels now fail-closed for this reviewer instead of slipping through unreviewed.
4. **Migration parity.** Existing agents' CLAUDE.md gains an "ORG-INTENT.md (Organizational Intent at Runtime)" subsection in the Coherence Gate section so the agent learns the file is now load-bearing. The migration is idempotent — re-runs are no-ops.

Spec: `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.md`. ELI16 companion: `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.eli16.md`. Side-effects review: `upgrades/side-effects/org-intent-runtime-gate.md`.

This is Phase 1 of a four-phase project; the remaining phases (session-start injection, tradeoff helper, drift detection job) are deferred to subsequent releases.

---

**Also included: docs(openclaw-t22) — codex framework limitation documented.**

Spec note added to `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md` acknowledging that the pre-prompt memory recall feature (T2.2) only fires on Claude Code sessions. Codex CLI does not expose an equivalent per-prompt hook, so on codex-configured topics the recall pass does not run. This is a documented v1 scope choice surfaced by the 2026-05-21 OpenClaw v1.0 re-audit in topic 9003. The ELI16 companion was updated in plain language so operators understand the limitation before enabling the feature on a codex-configured topic.

## What to Tell Your User

If your agent already has an organizational intent file on disk (ORG-INTENT.md in the .instar directory), this release makes that file actually load-bearing for the first time. The agent's outbound message review now consults the structured constraints, goals, values, and tradeoff hierarchy — and will block messages that violate the constraints you wrote. Review the file before the upgrade lands, because constraints you wrote loosely now have real teeth.

If you have not authored an organizational intent file, behavior is unchanged. This is a zero-cost upgrade for those agents.

A second change in this release (the openclaw-t22 docs note): if you have a Telegram topic configured for the Codex CLI framework, the pre-prompt memory recall feature does not fire on that topic. This is a documented limitation, not a bug.

## Summary of New Capabilities

- **ORG-INTENT.md is now a runtime input to the Coherence Gate.** Three-rule contract enforcement: constraints block, goals warn/block, values warn, tradeoff hierarchy resolves ties.
- **Value-alignment reviewer prompt** is rewritten to surface the structured contract as separate labeled sections, explicitly enforcing constraint-vs-goal-vs-value semantics.
- **Migration parity**: existing agents pick up the change automatically via `PostUpdateMigrator.migrateClaudeMd()` — the CLAUDE.md Coherence Gate section gains a new subsection so the agent knows the file is load-bearing.
- **Three new test suites** added to enforce the wiring at all three tiers (unit, integration, E2E).

## Evidence

- Tier 1 unit tests: `tests/unit/CoherenceGate.test.ts` (5 new tests under the "ORG-INTENT.md structured loading" describe block, all passing). `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (5 new tests for migration parity, all passing).
- Tier 2 integration tests: `tests/integration/coherence-gate-org-intent.test.ts` (4 tests against the live `/review/evaluate` HTTP route, all passing).
- Tier 3 E2E lifecycle tests: `tests/e2e/org-intent-runtime-lifecycle.test.ts` (4 tests mirroring production wiring from `src/commands/server.ts`, all passing — including the "feature is alive" check that returns 200, not 503).
- Type-check: `npx tsc --noEmit` clean.
- The full test suite must remain green before merge per Zero-Failure Standard.
