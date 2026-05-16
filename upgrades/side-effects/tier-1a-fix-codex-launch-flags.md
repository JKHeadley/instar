# Side-effects review — Tier 1.A fix Codex launch flag shape

**Version / slug:** `tier-1a-fix-codex-launch-flags`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (flag-shape correction caught by inspecting `codex --help` output; bundled with the v1.0.0 launch dispatch from earlier this hour)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Tier 1.A (commit 218739be) introduced a Codex interactive launch builder that emitted `--sandbox danger-full-access` plus `--resume <id>`. Inspecting the real `codex --help` output revealed two issues:

1. **Sandbox mode**: `danger-full-access` is valid but removes the sandbox entirely, which is more permissive than the Claude equivalent (`--dangerously-skip-permissions` means "no approval prompts," NOT "no sandbox"). The agentic-but-safe equivalent is `--sandbox workspace-write` (writes restricted to the project) plus `--ask-for-approval never`. Switched the default to this shape.

2. **Resume**: Codex's `--resume` is a SUBCOMMAND (`codex resume <id>`), not a flag. Passing it as a flat flag would have made codex exit with an error. The current TopicResumeMap is shaped around flag-style resume; rather than wire up the subcommand variant now (which needs TopicResumeMap generalization), the builder skips `--resume` for Codex and emits a console warning, so the session starts fresh. Resume for Codex topics lands in a follow-up.

Files touched:
- `src/core/frameworkSessionLaunch.ts` — Codex builder updated.
- `tests/unit/frameworkSessionLaunch.test.ts` — 2 affected tests updated.

## Decision-point inventory

- **`workspace-write` vs `danger-full-access`** — `add` (workspace-write). Matches Claude's sandbox semantics: agent acts autonomously but writes are bounded to the project. Codex's `danger-full-access` removes the sandbox, which is a privilege escalation Claude users never opted into.
- **Skip `--resume` for Codex** — `defer`. Implementing the subcommand form (`codex resume <id>`) requires the launch path to know whether to spawn `codex SUBCOMMAND ARGS` instead of `codex ARGS`. The current Tier 1.A builder shape returns a flat argv; supporting subcommands needs a small refactor I don't want to land in this fix. Warning emitted so Justin sees it when he tests.

## Signal vs authority

Pure flag-shape correction. No signal/authority surface affected.

## Over-block / under-block analysis

**Over-block:** Codex sessions can no longer break out of the workspace, which is a tighter default than before. Operators wanting `danger-full-access` can still set it explicitly via `codexSandboxMode`. This is the right direction for safety.

**Under-block:** None — `--ask-for-approval never` preserves the autonomous-action contract Justin needs.

## Level-of-abstraction fit

Stays inside `frameworkSessionLaunch.ts`. No new abstractions.

## Interactions

- All Codex topic-spawn sites get the safer flag shape.
- No public interface change.

## External surfaces

None.

## Rollback cost

Trivial.

## Tests / verification

- `npx tsc --noEmit` clean.
- 12 launch-builder tests still pass after updating the two affected expectations (`--sandbox` default + `--resume` not-supported).
- Verified against real `codex --help` output that `workspace-write` and `--ask-for-approval never` are valid flags.
