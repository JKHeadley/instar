# Side-effects review: tidier Home and group pages

## Change
- Home "What needs you" rows: the sub-line no longer repeats the machine when the title already starts with "<machine>:", and no longer shows the queue's priority word ("high").
- Every Home card: a footer with nothing in it is hidden (it left a blank band with a divider under the rows).
- Work / Capacity / People / Settings pages: the subtitle "Each of these opens in the dashboard, where everything works exactly as before." is removed (most tiles now open native console pages), and the footer reads "The older dashboard is still available: open the legacy dashboard." instead of claiming everything is still there.
- Promises page: the empty "Waiting on you" card is not shown when nothing waits (the headline already says "Nothing is waiting on you.").
- Pace card (Work): each line's dot stays beside its text at phone width (grid instead of a wrapping flex row), and queues with nothing coming in, nothing done and nothing open are not listed. A queue with no flow but items still open no longer reads "0 a day in, 0 done — holding steady"; it says "nothing came in or got done this week; N still open" (on 2026-11-02, Mac Mini and Laptop held 93–100 open promises and 1,161–1,271 open self-improvement items with no movement).

## Evidence
Phone-width screenshots of the preview (2026-11-02): rows read "Mac Lan: Remote Desktop …" over "Mac Lan · high"; the needs card ended in an empty 44 px footer; Pace showed each dot on its own line and four rows of "0 a day in, 0 done"; group pages carried the outdated subtitle and footer.

## 1–5
Not a gate; no decision points. A queue with any activity or open items is still listed; the summary line is unchanged. Footer hiding only applies when it has no text and no link.

## 6. External surfaces / 6b. Operator-surface quality
Dashboard only. Rechecked on the preview at 390×844 after the change.

## 7. Multi-machine posture
Page code only.

## 8. Rollback cost
Revert.
