# Side-Effects Review - Apprenticeship manual cycle write path

**Version / slug:** `apprenticeship-manual-cycle-write-path`
**Date:** 2026-06-03
**Author:** codey

## Summary of the change

Current `JKHeadley/main` already had `POST /apprenticeship/cycles`, so this change does not add a second route. It finishes the manual/overseer write path around that existing route:

- `src/server/routes.ts` now validates that manual cycle POST bodies are objects and that `channel`, when present, is one of the four store-supported values.
- `src/server/CapabilityIndex.ts` now surfaces the apprenticeship cycle endpoints in `/capabilities`.
- `src/scaffold/templates.ts` adds a CLAUDE.md awareness blurb for manual cycle recording.
- `src/core/PostUpdateMigrator.ts` mirrors that blurb for existing agents that do not yet have the Apprenticeship Program section.
- `src/data/builtin-manifest.json` is regenerated after the route/source changes.
- `upgrades/next/apprenticeship-manual-cycle-write-path.md` records the release-note fragment required by the publish gate.
- Route and capability tests cover strict channel validation, channel persistence, manual overseer cycle capture, and discovery.

## Side effects and blast radius

The only behavior change on the write path is stricter HTTP validation. A malformed manual request with an unknown channel now receives HTTP 400 instead of being written as `unknown`. The lower-level `ApprenticeshipCycleStore.record()` behavior is unchanged, so legacy rows and automated/non-HTTP callers still normalize invalid or missing channels to `unknown`.

The route remains persistence-only. It does not mutate apprenticeship instance status, does not run lifecycle gates, and does not decide whether a cycle was good. It only writes the row to the cycle store, and existing role-coverage logic interprets those rows afterward.

Capability discovery changes only metadata returned by `/capabilities`; no new auth surface or prefix classification is introduced. `/apprenticeship` was already a public capability prefix, so no `INTERNAL_PREFIXES` entry is needed or appropriate.

The template and migrator changes alter generated/updated CLAUDE.md guidance text. They do not execute operational work. Existing installs that already have an Apprenticeship Program section are still protected by the current idempotency marker and will not be double-patched by this migration.

## Risks considered

- **Breaking automated mentor ticks:** low. The automated call site writes through the store, not the HTTP route, and does not provide a channel today. Store defaulting remains unchanged.
- **Rejecting useful manual records because of a typo:** intentional. Manual/overseer HTTP writes should fail loudly when the channel is not one of the program-defined channels.
- **Capability configured status drift:** low. The capability now reports configured when either the instance program or cycle store is wired, matching the fact that cycle routes can be alive independently of the instance object in tests and boot wiring.
- **Template guidance becoming stale:** medium over time. This is mitigated by listing the same enum values exported by the store today and keeping the text concise.

## Test evidence

Focused verification:

- `npx vitest run tests/integration/apprenticeship-routes.test.ts tests/unit/CapabilityIndex.test.ts tests/e2e/apprenticeship-lifecycle.test.ts`
- Result: 3 files passed, 31 tests passed.

Planned final checks before push:

- `pnpm lint`
- `pnpm build`
- `node dist/cli.js dev:preflight`
- `pnpm test:smoke`

## Rollback cost

Rollback is a normal code revert. Reverting restores the previous permissive HTTP behavior, removes the capability endpoint entries, and removes the new generated/migrated awareness line. No database migration is introduced, and no existing cycle rows need transformation.
