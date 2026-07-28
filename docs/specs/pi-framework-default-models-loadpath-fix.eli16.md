# Why pi wouldn't turn on — explained simply

## The short version
Instar can run its background "thinking" tasks (like the check every message
passes before it's sent) on different AI engines: Claude, Codex, Gemini, or Pi.
Pi is the fastest. But no matter how you set things up, Pi would never actually
switch on — the system kept marking it "unavailable." This fixes that.

## What was actually broken
Think of your settings file as a form you fill out. One box on that form says
"which model should Pi use?" — and Pi flatly refuses to start without it (that's
on purpose: starting Pi with no model picked would make every Pi call fail).

The problem: when the system *read* your settings form at startup, it copied most
boxes over but **silently skipped the "Pi's model" box.** So by the time it tried
to start Pi, that box looked empty — even though you'd filled it in. Pi saw "no
model" and shut itself off. Every single time. On every machine.

The give-away was that the box right next to it ("which engine runs which task")
had the *exact same bug* once before, back in June, and someone fixed that one but
didn't notice its neighbor had the same hole.

## The fix
One small change: when the system reads your settings, also copy over the "Pi's
model" box — exactly the way it already copies the box next to it. That's it.

## What changes for you
- If you've told Instar to use Pi, it now actually uses Pi.
- If you haven't, nothing changes at all — the box stays empty like before.
- Pi still only turns on if its program is actually installed AND a model is
  picked, so this can't switch Pi on by accident.

## How we know it works
- Two automated tests: one proves the "Pi's model" box now gets copied; one proves
  that if you leave it blank, it stays blank (no phantom values). Both pass.
- On the live machine: after the fix, Pi shows up as available, the message-check
  ran on Pi, and a real reply went through on the first try in about 6 seconds —
  versus the slower, flakier fallback engine it had been stuck on.

## Why it matters
Pi being permanently off meant we were stuck on slower engines that kept jamming
up — which is what made replies go quiet. Turning Pi back on restores the fast,
reliable path and gives us a real fallback option instead of a single point of
failure.
