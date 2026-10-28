# Console Home: a calm front page

## What Changed

- `dashboard/console/home-model.js`: Home stops showing counts that ask nothing of the operator (routine notices, promises carried or untouched for weeks); a missed promise untouched for 14+ days is no longer a red row; a promise waiting on the operator is listed once (in What needs you, not again under What I've promised); when every machine is answering, Where I'm running shows that one line instead of a row per machine; the headline names the areas it can't fully see ("can't fully see promises") instead of counting them. Spec `docs/specs/console-makeover.md` §1 updated to match.

## What to Tell Your User

The console's home screen is quieter. It shows what needs you and little else: no counts of routine notices or old promises, no red rows for things that went stale weeks ago, no list of machines when they are all fine, and the same item is never shown twice. Everything is still there one tap away under "See all" or the tab links.

## Summary of New Capabilities

- Calmer console Home: only actionable items on the front page.

## Evidence

Console unit tests 86/86 (new: all-healthy machines collapse, stale misses aren't red, waiting promise listed once, headline names unseen areas); e2e `console-home-lifecycle` 20/20. Rendered at 390px on a live five-machine snapshot from the Mac Studio.
