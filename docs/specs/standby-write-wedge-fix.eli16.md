# Standby-Write Wedge Fix — ELI16

## What is this?

On a setup with more than one machine, one of your agent's machines is "awake" (serving) and the
other is on "standby." A bug made the standby machine freeze completely — not answer ANYTHING,
not even a basic health check — for tens of seconds whenever it recorded a self-improvement action
item (or a lesson). The freeze was long enough that the machine's own supervisor decided the
process was dead and killed-and-restarted it. Anyone messaging that machine during the freeze got
silence, then a fresh restart.

## Why did it freeze?

The agent keeps a shared, cross-machine log so a lesson or a to-do learned on one machine is known
on the others. Every time it saved an action item, it did something wasteful: it re-announced
**every** action it had **ever** kept — not just the one that changed — into that shared log. And
each re-announcement re-read the **entire** shared log from disk to figure out its place in the
ordering.

That is fine with a handful of items. But it fed itself into a doom loop: re-announcing everything
made the log bigger, and a bigger log made the next save slower, which made the log bigger still.
On a real agent the log had grown to ~53 MB and held 61,000 entries for only 632 real items — each
item had been re-announced about 112 times. With ~1,200 action items to re-announce, ONE save
became tens of gigabytes of reading from disk, all at once, all on the single thread the whole
server runs on. That is the freeze.

It looked like it "only happened on standby" partly by coincidence: the standby machine happened to
be the one holding the giant queue and the giant log, and the freeze also showed up as random
periodic hangs whenever a background job quietly added an action in the background.

## How is it fixed?

The save now re-announces **only the items whose content actually changed** since it last announced
them, instead of all of them. It remembers a tiny fingerprint of each item; on the next save, an
unchanged item is skipped, and a changed one (say, a to-do that just got marked "completed") is
announced exactly once. The important guarantee is preserved: when an item genuinely changes, the
other machines still see the new state — so a peer still learns that a task was already finished and
doesn't redo it. What's gone is the pointless repetition that caused both the freeze and the runaway
log growth.

It also remembers, right when it starts up, which items were already announced by the previous run —
so the very first save after a restart doesn't accidentally re-announce everything one more time.

## What does this change for me?

Nothing to turn on or configure. The standby machine stops freezing on these writes, the shared log
stops ballooning, and your messages to it stop getting swallowed by a 30-second hang. Everything the
cross-machine sharing did before, it still does — just without the wasteful repetition.
