---
title: Free-text guard hook resolves packaged template path
slug: free-text-guard-template-resolution
author: instar-codey
created: "2026-05-25"
status: approved
approved: true
approved-by: "Justin"
approved-at: "2026-05-25T20:55:48-07:00"
review-convergence: "2026-05-25T20:54:00-07:00"
eli16-overview: "FREE-TEXT-GUARD-TEMPLATE-RESOLUTION-SPEC.eli16.md"
---

# Free-text guard hook resolves packaged template path

## ELI16 Overview

Instar updates existing agents by running a post-update migrator. One thing that
migrator does is reinstall built-in hook scripts so older agents pick up the
latest guardrails.

The free-text guard hook is stored as a template file because its shell script
contains Python and regular expressions. Keeping it in a real script file avoids
a fragile mess of escaping inside TypeScript strings.

The bug is that the migrator looks for that template in the compiled output
folder. The build does not copy templates there. The published package does
include the template, but under the source-template folder that other Instar
template readers already know how to use.

So the hook is not actually missing. The migrator is looking in only one place,
and it is the wrong place for the packaged build.

The fix is to add one shared template-loading helper that checks the compiled
template location first and then the packaged source-template location. Then the
free-text guard and the existing similar template readers all use that same
helper. That keeps the behavior consistent and prevents the same single-path
mistake from coming back in a future hook.

The important safety rule is that we do not change what the free-text guard
does. We only change how the migrator finds its template file during an update.

## Problem

`PostUpdateMigrator.getFreeTextGuardHook()` reads the free-text guard hook from
only one location:

```ts
path.join(__dirname, '..', 'templates', 'hooks', 'free-text-guard.sh')
```

That path assumes a copied `dist/templates/hooks/free-text-guard.sh` tree next
to the compiled migrator. The current build does not create that tree. The npm
package does ship `src/templates/hooks/free-text-guard.sh`, but the free-text
guard getter never checks that packaged source-template location.

Observed repro on `v1.2.81`:

- `npm run build` creates `dist/core/PostUpdateMigrator.js`.
- `dist/templates/hooks/free-text-guard.sh` is absent.
- `src/templates/hooks/free-text-guard.sh` is present.
- `npm pack --dry-run --json` includes `src/templates/hooks/free-text-guard.sh`
  and no `dist/templates/...` entry.
- Calling `migrateHooks()` from the compiled migrator records:
  `free-text-guard.sh: ENOENT ... dist/templates/hooks/free-text-guard.sh`
  and does not install `.instar/hooks/instar/free-text-guard.sh`.

The bug is therefore a template resolution mismatch, not a missing template.

## Goal

Existing agents that run the post-update migrator from a published package must
receive the free-text guard hook without error.

## Non-Goals

- Do not inline the free-text guard shell body into TypeScript. It was kept as a
  template to avoid multi-layer TypeScript -> shell -> Python -> regex escaping
  fragility.
- Do not change the semantics of the free-text guard hook.
- Do not broaden migration behavior for custom hooks.

## Verified Findings

1. **Package contract:** `package.json#files` ships `src/templates` directly.
   `npm pack --dry-run --json` on `v1.2.81` includes
   `src/templates/hooks/free-text-guard.sh` and has no `dist/templates/...`
   entry for this hook.

2. **Build contract:** `npm run build` is
   `generate-builtin-manifest.cjs && tsc && chmod 0755 dist/cli.js &&
   sign-instar-lockfile.mjs`. There is no non-TypeScript asset copy step, so
   `dist/templates` is absent after a normal build.

3. **Runtime template-reader baseline:** the existing template readers in
   `PostUpdateMigrator` already use module-location anchored, multi-candidate
   resolution:
   - `migrateFleetWatchdog()` checks `dist/templates/scripts/...`, then
     `src/templates/scripts/...`.
   - `loadRelayTemplate()` checks `dist/templates/scripts/...`, then
     `src/templates/scripts/...`.
   - `getConvergenceCheck()` checks the same two layouts and has an inline
     fallback.

4. **Outlier:** `getFreeTextGuardHook()` is the runtime hook-template outlier:
   it does a single direct read from `dist/templates/hooks/free-text-guard.sh`
   and never checks the shipped `src/templates/hooks/free-text-guard.sh`.

5. **External confirmation:** Echo reviewed the same source on `JKHeadley/main`
   and confirmed the diagnosis, the package/build contract, and that
   free-text-guard is the lone hook-template holdout.

