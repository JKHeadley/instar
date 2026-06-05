<!-- bump: patch -->

## What Changed

Documented the internal-only release-note lane in the bundled instar-dev skill and added a PostUpdateMigrator backfill so existing agents with stock deployed copies receive the same guidance after update.

The new skill section explains the `<!-- internal-only -->` fragment marker, the ability to omit the two user-facing release-note sections, the assembler's all-internal-only auto-fill rule, and the pre-push gate that rejects the marker when runtime `src/*.ts` files changed.

## What to Tell Your User

Nothing changes in normal product behavior. This update improves the development workflow so agents know when the internal-only release-note lane is valid and existing agents receive that guidance automatically.

## Summary of New Capabilities

Existing agents with stock instar-dev skill installs now learn the internal-only release-note lane through the post-update migration path instead of waiting for a fresh install.

## Evidence

- Added a focused PostUpdateMigrator unit test covering update, idempotency, customized-skill preservation, and missing-skill no-op behavior.
- Ran the existing build-location migration test and the new internal-only-lane migration test together: 8 tests passed.
