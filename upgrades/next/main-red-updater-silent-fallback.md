# Updater path probe marked as a deliberate fallback

<!-- bump: patch -->

## What Changed

The updater's lookup for npm's CLI script next to the runtime node (added in #3603) tries several candidate paths and moves on when one is missing. That catch block now carries the `@silent-fallback-ok` marker with its reason, which brings the no-silent-fallbacks check back under its limit. Comment-only; the updater behaves exactly as before.

## What to Tell Your User

- **Nothing to notice**: "A small housekeeping fix in how updates find npm. Nothing changes in how updates work."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| None (internal housekeeping) | Automatic |
