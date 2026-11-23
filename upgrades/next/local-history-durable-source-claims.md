# Upgrade Guide — Durable Local Conversation Identity

<!-- bump: patch -->

## What Changed
Private local-session storage now requires a durable owner-scoped source claim under its actual writer lease before copying local rows. The claim survives interrupted append and records project, parser representation and contract version. Damaged or incompatible provenance refuses reuse. Private database files and sidecars receive the existing key-material and private-import protections.

## What to Tell Your User
The local-history import is still being built. Its storage component now checks that a retry belongs to the same person and source conversation, including after an interrupted write. This update alone does not make importing through the app available.

## Summary of New Capabilities
No new user action or API is enabled. This is supporting work for the selected-local-history contract tracked in topic 143810.

## Evidence
Thirty-seven source-claim, forty-six archive-store and ten SQLite wiring checks passed, including real child-process crashes, hot-journal recovery, actual lease loss, valid empty-storage recovery, owner separation and bounded rejection of a large damaged cell. HTTP fixtures check actual stored private references. Production lifecycle tests preserve existing archive/search behavior. Full normal verification is required before release.
