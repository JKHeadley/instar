# Side-Effects Review: C3 — scope-coherence-checkpoint re-entry guard

## Change
`PostUpdateMigrator.getScopeCoherenceCheckpointHook()` — the Stop hook now parses its
stdin payload and, if `stop_hook_active` is true (a correction continuation), approves and
exits immediately. Convergence review §7 C3.

## Why
scope-coherence already self-throttles (depth threshold + 30-min cooldown + never-blocks-
headless) so it won't tight-loop, but it lacked the explicit `stop_hook_active` re-entry
guard that claim-intercept-response has. The adversarial reviewer flagged a block → continue →
still-deep → block loop that could wedge an autonomous Codex/Claude session if the cooldown
has an edge. This guard immediately approves a continuation — belt-and-suspenders against that.

## Scope / blast radius
- Affects scope-coherence on BOTH engines (it's the same hook) — correct, the loop risk is
  framework-neutral. Behavior change: on a correction continuation it approves instead of
  re-evaluating; that is the intended fix and matches claim-intercept-response's pattern.
- Migration parity: always-overwrite hook (migrateHooks rewrites it) → existing agents get it
  on update. New parse is defensive (try/catch around JSON.parse; missing field → normal path).

## Signal vs Authority / Over-block
- Reduces over-block (prevents a re-block loop); no new authority. Still routes to the same
  grounding-pause semantics on a genuine first block.

## Rollback
- Remove the re-entry guard block. No data/config impact.

## Tests
- `tests/unit/scope-coherence-reentry.test.ts`: 2 — approves on stop_hook_active=true;
  normal approve path below depth threshold. Green. tsc clean.

## Publish
- Feature branch `echo/codex-parity-audit`. Ships with the codex-full-parity bundle.
