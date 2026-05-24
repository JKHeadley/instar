# Side-Effects Review: builtin-manifest regeneration for v1.2.51

## Change
Regenerated `src/data/builtin-manifest.json` via `scripts/generate-builtin-manifest.cjs`. Tonight's codex-parity commits (secret-drop awareness, commitments awareness, shadow-capability parity guard) modified `src/core/PostUpdateMigrator.ts` and `src/scaffold/templates.ts` but did not regenerate the manifest, leaving `instarVersion` stamped at 1.2.46 and the PostUpdateMigrator-sourced hook `contentHash` values stale.

## Scope of effect
- The manifest is a generated index consumed by built-in-hook freshness comparison (which shipped hook content corresponds to which version). Regenerating makes the recorded `contentHash` values match the actually-shipped hook content.
- `instarVersion` moves 1.2.46 → 1.2.51 (provenance stamp only).
- `generatedAt` timestamp refreshes (changes every build; the freshness test and CI normalize it).

## Over/under-block, abstraction, signal-vs-authority
N/A — this is a generated reference artifact, not control logic. It carries no runtime authority and gates nothing; nothing reads it to allow/deny an action. No signal-vs-authority boundary is touched, and there is no over/under-block surface.

## Interactions
- Motivating interaction: `tests/unit/builtin-manifest.test.ts` "is up-to-date with current source" asserts a regenerate-and-compare (normalizing `generatedAt`). With the stale hashes it would FAIL CI; regeneration fixes it.
- No runtime behavior change. PostUpdateMigrator hashes the live source hooks at runtime; the manifest is metadata, not an execution input.

## Rollback
Trivial and isolated — re-run `npm run build` (regenerates) or revert this single-file commit. No data migration, no external side effect, no fleet-facing behavior delta.

## Publish
Ships as part of the codex-live-test deploy (the codex-parity fix batch). No separate publish action.
