# Feedback fixes that fail review — plain-English overview

**What happens today.** When people report problems, Instar's feedback pipeline sorts the reports
and a "builder" writes a fix and opens a pull request for each one worth fixing. Before a fix is
merged, an independent reviewer (a different AI model) checks it. If the reviewer finds serious
problems, the builder writes the reasons on the pull request and then simply waits — for a new
commit, for Justin to approve it anyway, or for someone to close it. None of those ever happens on
its own.

The builder only allows four of its pull requests to be open at once. On 30 October all four had
failed review and were just sitting there, so the builder could not start anything new, while 381
other items waited.

**What changes.**

1. **A failed fix gets 24 hours, then closes itself.** If nothing changes in a day — no new commit,
   no approval from the owner — the builder closes its own failed pull request with a short note
   explaining why. That frees its slot. The day of grace keeps every existing option open: anyone can
   still push a fix, approve it, or merge it by hand during that time.
2. **One more try, starting from what the reviewer said.** The first time an item's fix is closed
   this way, the item goes straight back into the builder's queue, and the next attempt is given the
   reviewer's findings so it can avoid the same mistakes.
3. **If that fails too, it is parked.** After a second failed review, the item waits until new
   reports about the same problem arrive (the same rule the builder already uses for other dead ends),
   so it cannot loop forever.

**What it never touches.** Fixes that passed review, fixes waiting for a code owner's approval, fixes
whose reviewer was simply unavailable, and anything Justin has put on hold or stopped.

**For Justin.** Nothing to do. The builder's action list will now say "this closes on its own at …
and is retried once" instead of asking him to approve, push or close.

**Safety and rollback.** Closing a pull request is reversible (it can be reopened and the branch is
kept), and no item is ever deleted. One setting (grace of 0 hours) turns the closing off.

**What the reader needs to decide.** Nothing.
