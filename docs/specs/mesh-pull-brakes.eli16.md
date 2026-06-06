# ELI16 — Brakes for the machine-to-machine "who's in charge" checker

## The problem

When Echo runs on two machines, each machine asks the other every ~5 seconds
"who currently holds the wheel?" That fast checking is deliberate — it's how a
machine notices quickly that its partner vanished or came back. But two brakes
were missing:

1. **It was a chatterbox about failure.** Every single failed check wrote a log
   line. With the other machine down, that's about 17,000 identical lines per
   day — the same kind of log flood the session reaper produced before we fixed
   it. Meanwhile a machine that actively REFUSED our checks (rather than being
   unreachable) was logged… not at all. Loud about the boring thing, silent
   about the interesting one.
2. **One stuck connection could break it forever.** The checker refuses to
   start a new check while one is still running (sensible). But its network
   calls had no time limit — so a single connection that hung without erroring
   would block every future check, permanently and silently.

## The fix

1. **Log state changes, not attempts.** One line when a machine becomes
   unreachable, a brief reminder every ~30 minutes with the running count, and
   one line when it recovers. A full day of failures now produces ~49 lines
   instead of 17,280. Refusals get the same treatment — visible, but bounded.
2. **Every network call gets a 30-second time limit** so a hung connection
   aborts instead of wedging the checker.

Worth highlighting: the first draft used a 10-second limit, and the independent
reviewer caught that being too aggressive — this fleet's machines sometimes
freeze for 5–40 seconds under load (the exact bug we fixed earlier today), and
a 10s cutoff would have mislabeled a slow-but-alive machine as unreachable,
potentially making a perfectly healthy machine step down from holding the
wheel. The limit shipped at 30 seconds, tied to the lease settings, so the
brake stops hung connections without punishing slow ones.

## What changes for you

Cleaner logs, one fewer way for the two-machine setup to silently break, and —
because of the reviewer's catch — no new way for a healthy machine to wrongly
demote itself.
