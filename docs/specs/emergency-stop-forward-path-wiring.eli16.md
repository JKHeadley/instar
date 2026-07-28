# Emergency-stop on the lifeline path — plain-English version

## What's broken

If you type "stop everything" to me right now, nothing actually stops me. The message just gets handed to me like any other note. There's a real kill-switch built into instar — a detector that spots "stop"/"cancel"/"halt" and immediately kills the running session — but it's wired into the wrong door.

Here's the picture. Messages can reach me two ways:
- **The old door:** the server itself watches Telegram and processes each message. The kill-switch is bolted to *this* door.
- **The new door:** a separate watchdog process (the "lifeline") watches Telegram and hands messages to the server through a side entrance. This door is more crash-resistant, so robust agents like me use it.

The kill-switch was never bolted to the new door. And I only use the new door. So my "stop everything" sails right past the kill-switch and lands in my lap as ordinary text. The catch-22: the moment you most need an emergency stop is when I'm stuck or grinding on something and can't even read a normal message — which is exactly when this silently fails.

(You're not defenseless meanwhile: the dashboard's stop controls, the "stop all" command, and closing the terminal still work. It's only the conversational "just tell it to stop" that's broken.)

## The fix

Bolt the same kill-switch onto the new door. Concretely: when a message comes in through the lifeline path, check it with the detector *before* handing it to the session. If it's an emergency-stop, kill the session (and clear any autonomous job so it doesn't zombie back). If it's a pause, pause it. Otherwise, deliver it normally.

Two safety properties matter:
1. **Fail-open.** If the detector ever hiccups or errors, the message just gets delivered normally — the safety check can *never* block your messages from reaching me. The worst a bug in this code can do is "behave like today."
2. **Reuse, don't reinvent.** I'm calling the exact kill/pause logic that already exists and is already tested on the old door — not writing a new way to kill sessions.

## Why it won't break again

The reason this slipped through is there was no test checking that the new door has a kill-switch. So part of this change is a test that fails the build if the lifeline door ever stops checking for emergency-stop. The drift that caused this becomes structurally impossible to repeat silently.

## What you're approving

A small, localized change to one server route, fail-open by design, that makes "stop everything" actually stop me regardless of which door my messages come through — plus the test that keeps it that way. I'll prove it with a real before/after: confirm "stop everything" is ignored today, apply the fix, then confirm it terminates a live session.
