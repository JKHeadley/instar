# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **The merge hot-spot in `PostUpdateMigrator` is gone.** The file imported 26 symbols from `../scaffold/templates.js` on one line, and every PR adding a CLAUDE.md awareness marker appends a symbol to it — so two concurrent PRs always conflicted on that exact line (hand-resolved five times on 2026-10-21 alone). The import is now one symbol per line, sorted, so two unrelated additions land on different lines and git merges them without help. Formatting only: `tsc --noEmit` confirms all 26 symbols still resolve, and import order carries no meaning here. A new ratchet (`tests/unit/PostUpdateMigrator-templates-import-shape.test.ts`) keeps the shape and also asserts every imported symbol is still used, so a future tidy-up cannot collapse it back or silently drop one. Honest scope: this reduces collisions sharply rather than abolishing them — two symbols that sort adjacently can still need a hand.

## What to Tell Your User

Nothing to do. If you maintain instar you should stop seeing conflicts on this one file when two unrelated changes are in flight.

## Summary of New Capabilities

- No new capability. One ratchet test.

## Evidence

- `tsc --noEmit` clean; `git diff --stat` shows `1 file changed, 33 insertions(+), 1 deletion(-)` (import-only).
- Ratchet verified both ways: collapsed to one line → `2 failed`; restored → `2 passed`.
- Checked before touching a known hot line: none of the six armed PRs (#2208, #2209, #2210, #2213, #2218, #2219) touch this file, so no in-flight work is disturbed.
