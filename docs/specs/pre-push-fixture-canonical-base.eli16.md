# Stop blocking pushes for commits already on main

Before a branch is sent to GitHub, the fixture guard checks for commits accidentally created by software tests. These commits can contain test files or replace project files. The guard is supposed to check commits introduced by the work being pushed.

A feature branch can fall behind main while its developer works. When the developer merges main, the previous version of the feature branch does not contain that history. Comparing with that older feature branch caused the guard to flag commits that had already reached main.

The guard now selects the same remote main as the release check when multiple remotes are present. If no remote main exists locally, it can still use the tracked branch. A fixture commit added to the feature branch still blocks the push.

The tests cover a normal merge from main, a new fixture commit after that merge, and an alternate remote that contains a fixture commit missing from the canonical main. Developers still get the commit and comparison range in the failure message.
