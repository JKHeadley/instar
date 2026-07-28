# The Codex "clean notepad" fix — in plain terms

## The one-sentence version

Codey reloads his entire 26,000-character identity and runs his full startup routine every
single time the system asks him a tiny background question — about 1,500 times a day — and
this fix makes those background questions use a clean, blank notepad instead.

## What's actually happening

All day long, instar quietly asks the agent little yes/no-ish questions in the background:
"Is this message an emergency-stop or just normal?" "Did the agent finish its turn?"
"Summarize this chat." These are tiny — the answer is often a single word.

For me (Claude), the system asks these on a blank notepad. My code literally has a line
that says "leave the identity out of these little calls."

Codey has no such line. So every one of those ~1,500 daily questions makes him:
1. Re-read his whole 26 KB identity document, and
2. Run his entire "I'm starting a session!" routine — the one that announces itself and
   pings the monitoring system.

Just to answer "normal."

## Why that's the cause of the mess you saw

- The "still working / message delivered" spam? That's his startup routine firing 1,500
  times a day — the monitor keeps thinking a brand-new session just began.
- The "couldn't deliver, please resend"? At busy moments a dozen of these heavyweight
  questions pile up in one minute, the machine chokes, and your actual message can't get
  in the door.

It's like making someone put on their full uniform, clock in, and read the handbook every
time you want to ask them the time. Do that 1,500 times and of course they look frazzled.

## The fix

Give Codey's background questions the same clean notepad mine already use: ask them in an
empty side-room that has no identity document and no startup routine attached. One small
change to one file. He keeps his full identity and startup routine for real work — this
only changes the throwaway background questions.

## How we'll know it actually worked

We don't trust the green checkmarks alone. We reproduce it live: ask Codey a background
question before the fix and confirm his logs show the giant identity + startup routine;
then after the fix, confirm the same question's log is bare. Seeing the "before" actually
stop is the proof.

## Where this fits

This is step zero. It ships on its own, first — so that when we start the bigger
"mentor Codey" project, we're building on a healthy system instead of one with a leak.
