# Suppressed-crash stack capture (#72) — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/311d1657-692e-48ca-a112-04c82fa74dec?sig=6e66a9515e16c2e28156a94169f7737cb86dd0c661440267eed93dc730ebd632

The agent server has a short list of harmless-but-annoying errors it deliberately swallows
instead of crashing — the main one is an HTTP race called "Cannot set headers after they are
sent" (two replies sent for one web request). Swallowing it is correct: the request is already
handled, and crashing the whole agent would be far worse.

The snag: it only logged the error MESSAGE, not WHERE it came from. And that error is thrown
deep inside Node's plumbing, so the message alone never says which piece of code double-replied.
It fires 10–20 times an hour on each agent, completely un-findable.

This change logs the full stack trace the FIRST time each distinct origin appears, then goes
quiet (message-only) for the repeats. So the offending code reveals itself once — enough to
actually fix the real double-reply — without flooding the log. Nothing about what gets swallowed
vs. crashed changes; only how the swallowed ones are logged.

_Patch · branch `echo/double-send-stack-capture` · found by scanning live fleet logs (the
see-what-breaks loop). Step 1 (make it findable); the real double-send fix follows once the next
occurrence reveals the route._
