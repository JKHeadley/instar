<!-- bump: patch -->

## What Changed

Instar's own merge tool now refuses a pull request that changes the constitution registry unless its body names its counterpart in the other rule book, or says why it has none (`scripts/check-constitution-pairing.mjs`, used by `scripts/safe-merge.mjs`). The green-PR watcher treats that refusal as waiting on a body edit. Adds the map of differences between the two books and corrects the direction-guard document. Does nothing outside the two instar repositories.

## What to Tell Your User

Nothing changes for you. This only affects how Instar's own rule book is maintained.

## Summary of New Capabilities

None for agents outside the Instar repositories. For maintainers: a pairing check for changes to the two rule books.

## Evidence

Unit and integration tests cover each outcome, including a failed read refusing as unknown. Run against real history since #2323, the checker reported drift on #2682, #2380, #2194, #2323 and instar-2 #182, none of which has a declaration line.
