<!-- bump: patch -->

## What Changed

The maturation ladder no longer hides a feature's numbers just because its evidence log has started a second file. It now treats a reading as incomplete only when old rows were really thrown away: the oldest file the log keeps is no longer its very first one, or part of the log has been compressed. A log that simply started recently is complete. It still reports how many days of history it holds.

The ladder also checks the switch above a feature when the code needs that switch too. The dark-flag inventory and the blocked-digest escalation only run inside the growth analyst. If the growth analyst is off, both now show as off. Before, they could show as ready to move up while nothing was running.

## What to Tell Your User

The feature progress view shows real error and success rates again. For about a week it had shown most of them as "still collecting". That happened because the evidence log had been restarted recently and had grown into a second file. Some features that looked fine now show problems that were there all along, so a few may move from "collecting" to "needs attention". Nothing changed about how the features themselves behave.

## Summary of New Capabilities

No new setting is required. A ladder entry can name a parent switch the code also depends on, so the ladder reads the same on/off state the code uses.

## Evidence

Unit tests cover a log that rotated once and lost nothing (its numbers come back, with its coverage days), a log that reached its keep limit (cut), a compressed segment (cut), and a dropped segment whose kept rows already cover the window (not cut). They also cover a dark-flag-inventory-style feature that is switched on while its parent is off (dark, not ready to advance). The new tests fail on the old code. The 17 neighbouring test files (540 tests) pass.
