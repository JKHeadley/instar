# Keeping track of how long main has gone unchecked, even across restarts

## What goes wrong today

Our project has one shared copy of the code that everyone builds on, called `main`. Every time someone's work is added to it, a checker should run all the tests on `main` to make sure it still works.

The same checker also tests each person's proposed change before it is added. There is only one checker, so the two kinds of work take turns. The rule is simple: proposed changes go first, unless `main` has been waiting unchecked for 90 minutes. After 90 minutes, `main` goes first.

The checker keeps a stopwatch for that wait. The trouble is that the stopwatch lives only in the program's short-term memory. When the program restarts, the stopwatch goes back to zero.

On 18 November 2026 the program restarted 12 times between late morning and evening, never more than 79 minutes apart. The stopwatch never reached 90 minutes. So `main` was last checked at 10:44 in the morning and was still unchecked more than ten hours later. The warning that should say "main has not been checked for three hours" uses the same stopwatch, so it stayed silent too.

## What this change does

The checker already writes a small note to disk about the health of `main`, and it already reads that note when it starts. We add one line to that note: the time the oldest unchecked addition was first seen.

When the program starts again, it reads that time and carries on counting from there. When `main` is checked and passes, the line is cleared, because nothing is waiting any more.

## What if the note has no usable time

This happens the first time the new version starts, when the job moves to another computer, or when the note is damaged. Then the program does not pretend to know. It treats the wait as "unknown", and unknown means `main` gets the next turn. It does not invent a number. It does write down when the wait first became unknown, so that if `main` is still unchecked three hours after that, the usual warning appears and says "at least three hours".

## What it costs

This is a trade, and it is worth saying plainly. When the wait is unknown, one proposed change has to wait behind one check of `main`. That happens once each time the wait becomes unknown: a start with no usable time in the note, or the job coming back from another computer. When the note does have a time, nothing changes except that a restart no longer resets the stopwatch.

If `main` really has gone more than three hours unchecked, the existing warning will now appear even if the program restarted in between. That is the true situation, which the old stopwatch was hiding.

## What stays the same

The 90 minute rule, the three hour warning, how restarts work, and everything about checking proposed changes. There is no new setting. If the change causes trouble, we undo the code change and the extra line in the note is ignored.
