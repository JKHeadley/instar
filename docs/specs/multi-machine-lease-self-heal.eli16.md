# ELI16 — Keeping "one agent on two computers" from getting stuck with NO captain

When you run the same agent on two machines (here: a stationary Mac Mini and a traveling
laptop), exactly one is supposed to be "awake" — the captain that answers messages and runs
scheduled jobs. The other waits on standby. An older set of fixes already handles the case
where the two machines *fight* over being captain. But a live incident on 2026-06-19 showed a
different, worse failure: the mesh ended up with **NO captain at all**, and it could not fix
itself. Messages still arrived (the web server was alive), but the part that decides "who's in
charge" had silently stopped 91 minutes earlier and nothing restarted it.

This spec adds four fixes, three of them OFF by default until tested on the real pair.

**Fix 1 — self-heal a frozen "who's in charge" loop (ON by default, because it's safe).**
The captain-election runs on a repeating timer. We found that a single network call inside it
can hang forever, which jams the whole loop — like a cashier frozen mid-transaction so the
line never moves. The main fix is a **timeout**: any network call in that loop is given 20
seconds, then it's cut loose and the line moves again. A backup **watchdog** also notices if the
loop has gone quiet for ~10 minutes and restarts it — but carefully, so it never interrupts a
call that's just slow rather than truly stuck, and it can never crash the program. If the
watchdog finds itself restarting things over and over, it stops and raises a flag, because a
watchdog that won't shut up is itself a problem.

**Fix 2 — let standby take over a captain that's secretly dead (OFF by default).** Today, if the
captain stops doing its job but still "looks alive," standby waits a full 15 minutes before
stepping in. We make standby notice sooner — but the tricky part is measuring "the captain
stopped renewing" *without* trusting the captain's own clock (two computers' clocks drift, and a
fast clock could make standby wrongly steal the job from a perfectly healthy captain — a real bug
we caught in the first draft of this very spec). The fix: standby times the gap on **its own
stopwatch**, watching whether the captain keeps sending fresh "still here" signals. No clock
comparison between machines, so clock drift can't cause a wrongful takeover.

**Fix 3 — a muted machine must hand back the captain's hat (OFF by default).** When you put the
laptop on "quiet standby," if it was the captain at that moment it would keep *holding the title*
without doing the job — a zombie captain everyone waits behind. The fix makes a quieted machine
actively give up the title so the other machine can take over.

**Fix 4 — let the operator pick a preferred captain (OFF by default).** You can name the
stationary Mini as the preferred captain so the traveling laptop defers to it. Safeguards: both
machines must agree on who's preferred (otherwise they fall back to the old tie-break and raise a
flag), a preferred machine only wins if it's actually healthy (a dead "preferred" machine never
wins), and the standby never leaves the mesh captain-less while the preferred is bouncing.

**Why so careful?** Every one of these touches "who's the boss" — and a mistake could silence the
*wrong* machine or leave nobody in charge. So three of the four ship OFF, and all of them are
verified on the real Mini+laptop pair by deliberately *causing* the fault (not waiting for it),
including running one machine's clock fast on purpose to prove the takeover logic is drift-proof.
The first draft of this spec had a genuine bug (Fix 2 measured the wrong thing); multi-angle
review caught it before a single line of code was written. That's the point of speccing first.
