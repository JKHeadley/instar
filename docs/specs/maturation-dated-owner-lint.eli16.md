# Every unfinished feature has someone who decides it, and a date — the dated-owner check

## What this is about

Instar ships many features switched off at first. Each one waits on a "ladder": test agent, then the development agent, then every agent. The ladder list (`src/data/feature-ladders.json`) holds 261 features. 231 of them are waiting for their next step. Until now none of them recorded **who** decides that next step or **by when**. So a feature could sit switched off for months, and nobody would notice it had stalled. 64 of them still showed expected dates from June to August.

The rules (the Maturation Path article) have said since 6 November, on Justin's instruction: "A ladder entry whose next rung has no owner or no due date must fail the build." Nothing checked it, and that gap carries a deadline of 21 December. When the deadline passes, every commit in the project stops.

## What changes

- **Two new fields** on each waiting feature: `owner` (the project session that decides its next step) and `reviewDue` (the date it must be decided by). A third, `reviewDueReason`, records why a date was set or moved.
- **A new check, run on every commit**, fails if a waiting feature has no owner or no date. A finished or retiring feature is not checked.
- **A passed date does not stop anyone's commit.** The check lists every overdue feature by name each time it runs. Every morning a separate daily check messages each feature's owner about its overdue steps and gives the Chief of Staff the list, so nothing expires quietly. This is deliberate. Today a single passed date stopped every commit in the project for hours. 231 dates that could each do the same would be far worse. The rules say an overdue step is closed with evidence, re-dated with a reason, or taken to Justin. They never say the whole project stops.
- **The owners and dates are filled in for all 231.** Owners go by area, as the Chief of Staff ruled on 27 November. For example, the machine features go to Machine Stewardship, and the safety guards go to Reliability Reports (a few other monitoring features go to Engine Feature Optimization). Dates keep the latest review's expected date where it is still current. Stale or missing dates get the owner's next free slot. No owner gets more than 15 due in any one week.

## What it cannot see

Whether the named owner is actually working, and whether a far-off date is honest. The owner of the maturation track reads both.

## Not in this change

The rules-registry text that marks this deadline as met ships in one later registry change, together with the other December closures, so that Justin approves them once.
