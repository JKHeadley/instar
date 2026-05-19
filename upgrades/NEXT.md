# Upgrade Guide — v1.0.11

<!-- bump: patch -->

## What Changed

Adds the Migration Parity backfill that the recently-shipped primitive PRs (#252 Skill, #253 Hook, #254 Memory) deferred. On every `instar update`, the PostUpdateMigrator now iterates every registered Layer-3 parity rule and re-renders every canonical instance into the framework-native shape for every enabled framework. Existing deployed agents pick up the canonical sources automatically on update instead of having to wait for a sentinel scan that is not yet wired to boot.

The backfill is idempotent (skips on second run via the `_instar_migrations` marker) and respects each rule's individual remediation policy. Hook renderings always overwrite per Migration Parity §4. Skill and memory renderings respect refuse-on-conflict per §5 — user-edited renderings are captured as skips with an operator-action note rather than silently clobbered.

The migrate() public surface gains a new `migrateAsync()` companion that wraps the sync `migrate()` plus the async parity-renderings backfill. Sync callers continue to work; async callers (which is all three production call sites in cli.ts, UpdateChecker.ts, and server.ts) now use `migrateAsync()` to ensure all backfill work is complete before the function returns.

## Evidence

Reproduction prior to this release: install Instar v1.0.10 on a fresh agent, then add a canonical hook at `.instar/hooks/canonical/session-start/test.sh`. Run `instar update`. The hook is never rendered into `.claude/hooks/session-start/test.sh` until a sentinel scan fires, and the sentinel is not wired to boot. The canonical-to-framework promise is theoretical, not observed.

Observed after this release: same setup, `instar update` runs `migrateAsync()` which iterates the registry, calls `hookParityRule.remediate()` for the new hook, and `.claude/hooks/session-start/test.sh` exists with the canonical body plus the `x-instar-stamp` audit comment. Subsequent `instar update` calls are no-ops via the `_instar_migrations` marker. New canonical sources added between updates pick up on the next update run, since `verify()` returns ok for unchanged renderings and remediate is the canonical no-op path.

Unit-test verification: tests/unit/PostUpdateMigrator-parityRenderings.test.ts asserts the registry iteration covers every rule, every instance, every enabled framework. Tests cover the happy path, framework filtering, refuse-on-conflict skip handling, error capture, idempotency via the marker, the empty-canonical-source new-agent path, continue-past-rule-failure, missing-config skip, and the migrateAsync wrapping contract.

## What to Tell Your User

- "When you next update, your agent will refresh every framework-rendered version of its canonical skills, hooks, and memory entries to match what Instar ships. This is a one-shot catch-up for the primitive sources that landed in the last few releases — after that, the parity sentinel keeps things in sync on a cadence."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Parity renderings backfill on update | Automatic. Runs as part of `instar update` via the new `PostUpdateMigrator.migrateAsync()` path. Iterates the parity rule registry and remediates every canonical instance. |
| `migrateAsync()` companion to `migrate()` | Async callers in the cli.ts, UpdateChecker.ts, and server.ts paths now await the full migration including the parity backfill. Sync callers continue to use `migrate()` and pick up the parity work via natural marker-based dedupe on the next async call. |
| Per-rule policy preserved | Hook renderings always-overwrite per §4. Skill and memory renderings refuse-on-conflict per §5 — user-edited files are surfaced as skips with operator-action notes. |

## Deferred (Tracked Follow-ups)

- Agent and Tool parity rules are not yet implemented (the v0.1 registry has only skill, hook, memory). When those land, the backfill covers them automatically via the registry-iteration pattern.
- Testing Integrity Tier-3 (E2E lifecycle) tests for primitive specs and conversational-action v0.2 on-demand wiring remain as the next tasks in this autonomous session.
