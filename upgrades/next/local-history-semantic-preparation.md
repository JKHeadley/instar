# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- tracked: topic-143810 -->

## What Changed

Connected internal selected-file staging to the real isolated conversation parser. Preparation now checks existing owner-specific source records, reserves temporary output before writing, seals normalized artifacts and waits for real child exit before cancellation cleanup. No production endpoint or app action is enabled.

## What to Tell Your User

No new import action is available yet. The server can prepare selected local files in its internal component checks; the app flow and separate copy confirmation are still being connected.

## Summary of New Capabilities

None exposed. A prepared file does not grant permission to copy a conversation.

## Evidence

Focused checks use both source formats, actual parser children and the actual owner-specific source store. They cover source mode/project conflicts, cancellation and revocation during streaming, disk refusal before output write, retained cleanup charges and raw-file retirement. Full signed HTTP, production startup and installed-app acceptance remain unproven. See `upgrades/side-effects/local-history-semantic-preparation.md`.
