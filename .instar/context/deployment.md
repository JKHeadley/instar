# Deployment Guide — Instar

## Pre-Deployment Checklist

1. Run coherence check: POST /coherence/check with action "deploy"
2. Verify you're in the correct project directory
3. Verify NEXT.md is complete: `node scripts/pre-push-gate.js`
4. Bump version: `npm version patch|minor|major`
5. Run tests: `npm run test:push`
6. Check CI status: GET /ci

## Post-Deployment Verification (MANDATORY)

After every push/deploy, you MUST:

1. **Confirm the version deployed** — Read `package.json` and state the version number explicitly
2. **Verify version increment** — Compare against the previous version and confirm the bump type (patch/minor/major) was appropriate for the changes
3. **Announce to the user** — Report back with:
   - The new version number (e.g., "Deployed v0.23.15")
   - What bump type was used (patch/minor/major)
   - The previous version it incremented from
   - Whether the version increment matches the scope of changes

Example announcement:
> Deployed v0.23.15 (patch bump from v0.23.14). Changes: bug fixes to session management.

If the version was NOT incremented, flag this as an issue before pushing.

## Deployment Target

- npm registry (public): `npm publish`
- Pre-publish hook validates upgrade guide and finalizes NEXT.md → {version}.md

## Rollback Procedure

1. `npm unpublish instar@VERSION` (within 72 hours)
2. Or publish a new patch with the fix
