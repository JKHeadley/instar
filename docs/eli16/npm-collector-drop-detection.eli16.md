# The npm download collector now notices drops, and compares the right days — plain-English overview

**What went wrong.** A small script collects how many times Instar is downloaded from npm each day and writes it to a log. It only ever warned about sudden jumps. On 2026-10-18 the weekly downloads fell by more than half and npm's daily numbers had a three-day hole in them, and the script said nothing; a person had to spot it. A fix for that was written on 2026-10-24 but never merged, so the running script never got it.

**A second problem.** The script compared "today" with "the last time it ran" and called that "the previous 24 hours". When a run was missed, those were days apart. On 2026-11-02 it alerted that downloads had more than doubled, comparing November 1 with October 29; the real day before, October 31, was higher, so it was actually a small drop. Its "a week ago" figure had the same flaw: it was the reading from seven runs back, which could be eight, ten or more days back, and reports built on it overstated growth.

**What changes.** The script now warns when a week falls below 60% of the week before, and when npm reports two or more zero days in a row with real traffic on both sides. Day-to-day jumps compare a day with the calendar day before it, and the alert names both dates. "Last week" is the seven calendar days before the current week, added up from the daily numbers already in the log. If any of those days is missing, the script says the figure is unavailable instead of guessing.

**What does not change.** Nothing in Instar itself, or in any agent people run, uses this script. Only the operator's own reports read its log.

**Safeguards.** It only writes numbers and sends an informational message; it cannot block anything. Reverting the one commit restores the old behaviour with no data to repair.

**What you need to decide.** Nothing.
