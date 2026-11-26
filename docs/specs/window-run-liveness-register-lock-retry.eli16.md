# Window-run liveness: a registration no longer fails just because a check was running

**What was wrong.** The part of Echo that watches a long "window" work session keeps its
record in a file protected by a lock, so two things never change it at the same moment.
Every few seconds a background check takes that lock, and it holds it while it waits on
other work. Registering a new window also needs the lock, but it asked for it exactly once
and gave up immediately if the lock was taken. So if you happened to register while the
background check was running, you got a "lock is already held" error instead of a
registration. On a quiet machine this almost never happened; on a busy machine it happened
often, and one of our end-to-end tests failed because of it (on the main branch too, not
just the branch this fix ships on).

**What changed.** The registration request now waits politely: if the lock is taken, it
pauses for a fiftieth of a second and asks again, up to about two seconds in total — the
same patience the background check already uses. While it pauses, it lets the rest of the
program keep running, which is what allows the background check to finish and let go of the
lock. Any other kind of error (a malformed request, a missing field) is still refused on the
first try, exactly as before.

**Why not a bigger change.** The deeper fix is to make the record-changing code wait
properly everywhere. One other place (freezing a window when its time runs out) has the same
pattern, but it is called from code that cannot pause mid-way, so changing it safely is a
bigger job. It is tracked separately (ACT-033) instead of being rushed into this fix.

**How we know it works.** A new test checks all three cases: the lock is busy a few times
and then frees up (registration succeeds), a real error (refused immediately, no retry), and
a lock that never frees (refused after the two-second limit). The end-to-end test that had
been failing now passes three times in a row on the same busy machine.
