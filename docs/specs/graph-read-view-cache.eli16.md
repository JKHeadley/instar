# Conversations answers fast, and one slow machine no longer freezes it (plain overview)

**What happened.** On 2026-11-16 Justin tried Accept all on the Conversations page again and said it felt "buggy and sluggish". Every Conversations screen on the Studio took 3 to 9 seconds to answer, and while it worked the whole Studio server stood still.

**Why, part 1.** Your agent keeps a signed, checked history of how conversations are organised. To answer any Conversations screen, it re-read and re-checked that entire history four times, every time, even when nothing had changed. Looking up each effort's name did it again.

**Why, part 2.** We ran a real Accept all on two test machines and froze one of them for 45 seconds. The other one stopped answering Conversations for about 7 minutes. Every request was quietly waiting for the frozen machine to reply to a "do you have everything?" message it did not need an answer to.

**What changes.**
- The checked history is built once and reused until something in it actually changes (a new change, a message from the other machine, a removal, or 15 seconds passing). Answers come back in a fraction of a second.
- The "do you have everything?" message to the other machines now goes out in the background. Your request no longer waits for it.
- A leftover copy of an already-saved record no longer blocks every later change.

**Why, part 3.** While one machine was frozen, the other one took over for a moment and kept its own copy of a record the first one had already saved. Afterwards the two machines could never agree on their history, so every new change waited forever ("Saved here. Waiting for … to confirm"). Now that leftover copy is recognised as already saved and ignored.

**What stays the same.** Every record is still checked when the history is built. Saving a change still waits until every machine has it. Removing something still takes effect at once.

**Decision needed.** None: a code change that a revert fully undoes.

(A follow-up commit only labels an existing error check as reported, for the code audit; nothing you see changes.)
