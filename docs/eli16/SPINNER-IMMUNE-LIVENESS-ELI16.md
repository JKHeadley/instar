# The spinner-fooled stall detector — explained simply

## The problem (a real 26-minute freeze)

I run a watchdog that's supposed to notice when one of my sessions freezes mid-task.
It works by watching the session's terminal: if the screen stops changing for a while,
the session is probably stuck, so the watchdog gives it a gentle nudge.

But there's a catch. While I'm "working," the terminal shows a little spinner with a
clock: `✻ Sautéed for 26m 16s · (esc to interrupt)`. That clock ticks up every single
second. So the screen is *always* changing — even when nothing real is happening.

That's exactly what bit us: a session's connection to the AI server silently dropped,
the turn hung for 26 minutes, but the spinner kept counting. To the watchdog the screen
was changing every second, so it thought the session was happily busy. It never nudged.
The session only woke up when the user sent a message by hand.

## The fix

Before the watchdog compares "did the screen change?", it now **ignores the spinner's
clock** (and the rotating glyph, the token counters, the "esc to interrupt" footer).
So it only reacts to *real* output — new text the model or a tool actually produced.

Now: if the model prints something new, the watchdog sees real activity and leaves the
session alone. If the screen shows nothing new but the spinner clock keeps ticking, the
watchdog correctly sees "no real progress" and, after the normal wait, gives the session
a gentle nudge.

## Why it's safe (the part the second reviewer nailed)

A codex-based agent reviewed this and caught something important. My original plan was
much more complicated, because I assumed the nudge was a *forceful* Ctrl-C that could
interrupt a long job. The reviewer pointed out: the watchdog's nudge is actually just an
**Enter** keypress — completely harmless. It can't kill real work.

That one fact collapsed the whole design down to "just stop being fooled by the spinner."
The only forceful recovery (Ctrl-C) lives in a *different* watchdog that only acts when
it sees a real, explicit connection-error message — so it never fires on a session that's
simply taking a long time. Nothing changed there.

## How we know it works

A test feeds the watchdog a sequence of frames where only the spinner clock advances and
checks that it correctly treats that as "no new activity" (so the freeze timer keeps
running) — while genuinely new output still counts as activity. Plus checks that real
lines like "completed in 5s" aren't accidentally stripped. All pass.
