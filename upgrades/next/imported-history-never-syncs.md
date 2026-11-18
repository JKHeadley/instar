# Imported history excluded from git sync

<!-- bump: patch -->

## What Changed

Imported Claude/ChatGPT history (the `.instar/imported-history/` folder written by the history importer) is now excluded from git sync and from git on every agent. Git sync's file classifier lists the folder as never-sync. The agent-home `.gitignore` and the internal state repo's `.instar/.gitignore` templates list it for new agents. An idempotent update step adds the same line to the `.gitignore` files existing agents already have. One shared constant (`src/core/importedHistoryPaths.ts`) names the folder for the store and for every one of these lists, so they cannot drift apart.

## What to Tell Your User

- **Imported chats stay on this computer**: "Chats you bring over from Claude or ChatGPT stay on this computer. They are never included when I back up or sync my files through git."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Imported history excluded from git sync and git | Automatic |

## Evidence

`tests/unit/imported-history-never-syncs.test.ts` (6 tests) runs the real store, classifier, both templates and the update step. It checks that the shared path is the store's real folder, that files under it (relative and absolute paths) classify as never-sync, that a similarly named file nearby does not, that both new-agent templates carry the line, and that the update adds it once and creates no file. Related suites passed with it: file-classifier, machine-identity, identity-autoaccept-storage-manifest, PostUpdateMigrator-a35-remediationPaths (188 tests).
