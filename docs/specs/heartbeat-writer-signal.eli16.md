# ELI16 — The "I'm alive" file can't take the machine down anymore

## The problem

When Echo runs on two machines, the one in charge writes a tiny "I'm alive"
file every 2 minutes so the other machine knows not to take over. The audit
flagged this writer as "fails silently." Reading the actual code showed
something worse: a failed write didn't fail silently — it threw an error that
**crashed the whole server**. A full disk or a permissions hiccup at the wrong
moment would take down the machine that was actively serving you, every 2
minutes, until the disk recovered. And during a takeover, a failed first write
left the machine half-promoted: marked as "in charge" everywhere, but with the
alive-file writer never actually started.

## The fix

Three situations, three right answers:

1. **The every-2-minutes write** now catches failures: one log line when writes
   start failing, one health-log note if it's still failing after 6 minutes
   (deliberately before the ~15-minute point where the other machine would
   assume death and take over), one line on recovery. It never stops trying —
   this writer is the machine's voice, and persistence is the point.
2. **Taking charge** is now all-or-nothing: if the very first "I'm alive" write
   fails during a takeover, the takeover is cleanly cancelled and rolled back —
   a machine that can't announce itself doesn't get to silently lead. (This one
   came from the independent reviewer, who caught my first draft letting a
   voiceless takeover complete.)
3. The reusable one-note-per-outage logic got extracted into a small shared
   piece — it's the same shape we've now shipped four times tonight, so future
   loops stop re-inventing it.

Bonus: the test suite caught a real bug before shipping — the "no outage"
marker collided with an outage starting at exactly time zero. Same class of
bug as an old hard-won lesson ("zero is a real value, not an empty one").

## What changes for you

A disk hiccup can no longer crash the machine that's serving you, takeovers
can't half-complete, and a machine whose alive-signal is failing tells you
within 6 minutes instead of letting the other machine discover it by surprise.
