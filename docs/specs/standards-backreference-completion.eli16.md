# The 27 files that enforce a standard now say which one, and the test line is unblocked

## What this is about

Instar keeps a list of standards: rules the project has decided to live by. For each rule, the list names the pieces of code that enforce it. On 13 August 2026 Justin ordered that the link must run both ways: the code that enforces a rule has to say, in the code, which rule it enforces. Otherwise someone can delete a guard without ever knowing a standard depended on it.

When that order was written down, 27 of the files named in the list did not yet say which rule they enforce. They were put on a "still to do" list that is only allowed to get shorter, and the rule was given a deadline: 13 November 2026.

## What went wrong

A check runs whenever any change is tested. It reads the standards list, and if it finds an unfinished job whose deadline has passed, it fails. That is deliberate: a deadline nobody enforces is not a deadline.

The 27 files were never done. On 14 November (by the clock the check uses, which was 4:00 PM on the 13th in California) the deadline passed, and from that moment every change failed its tests, whatever it contained. Nothing could merge.

## What this change does

1. Each of the 27 files now carries a short line at the top naming the standard, or standards, that the list says it enforces. The names are taken from the list itself: if the list says file X enforces rule Y, file X now says "governed by rule Y". Nothing was guessed from what a file looks like.
2. The "still to do" list is now empty. From here on, a file that the list names and that does not name a standard back fails the check at once.
3. One small repair to the check: three standards have very short names (for example "Self-Hosting"). The check ignored short names completely, so a file governed only by one of them could never pass. A short name now counts when it is written the way the list writes a standard's name, between asterisks.
4. The text of the rule in the standards list is updated to say what is true now: all 70 files named in the list carry their reference.

## The one decision in here

The unfinished job had two halves. The first, the 27 files, is done. The second is to extend the same requirement to code the list has never named at all. That needs a definition of which code counts, and it is not done.

So the rule still has an open half, and it needs a date. This change proposes 27 November 2026. The check's own message says a date like this may only be moved by the operator, on purpose. The standards list is a file only Justin can approve changes to, so approving this change is that decision. If he wants a different date, it is one number.

## What could go wrong

The added lines are comments; they change nothing the code does. The risk is a wrong name in a comment, and the check now verifies that every name is a real standard.
