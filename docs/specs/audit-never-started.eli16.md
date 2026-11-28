# Audits that must recur now have a list, and a missed one gets noticed

## What this is about

Instar's rules say an audit is never a one-off. A security review, or a sweep of how the agent classifies requests, is meant to be repeated, because the code keeps changing underneath it. Today a finished audit is checked carefully: a report only counts as finished when its rounds of findings genuinely reached zero. But nothing notices an audit that is simply never run again. The rules registry says so in plain words: "a sweep that is simply never started satisfies no check". A dated promise to close that gap falls due on 21 December. When it passes, every commit in the project stops.

## What changes

- **A short list of audits that must recur**, kept in one file next to the audit reports. Each line names the audit, who runs it, how often (every month, every quarter or every year), and when it is first due. The first version proposes seven audits, chosen from the 67 reports that already exist. The Chief of Staff confirms that list on Monday.
- **A check that reads the list against the reports.** For each audit it finds the newest finished report and sorts the audit into one of four states: fine, not yet due, never started, or overdue. It allows two weeks of grace past the due date before calling an audit overdue.
- **A late audit never stops anyone else's work.** On 27 November, one passed date stopped every commit in the project for two hours. So the check fails a commit only when the list itself is broken (a line with no owner or no real date), or when someone quietly puts an audit off. Moving an audit's date later, making it rarer or deleting it from the list needs a written reason, and the check compares against the copy already on the main branch to catch it. A missed or late audit is reported by name every time the check runs. Every morning the owner gets a message about it and the Chief of Staff gets the list. Once a week, a separate scheduled check keeps one tracking issue open on the project while anything is late, and closes it when nothing is. That is the same way the project already tracks reviews of its rule families, and it never blocks anyone.
- **The family audits are not listed twice.** They already re-run whenever the rules they cover change, so the list points at that existing trigger instead of adding a second clock.

## What it cannot see

Whether an audit that ran was deep enough. That is the job of the existing check on finished reports and of its reviewers. It also cannot see an audit that ought to recur but was never put on the list. Adding one is a review decision.

## What the reader needs to decide

Whether two weeks of grace is right for every cadence, or whether it should scale with how often the audit runs.
