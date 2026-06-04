# Enforcing the dogfooded channel — explained simply

The apprenticeship rule (just documented) is: a mentor must drive its mentee through
the REAL Telegram UX (via Playwright), because experiencing the user experience IS the
test. A shortcut — calling the mentee's CLI directly — gets an answer but skips the
thing we're actually testing.

A doc alone is a wish. This makes it a guarantee: every recorded apprenticeship cycle
now writes down WHICH channel it actually ran through. And the keystone check — the one
that tells us the real mentor↔mentee work is happening — only counts a cycle if it ran
through the real channel (Telegram-Playwright, or the backup). A shortcut cycle is still
saved (so we're honest it happened), but it does NOT light up the keystone. So a shortcut
can never make the program look healthier than it is.

Older cycles (recorded before this field existed) are grandfathered in — they still
count, so this never retroactively "un-fires" a keystone we already earned.
