# Side-Effects Review: Codex parity — Stop scope-coherence + hook-contract canary (P6)

## Change
Two changes to the Codex enforcement layer, both within the approved spec (`docs/specs/codex-enforcement-hook-layer.md`):

1. **`installCodexHooks.ts`** — added `scope-coherence-checkpoint.js` to the Codex `Stop` event, alongside the existing `response-review.js` + `deferral-detector.js`. Completes the spec §4.1 mapping ("deferral / scope checkpoint → Stop"), which previously wired only deferral.
2. **`codexHookContractCanary.ts`** (new) — the P6 hook-contract drift canary. Two layers: (A) a deterministic, env-independent invariant lock asserting `buildInstarCodexHookGroups` still emits the load-bearing shape (`.*` matcher, `dangerous-command-guard` on PreToolUse, the full Stop review trio); (B) a best-effort probe of a resolvable codex binary's embedded hook-event schema, asserting the events instar depends on are still declared.

## Why
- **Scope-coherence on Stop**: the spec intends it; without it, Codex agents drift deep into implementation without the structural zoom-out that Claude agents get. The script is framework-neutral (reads stdin, POSTs to the local server) and Codex honors `{decision:'block', reason}` on Stop (verified in the 0.133 binary's `StopCommandOutputWire`). Same grounding-pause semantics as Claude — not a hard termination.
- **Canary**: P5c paid for two silent-no-op bugs live (a `*` matcher that matched nothing; the `cmd` vs `command` field). Layer A is the regression lock against that exact class — a refactor that regresses any invariant fails CI. Layer B catches real Codex-side drift (renamed/dropped hook events) when a binary is present.

## Scope / blast radius
- `scope-coherence-checkpoint.js` already ships to all agents via always-overwrite migration (`PostUpdateMigrator` line ~1698) and `installCodexHooks` is called from `migrateHooks` gated on codex-cli (line ~1655) — so existing Codex agents pick up the new Stop wiring on update (migration parity satisfied, no new migration needed). `validateHookReferences` guards against a dangling reference.
- The canary is invoked only from its unit test (the established pattern for the existing Codex canaries — CI drift lock), so it adds zero runtime cost on the hot path.

## Signal vs Authority
- Unchanged. scope-coherence is a low-context Stop-trigger that routes to the server; it never holds blocking authority of its own beyond the existing grounding-pause. The canary is pure verification — no authority, no runtime gating.

## Over-block / autonomy risk
- scope-coherence defaults to `approve` and self-throttles (depth threshold + 30-min cooldown), so it cannot loop an autonomous Codex run. The deferral-detector already runs on Codex Stop the same way (proven-compatible precedent).

## Honesty note — PostCompact NOT shipped
- A WIP that wired `compaction-recovery.sh` to Codex's `PostCompact` event was set aside this session after verifying (against the 0.133 binary schema) that `PostCompact` exposes only `continue/stopReason/suppressOutput/systemMessage` — no `additionalContext`, the only field that re-injects context. Only `SessionStart`/`UserPromptSubmit` carry it, and Codex's `SessionStart` triggers are `startup/resume/clear` (no `compact`). So that wiring would have installed a hook that cannot re-inject identity — dead on arrival. Compaction-recovery parity on Codex needs a different mechanism; tracked, not shipped.

## Rollback
- Revert the one-line `Stop` array edit + delete the canary module + test. No data migration, no config change.

## Tests
- `installCodexHooks.test.ts`: +1 test asserting the full Stop review trio (response-review + deferral + scope-coherence). 8 green.
- `codexHookContractCanary.test.ts`: 6 tests — layer-A invariants always asserted; layer-B skip-not-fail when no binary; binary-probed branch asserts all required events. Green.

## Publish
- Feature branch `echo/codex-parity-audit`. Targets a patch release on merge.
