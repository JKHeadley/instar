# Review stops when it stops changing the build — the plain-English version

Justin asked for one feature, a Telegram topic for each paired agent. A 24-hour run turned it into 28 tasks, ran 18 review rounds, took 9 tries to commit, and added 13 problems it found along the way to its own to-do list. Fourteen hours in, the feature still wasn't built.

The cause was in the instructions the agent follows. The review skill said a smaller number of findings is not "done": only zero findings is. A careful reviewer can always find something to polish, so review rarely ended. Every problem found along the way was added to the run. And nothing said "this is a lot of effort for a small change".

Now:
- Review is done when a round finds nothing that would change what gets built. Wording and long-tail points are listed as "left behind" instead of being worked on. Small changes get at most 3 rounds, large ones 6.
- Changes are sized in plain words: small and undoable by a revert gets a short spec, one review round and targeted tests; the full process is for large, irreversible or security-sensitive changes.
- Problems found along the way are sorted at once: blocks the current work → fix it now; major → its own topic and session, which runs it to completion on its own; anything else → the feedback queue or the improvement queue.
- Reports say how much effort was spent against how big the change was, and say so plainly when it was out of line. That is a note, never a block.

Existing agents get the updated skills on their next update.
