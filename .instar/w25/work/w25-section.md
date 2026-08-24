## Current work — Window 25: CONVERSION (opened Aug 23, ~1:55pm, your "yes, go")

**What it is for.** Every window so far has ended better *understood*. This one has to end healthier. Twenty-one finished repairs from Window 24 are sitting on branches nobody merged, and the running system is on the old code for all of them. The bottleneck has moved: it is no longer knowing what to fix, it is that finished work never reaches the machine you actually use.

**What it does.** Take the named repairs, assemble them into one release rather than merging them one at a time, run the full test suite against the combined result, review what the configuration and migrations do to each other, deploy under supervision, and then check each repair at the place *you* would notice it rather than where it was written.

**Two things must be fixed before anything ships.** First, the emergency stop that deletes an agent's working record instead of merely stopping it — it destroyed two large records in a single day, and it destroys exactly the evidence needed to prove a conversion worked. Stopping and deleting become separate actions. Second, an exact count of which safety hooks are actually loaded inside each running session, not which ones sit on disk.

**One repair will not ship, deliberately.** The change that narrowed what "delivered" means reverses the decision you already ruled on. It is recorded as rejected with its reason rather than quietly dropped, and the proper version — keeping "you were shown it" and "the asking system picked it up" as two separate facts — stays future design work until you name it in.

**How it closes.** Every named repair either verified live or carrying a written reason it is not; a clean full test run on what was actually deployed; and this page carrying the result. If it manages only that, it is the first window whose product is a healthier system rather than a better-understood one.

