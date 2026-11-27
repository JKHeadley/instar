# Quality history: say what is not shown — plain-English overview

**Why this exists.** The quality history page went live and was checked against its real answer. Its top lines said "3 of 48 measured items are off their goal. 14 have too few samples to judge; 20 are at goal." That adds up to 37, so 11 items were left unexplained. The page also never said that it had skipped 1,634 tracked items because of its read limit, that 381 have no measurement at all, that long histories are thinned, or that it covers only this machine. An at-a-glance page that hides what it leaves out looks more complete than it is.

**What changes.**
- The line under the headline now names every group, so the numbers add up. For example: "Worst first. 14 have too few samples to judge, 20 are at goal, 11 have no recorded values yet."
- A short line on the first screen says what is not shown, with a link to ask what to cover next. For example: "This machine only. Not shown: 381 tracked items with no measurement yet."
- The chart key adds "Up to 24 points per chart" when a history was thinned.
- The read limit is now spent on items that can actually have a chart. Before, the page read tracked items in alphabetical order and stopped at 400, so measured items further down the alphabet could be dropped behind ones with no measurement. Now items with a measurement are read first, and items with no measurement are only counted, never read. That makes the page faster, and it means the limit is reported only when measured items really are left out.

**What does not change.** It is still read-only. Nothing is stored, and nothing is switched on or blocked. The charts and their honesty labels are unchanged. Undoing this is a plain revert.

**What to decide.** Nothing.