## Proposed Fix

Extract one shared private template resolver in `PostUpdateMigrator`, then route
existing template readers through it instead of adding another bespoke
candidate loop.

The helper should be module-location anchored, never current-working-directory
anchored:

```ts
loadTemplate(subdir: 'hooks' | 'scripts' | 'playbook', filename: string): string | null
```

Resolution order:

1. Check the built-output location:
   `dist/templates/<subdir>/<filename>`.
2. Check the packaged source-template location:
   `src/templates/<subdir>/<filename>`.
3. Return the first readable candidate.
4. Return `null` when no candidate exists. Callers that require the template
   may throw a clear missing-template error that lists the checked locations;
   existing fail-soft callers may keep their current skip/fallback behavior.

This chooses the existing dev/dist fallback pattern over changing the build to
copy all templates into `dist`. The package already ships `src/templates`; the
smallest reliable fix is to make this one hook getter honor the shipped layout.
Copying templates into `dist` would work, but it would create a second canonical
asset location and diverge from the existing package contract.

## Implementation Plan

- Add the shared `loadTemplate()` helper.
- Refactor `loadRelayTemplate()` into a thin wrapper over `loadTemplate()`.
- Refactor the fleet-watchdog template read to use `loadTemplate()`.
- Change `getFreeTextGuardHook()` to load `free-text-guard.sh` via
  `loadTemplate('hooks', 'free-text-guard.sh')` and throw a clear error if it
  returns `null`.
- Add a regression guard that detects hook getters which perform unguarded
  direct disk reads for template files.
- Add unit coverage for both supported layouts.
- Add integration coverage proving `migrateHooks()` installs the free-text
  guard hook from a compiled migrator when only `src/templates` exists.

## Tests

### Unit

Add focused unit tests around the template loader:

- resolves a hook template from the built-output layout;
- resolves the same hook template from the packaged source-template layout;
- resolves a script template through the same helper so the helper is not
  hook-only in practice;
- reports a clear missing-template error when neither location exists.
- is unaffected by `process.cwd()` by running the resolver from an unrelated
  current working directory.

### Regression Guard

Add a guard test over `src/core/PostUpdateMigrator.ts` that fails if a hook
getter reads a template via a single direct `fs.readFileSync(path.join(__dirname,
...))` path instead of a guarded multi-candidate resolver. The goal is not to
ban all file reads in the migrator; it is to prevent future hook templates from
repeating this exact single-layout mistake.

The guard should allow the shared `loadTemplate()` helper and should fail on any
new `get*Hook()` method that directly reads a template path from `__dirname`.

### Integration

Run `migrateHooks()` from the compiled migrator against a temporary project with
the current published package layout: compiled `dist`, no `dist/templates`, and
present `src/templates`. Assert:

- `.instar/hooks/instar/free-text-guard.sh` is written;
- the written hook matches the source template content;
- `result.errors` contains no free-text guard error.

### Published-Shape Package Test

Run `npm pack`, extract the tarball, and assert:

- `package/src/templates/hooks/free-text-guard.sh` exists;
- `package/dist/templates` is absent;
- importing `package/dist/core/PostUpdateMigrator.js` and running `migrateHooks()`
  from an unrelated current working directory still installs the free-text guard
  hook from the shipped `src/templates` path.

### Test-As-Self

After implementation and build, run the compiled migrator against a real
dist-shaped temporary agent install and confirm:

- the free-text guard hook lands on disk;
- the previous missing-template error is absent;
- `npm pack --dry-run --json` still includes the source template needed by the
  fallback.

## Acceptance Criteria

- Post-update migration from a published-shaped package installs the free-text
  guard hook with zero error.
- The shared template resolver is package/module-location anchored and works
  when `process.cwd()` is unrelated to the package.
- The fix is idempotent: repeated migrator runs overwrite the generated built-in
  hook exactly as existing hook migration expects.
- Regression coverage fails if a future hook getter uses an unguarded
  single-layout disk read.
- The implementation does not add a build-copy step for `src/templates` unless
  the package contract changes in a separate approved spec.
- Unit, integration, and test-as-self evidence are recorded before the PR is
  considered ready.
- Release notes are added to `upgrades/NEXT.md`.

## Signal vs Authority

This change has no new block/allow decision surface. It changes how a static
hook template is located during migration. The free-text guard's existing
behavior is unchanged.
