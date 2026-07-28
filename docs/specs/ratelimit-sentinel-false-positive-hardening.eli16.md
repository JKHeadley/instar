# Plain-English overview — Fixing false "API error" alarms

## What's broken

I watch my own Claude sessions and try to rescue them when they hit a real
Anthropic API error (a server throttle, a 529 overload, a dropped connection).
When a session genuinely dies on one of those, I nudge it to continue, and if it
stays dead I escalate so you find out.

Justin noticed this alarm firing when nothing was actually wrong. We dug into the
logs and he was right. Two separate flaws stacked up:

**Flaw 1 — I matched the *word*, not the *event*.** To decide "did this turn die
on an API error?", I scanned the last 30 lines on the terminal for strings like
`API Error:` or `fetch failed`. But those words can be on the screen for innocent
reasons — for example, when the session is literally *investigating* API errors
(which is exactly what was happening), or when a little "message queued" note that
contains `fetch failed` is shown. So a session that finished its turn perfectly
normally, with some error-looking text sitting in the scrollback, looked to me like
a session that had crashed.

**Flaw 2 — my "did it recover?" check was looking in the wrong place.** To confirm
a session came back to life, I check whether its conversation transcript file is
growing. But I only ever looked in ONE folder (`~/.claude`). I actually run sessions
under several different account folders (that's how I juggle multiple Claude logins
to spread out usage). So for a session living in a different folder, I could never
find its transcript, could never see it growing, and therefore concluded "it never
recovered" — even while the session was visibly alive and typing. That turned one
wrong guess into an 11-minute stream of repeated nudges. Classic crying wolf.

## What the fix does

**For Flaw 1:** before I sound the alarm, I now require two things, not one — the
error has to be the *last meaningful thing* on the screen (not buried up in
scrollback), AND the screen has to be *frozen* (a working session constantly
animates its spinner and timer, so a frozen screen is the real sign a turn ended).
Incidental error text on a busy, moving screen no longer trips it.

**For Flaw 2:** I now look for a session's transcript in *its own* account folder —
which I already know, because I chose it when I launched the session. That's exact,
fast, and never accidentally reads a different session's file. And if I genuinely
can't find the transcript, I no longer escalate blindly: a session whose screen is
alive and no longer showing an error is treated as "still proving itself," never as
a failure. The only thing I escalate now is a screen that is BOTH frozen AND still
showing the error — which is what "actually stuck" really looks like.

## What changes for you

Far fewer false "I think a session is stuck" alarms, and no behavior change at all
when something is genuinely wrong — a real stuck session is still caught and
escalated. Two off-switches ship with it (both on by default) so either half can be
rolled back instantly if it ever misbehaves, without a redeploy. The messages you
see are unchanged; they just stop firing when there's nothing wrong.
