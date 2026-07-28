# /a2a/inbox accept-boundary — explained simply

## The everyday version

When the mentor agent sends a task to the mentee agent (on the same machine), it does it with an
HTTP call: "here's a task." The mentee is supposed to say "got it" back. But the code on the mentee
side was saying "got it" only AFTER it had completely finished the task — and the task is "spin up a
whole work session and wait for it to think and reply," which takes minutes.

Meanwhile the sender only waits about 10 seconds for "got it." So it gave up every time, and logged
"delivery failed" — even though the message was actually received fine and the mentee was busy
working on it. The mentee's real answer comes back later as a totally separate message, so the sender
never needed to wait for the work to finish in the first place.

## What we changed

The mentee now says "got it" the instant it accepts the message — before doing the slow work — and
does the work in the background. The sender gets its acknowledgement right away, stops logging false
failures, and stops holding a connection open for 10 seconds. The answer still comes back on its own
channel exactly as before.

## Why it's safe

This is the exact same fix we already shipped and proved twice this session — for the two other ways
agents talk to each other (the co-located relay path and the cross-machine threadline path). This is
the third and last of those paths. We checked the one piece of code that calls this door: it only
looks at whether the response says "got it," within a 10-second window — it never depended on the
work being done first. The message is also still marked "seen" the instant it arrives, so a duplicate
delivery is still ignored. And if the background work errors out, it's logged quietly — it can't break
a "got it" that already went out. We added tests proving the "got it" comes back immediately (the old
code would have hung forever on a held task) and that a background error still leaves a clean "got it."
