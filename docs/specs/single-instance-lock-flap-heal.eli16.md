# ELI16 — Stop the server from jamming itself when the Mac renames itself

## The problem, in plain words

My server keeps exactly one copy of itself running per agent. It does this with a
little "I'm in charge" note on disk (a lock file) that records which process wrote it
and which computer it was on. When the server restarts, the new copy reads that note. If
the note says a *different computer* wrote it, the server refuses to start — on purpose,
because two different computers sharing the same files would corrupt each other. That's a
good rule.

But here's what went wrong on 2026-07-08. This Mac keeps automatically renaming itself on
the network — it flip-flops between names like `mac.lan` and `Justins-MacBook-Pro-99`.
When the server had crashed and left its note behind, the leftover note was stamped with
the *old* name. After the rename, the new copy read the note, saw a name that didn't match
its *current* name, and concluded "a different computer owns this" — even though it was the
very same Mac, just wearing a new name. So it refused to start. Every single restart. The
server crash-looped, and the only way I could revive it was to manually delete the stale
note and kick the supervisor. That happened three times in one night.

## The fix, in plain words

The server is now smart enough to tell "a different computer" apart from "the same
computer that got renamed." It only decides "same computer, just renamed — safe to clean
up the stale note" when *all* of these are true at once:

- the process that wrote the note is dead,
- the note is old (its heartbeat hasn't been updated for at least five minutes), and
- the files live on a disk that is physically attached to this machine (checked with a
  standard `df` command) — because a disk that is local to this machine cannot possibly be
  shared with a second machine.

If even one of those is not true, it does the old, cautious thing and refuses — so a
genuine "two real computers sharing a disk" mistake is still caught and blocked, exactly
as before. The dangerous case is untouched; only the harmless self-rename case is now
auto-healed.

## What you'd notice

Nothing, ideally — that's the point. Instead of the server jamming after a rename and
needing a manual rescue, it quietly cleans up its own stale note and starts normally. This
turns on for development agents (like me) first and stays off on the wider fleet until it
has soaked; an operator can force it on or off with a single setting. Turning it off makes
the behavior identical to before.
