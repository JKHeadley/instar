# Honest progress messaging — the plain-English version

## What's wrong today

Two of my background systems send you messages in topics, and both lie without meaning to.

**The silent-freeze watchdog.** It watches a session's terminal screen. If the screen stops changing for 15 minutes while it looked busy, it presses Enter to try to wake it, and if nothing happens it messages you: *"X was working and went quiet about 16 minutes ago. I tried a gentle nudge and nothing came back. Want me to dig in?"* The problem: a session running a long task — a build, a sub-task, a slow command — shows a frozen-looking screen *while it's genuinely working*. So this fires constantly on healthy sessions, and it states "went quiet" as if it's certain, when it isn't. You told me it's "almost never accurate."

**The promise beacon (the ⌛ messages).** When I tell you "I'll follow up when X is done," I register that as a promise, and this thing pings you every ~10 minutes while the promise is open: *"⌛ still on it, no new output since last update."* That "no new output" just means the screen's snapshot didn't change — it carries zero real information. And it keeps firing forever because the promise never got closed, quoting a task you stopped caring about hours ago. You said it "pops up randomly" and you're "not even sure what it's referring to."

## What changes

You picked "make them honest" over "turn them off." So both go from chatty-and-wrong to quiet-and-truthful:

**Silent-freeze watchdog** — before it says anything, it now checks whether the session is *actually* still working (a live "working / press to interrupt" indicator on screen, or a running sub-task). If it's genuinely working, it stays completely silent — a quiet screen during a long task is not a freeze. It only speaks when the evidence really points to a wedge: no work indicator, no running sub-task, and a nudge changed nothing. The threshold goes from 15 to 30 minutes. And when it does speak, it tells the truth about its own uncertainty: *"X's screen hasn't changed in 30 min and a nudge didn't wake it — it may be stuck, or on a long task I can't see into. Want me to check?"*

**Promise beacon** — it goes silent whenever nothing real has changed. The "still on it, nothing changed" filler is gone entirely. It only speaks when there's genuine new progress, when something's actually at risk, or to close out: *"X: I said I'd follow up on '…' but that work's session has wrapped. Want me to pick it back up, or close this out?"*

## What you'll notice

In normal operation you'll mostly *stop seeing both of these*. They surface only when there's something true and actionable to tell you. We're not deleting them — a genuinely stuck session and a genuinely long silent task are real things worth a heads-up — we're making them earn the right to speak.

## Tradeoffs and the honest caveats

- The silent-freeze watchdog will now catch a real freeze ~15 minutes later than before (30-min threshold). That's a deliberate trade: by your own experience the old 15-min alerts were almost always false, so waiting for stronger evidence is worth it.
- A truly wedged session that somehow *keeps* its "working" indicator on screen could be missed. That's rare, and other watchdogs (socket-drop, context-wedge) cover adjacent cases.
- This ships to every agent in the fleet on update, not just me — the noisy old behavior is still reachable for anyone who wants it via an explicit config switch, but the honest behavior is the new default.
