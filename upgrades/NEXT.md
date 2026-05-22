# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new capability (ORG-INTENT session-start injection — Phase 2). -->

## What Changed

**feat(org-intent-runtime): inject `ORG-INTENT.md` at session-start so the agent reasons with organizational intent from message one (Phase 2 of 4).**

Phase 1 (shipped in v1.2.23) wired ORG-INTENT.md into the Coherence Gate so constraint violations are blocked at outbound-message review time. Phase 2 closes the other half of the loop: the agent now sees the structured three-rule contract in its working context at the start of every session, so it reasons with the constraints, goals, values, and tradeoff hierarchy as it drafts — instead of just being blocked after the fact.

Two delivery surfaces, both light:

1. **New HTTP route** — `GET /intent/org/session-context` returns the parsed three-rule contract formatted as a session-start text block. Returns `{ present: false }` when ORG-INTENT.md is absent, template-only, or unparseable.

2. **Session-start hook** — the canonical session-start hook (installed by `PostUpdateMigrator.getSessionStartHook()`) now fetches that route and injects the labeled block alongside identity, topic context, and other grounding sections. Fail-open: route unreachable / 503 / timeout → silent skip; the Coherence Gate (Phase 1) still enforces the contract at message-review time.

The new formatter is also exported (`formatOrgIntentForSessionStart()` from `src/core/OrgIntentManager.ts`) for any future callsite that wants the same labeled rendering.

Phase 3 (tradeoff helper) and Phase 4 (drift detection job) remain queued.

Spec: `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.md`. ELI16 companion: `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.eli16.md`. Side-effects review: `upgrades/side-effects/org-intent-session-start-injection.md`.

## What to Tell Your User

If your agent already has an organizational intent file (ORG-INTENT.md in the .instar directory), this release makes the agent see it at the start of every session — not just get blocked by it afterward. Practically: the agent now drafts responses with the organization's constraints, goals, values, and tradeoff hierarchy already in mind. Most constraint violations will never be drafted in the first place. The gate from the previous release remains the safety net for edge cases.

If you have not authored an ORG-INTENT.md, nothing changes. This is a zero-cost upgrade for those agents.

## Summary of New Capabilities

- **GET /intent/org/session-context** — new HTTP route returning a session-start-ready text block parsed from ORG-INTENT.md.
- **Session-start injection** — the canonical session-start hook now surfaces the three-rule contract alongside identity, topic context, soul, and working memory.
- **Exported `formatOrgIntentForSessionStart()`** — pure formatter usable by any new callsite that wants the same labeled rendering.
- **Migration parity** — existing agents' CLAUDE.md ORG-INTENT subsection is upgraded automatically to mention both surfaces (Phase 1 gate + Phase 2 session-start injection).

## Evidence

- Tier 1 unit tests: `tests/unit/OrgIntentManager-session-start-format.test.ts` (6 new tests, all passing). `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` extended with 2 new tests for Phase 2 migration (7 total tests, all passing).
- Tier 2 integration tests: `tests/integration/org-intent-routes.test.ts` extended with 4 new tests for the session-context route (11 total tests, all passing).
- Tier 3 E2E lifecycle tests: `tests/e2e/org-intent-session-context-lifecycle.test.ts` (3 tests mirroring production wiring through `AgentServer` and `createRoutes`, all passing — including the "feature is alive" 200-not-503 check).
- Type-check: `npx tsc --noEmit` clean.
- Lint: clean.
- The full test suite must remain green before merge per Zero-Failure Standard.
