# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- tracked: topic-143810 -->

## What Changed

Added internal temporary upload ownership for selected local conversation files: disk reservations, stable request identity, exact chunk retries, bounded digest verification, live owner checks and recovery that waits for real process custody. Existing file-route protections cover the private directory. No production route or app action constructs this component.

## What to Tell Your User

No new action is available from this checkpoint. Bringing local conversations into the Mac app remains in progress.

## Summary of New Capabilities

None exposed. Raw byte verification alone cannot create a preview or authorize copying conversations.

## Evidence

Focused synthetic-file, SQLite, custody-process and file-protection checks are documented in `docs/local-history/server-upload-staging.md`. Full frozen-revision verification, signed HTTP ingress and installed-app acceptance are not claimed. See `upgrades/side-effects/local-history-upload-staging.md`.
