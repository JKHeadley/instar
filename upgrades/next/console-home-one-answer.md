# Console Home: one answer to "what needs you", and no internal ids on screen

## What Changed

- `dashboard/console/home-model.js`: new `combineNeeds()` folds promises waiting on the operator into the "What needs you" card; `headline()` counts that combined card alone, so the headline and the card can no longer disagree. New `machineLabel()` / `unreachedLine()` / `machineNames()`: an unreachable machine is named from the pool, or described as "a machine with no name on file" — never shown by its internal id. Plain wording replaces "No answer from …", "routine notices kept in the log", "N need you", "N others I'm carrying".
- `dashboard/console/console.js`: Home keeps the raw card models and paints the combined one; the pooled cards get machine names from `/pool`.

## What to Tell Your User

The console's home screen now gives one answer to "what needs you". Before, the big line at the top could say "One thing needs you" while the box underneath said "Nothing needs you", because they counted different things. The box now lists promises that are waiting on you alongside everything else, and both count the same items. Lines like "No answer from m_a804…" are gone: a machine is shown by its name, or described when it has none.

## Summary of New Capabilities

- Console Home "What needs you" includes promises waiting on the operator; headline and card always agree.
- A unit-test guard fails any Home change that puts a raw id, a placeholder value or a known internal phrase on screen.

## Evidence

New `tests/unit/console-home-one-answer.test.ts` 21/21, including the reported case (promise waiting, empty queue → card and headline both "One thing needs you"), unread promises never letting the card claim "Nothing needs you", and a scan of every Home builder's rendered text over 12 inputs for raw ids / placeholders / internal phrases, with a positive control on the reported line. On the old `home-model.js` the new file fails 12/21. `console-home-model.test.ts` and `console-dom.test.ts` green (57/57 combined, 3 expectations updated for the new wording). Run on a live three-machine snapshot: headline and card both "One thing needs you".
