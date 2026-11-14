# Why the dashboard kept saying "part of the list could not be checked", in plain words

**The complaint.** The operator saw "Nothing needs you that I can see. Part of the list could not be checked." almost every time he opened the dashboard. That wears down trust: a warning that is always on means nothing.

**What was really going on.** Three separate things, and none of them was an actual failure.

1. Each machine keeps a copy of the other machines' promises, and notes when it last refreshed each copy. It only noted that when something had changed. A machine with no new promises for two hours therefore looked two hours out of date, even though it was checked every few seconds and found current. It now notes "checked, nothing new" as well, so a quiet machine reads as up to date.
2. One machine, the M5 Pro, simply has no promises. The page read "nothing from the M5 Pro" as "couldn't check the M5 Pro". It now treats one quiet or behind machine as a detail, named under "See agent status", and not as a warning on the front page. Only a total blind spot (no other machine's promises at all) still counts as "could not be checked".
3. Some pages gave up after 8 seconds, but asking every machine can briefly take longer. Every page now waits up to 20 seconds and tries once more on its own before ever saying "can't tell".

**What to decide.** Nothing beyond review. Reverting the change undoes it.
