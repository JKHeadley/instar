# Per-Target Backup-Route Deadline — Plain-English Overview

## What this is

When the agent needs an AI model to make a quick safety decision (like "is this message an emergency stop?") and its first-choice tool fails, it tries a *backup* tool instead. To avoid getting stuck, each backup attempt has a deadline — a stopwatch that kills the attempt if it takes too long. Right now that deadline is a single number (5 seconds) applied to *every* backup tool the same way.

## The problem

Different AI tools answer at very different speeds. We measured them: Claude answers in about 3 seconds, pi in about 4.6 seconds, gemini in about 8.5 seconds, and codex in about 18 seconds (sometimes much longer). The one-size-fits-all 5-second deadline is *shorter than gemini's normal answer time*. So whenever gemini is used as a backup, it gets killed at 5 seconds — before it ever had a chance to answer. It just wastes 5 seconds and then fails. In practice, gemini as a backup route is broken: it can almost never succeed, no matter how healthy it is.

## The fix

Instead of one shared 5-second deadline, let each tool have its *own* deadline that matches how fast it actually is — gemini gets ~18 seconds, the fast tools keep their short deadlines. That way a backup attempt gets a fair chance to answer, and we stop throwing away time on attempts we killed too early.

## What changes for the operator

Nothing, unless you turn it on. This ships "dark": by default the behavior is exactly the same as today (the single 5-second deadline for everyone). The new per-tool deadlines are an optional setting you can switch on when you want. If you ever want to undo it, you just delete the setting and it snaps back to the old behavior instantly. Nothing is forced live.

## Why it's safe

The change is tiny and additive — it only adds a new optional setting and moves where the deadline is looked up (so it can be per-tool). It doesn't touch which calls use a backup, doesn't add any new "block this" powers, and keeps the same crash-safe pattern that was already there. The total time a chain of backups can take is still bounded. And because it ships off by default, there's zero risk to the running agent until someone deliberately sets the new values.

## The tradeoff

With per-tool deadlines set, a backup chain's worst-case time can be a little longer than the old flat 5-seconds-each — because we're now *willing to wait* for a slower tool that can actually succeed, instead of killing it early and falling through to nothing. That's the point: a backup that succeeds in 9 seconds beats one that "fails fast" in 5 and leaves the agent with no answer at all.
