<!-- bump: patch -->
## What Changed

Conversations → Review suggestions: a long "Accept all" no longer loses its page and progress when the 15-minute dashboard unlock runs out. Before it starts (under 10 minutes left) and before each project (under 5 minutes left) it asks for the PIN in a sheet over the page, so the list, the progress line and the run stay; closing the sheet stops with words and a working button. The button reads "Continue accepting projects" when a project is already part-way. The list says when it is slow to load and offers "Try again" when it fails. A step the agent does not answer reads "The agent did not answer…" and counts as a wait, instead of the untrue "This suggestion is no longer available". New `ui.js` helpers: `operatorSessionRemainingMs()` and `askPin({fresh:true})`.

## What to Tell Your User

If Accept all takes a while, it may ask for your PIN again in a small box; type it and it keeps going where it was. It no longer drops you back to a reloaded list.

## Summary of New Capabilities

- Accept all asks for the PIN in place instead of losing the page when the unlock runs out.

## Evidence

Four new DOM tests in `tests/unit/console-conversations-dom.test.ts` (sheet keeps the page and the run finishes with one list load; closed sheet leaves words and a working button; part-way project offers Continue; failed load offers Try again, slow load says so). Unit suites for the page: 44 passed.
