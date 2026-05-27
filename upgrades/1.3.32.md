# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Closes a fleet-wide "dark guardrail" migration gap. `instar init` wires a full set of PreToolUse `Bash` guardrail hooks for new agents, but the existing-agent update path (`PostUpdateMigrator.migrateSettings`) only ever switched on two of them. So four guardrails — `deferral-detector.js` (the false-blocker / anti-deferral pre-filter), `grounding-before-messaging.sh`, `external-communication-guard.js`, and `post-action-reflection.js` — were copied to disk on every existing agent but never wired into `.claude/settings.json`, leaving them installed-but-inert. Same failure class as the 2026-05-27 silent-stall incident.

This release introduces a single source of truth for the canonical instar PreToolUse hook set (`src/core/instarSettingsHooks.ts`), consumed by BOTH the new-agent path (`init.ts`) and the existing-agent path, so the two can never drift again. `migrateSettings` now idempotently ensures every canonical Bash guardrail is present (appends only the missing ones; never reorders or removes; leaves custom hooks alone).

## What to Tell Your User

- Four guardrail hooks that were quietly switched off on existing agents — including the "false blocker" catcher that stops the agent handing a doable task back to you — come on at this update. New agents already had them; no action needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Existing agents get the full instar PreToolUse guardrail set on update | Automatic on update; no action needed |
| Anti-drift: new-agent + existing-agent hook lists share one constant | Adding a hook to `INSTAR_BASH_PRETOOLUSE_HOOKS` wires both paths; a unit test locks the set |

## Evidence

- New module + tests: `src/core/instarSettingsHooks.ts`, `tests/unit/instar-settings-hooks.test.ts` (16), `tests/unit/PostUpdateMigrator-pretooluse-parity.test.ts` (3, real migrateSettings).
- Spec: `docs/specs/EXISTING-AGENT-PRETOOLUSE-HOOK-PARITY-SPEC.md` (approved)
- ELI16: `docs/specs/EXISTING-AGENT-PRETOOLUSE-HOOK-PARITY-SPEC.eli16.md`
- Side-effects review: `upgrades/side-effects/existing-agent-pretooluse-hook-parity.md`
- Context: Task 3 of the 2026-05-27 silent-stalls postmortem.
