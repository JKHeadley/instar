# The standards check compared against the wrong version of main — the fix

## What happened

When a pull request changes the rules registry, a standards check compares it against main to see which rules it adds or changes. Changes to rules need Justin's approval, so this matters. To make that comparison, the check took the copy of main recorded when the pull request was last pushed. But the test run itself checks the pull request merged into main as it stands at that moment.

On 27 November, two rules arrived on main at 19:01 through another pull request. A pull request pushed earlier, #3387, was then checked against the older copy, so those two rules looked like its own additions. The check demanded Justin's approval for rules the pull request never touched. Any pull request whose last push came before a rules change on main would fail the same way.

## What changes

For a pull request run, the check now compares against the exact copy of main that the run is testing (the first parent of the merge commit GitHub builds). There are two safeguards. It only moves the comparison point forward, never back. And the commit it uses must really be on main, so it can never compare against something from the pull request itself. Runs triggered by a review of the pull request take the same rule, because they test the same merge. Pushes behave as before.

## What it does not change

Who must approve what. A pull request that really changes a rule still needs Justin's approval, exactly as before. This only stops rules the pull request inherited from main from being counted as its own.
