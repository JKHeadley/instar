# Side-Effects Review: builtin-manifest regeneration for the codex-instar audit batch

## Change
Regenerated `src/data/builtin-manifest.json` via `scripts/generate-builtin-manifest.cjs` after rebasing the codex-instar-audit batch onto current main (post-v1.2.52). The audit commits modified `src/core/PostUpdateMigrator.ts`, `src/config/ConfigDefaults.ts`, and `src/scaffold/templates.ts` (scheduler default backfill, anti-confabulation CLAUDE.md section, legacy maxSessions canonicalization), which change the PostUpdateMigrator-sourced content hashes recorded in the manifest.

## Scope of effect
- The manifest is a generated index consumed by built-in-component freshness comparison. Regenerating makes the recorded `contentHash` values match the actually-shipped source.
- `instarVersion` provenance stamp + `generatedAt` timestamp refresh (CI normalizes `generatedAt`).

## Over/under-block, abstraction, signal-vs-authority
N/A — generated reference artifact, not control logic. Carries no runtime authority and gates nothing. No signal-vs-authority boundary, no over/under-block surface.

## Interactions
- Motivating interaction: `tests/unit/builtin-manifest.test.ts` "is up-to-date with current source" regenerate-and-compare (normalizing `generatedAt`) would FAIL CI on the stale hashes; regeneration fixes it.
- No runtime behavior change. PostUpdateMigrator hashes live source at runtime; the manifest is metadata.

## Rollback
Trivial and isolated — re-run `npm run build` or revert this single-file commit. No data migration, no external side effect.

## Bundled lint-compliance fix (SafeFsExecutor)
Rebasing onto current main surfaced two direct-destructive-fs lint violations the overnight commits predated:
- `src/core/UpdateRestartHandshake.ts` `clearHandshake()` used `fs.unlinkSync` — migrated to `SafeFsExecutor.safeRmSync(this.filePath, { force: true, operation: 'UpdateRestartHandshake.clearHandshake' })`. `force:true` is rm-f semantics (no throw if the marker is already absent), so the prior `existsSync` guard is removed; the non-fatal try/catch is preserved. Behavior identical (clear the marker, never block on failure), now routed through the audited destructive-op funnel.
- `tests/integration/threadline-relay-send-priority.test.ts` cleanup used `fs.unlinkSync` for the token file — migrated to `SafeFsExecutor.safeRmSync` to match the existing `projectDir` cleanup in the same `afterAll`.

Both are required by `lint-no-direct-destructive.js` (CI gate) and the COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT spec. No new behavior; tsc clean, lint clean.

## Publish
Ships as part of the codex-instar audit batch deploy. No separate publish action.
