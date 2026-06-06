# Your promises follow you between machines (P1.5) — round 2

The review round earned its keep: the biggest catch was that my promise IDs are just counters — BOTH machines mint "CMT-007" for different promises, so merging lists by ID would have silently hidden real obligations (the exact bug this fixes). Every cross-machine reference now uses machine+ID together. Also caught: a restored-from-backup machine would have silently stopped sharing forever (fixed with the same "new diary" token the journal uses); a stuck "closing…" label that nothing could ever clear (now computed live, vanishes the moment the request resolves); and big promise lists now page across multiple small messages instead of one capped blob that would have permanently hidden the tail.



Right now, each of my machines keeps its own private list of the promises I've made you. Ask the Mini "what are your open commitments?" and it honestly doesn't know about anything I promised from the Laptop — I under-report my own obligations. Worse: tell the Mini "mark that done" for a promise made on the Laptop, and it can't.

P1.5 makes it ONE list, seen and closeable from anywhere, without inventing any clever merge machinery:

- **Every promise has exactly one home machine** — the one that created it. That machine's copy is always the truth.
- **Reading**: each machine shares its own list with the others on the same 30-second rhythm the coherence diary already uses. Ask any machine and you get the merged picture, with honest labels — a copy from another machine says so, and says how fresh it is ("as of 2 minutes ago, from the Laptop"), never pretending to be live truth.
- **Closing**: "mark it delivered" on the wrong machine quietly forwards the request to the promise's home machine, which applies it through the exact same rules as a local close — the network adds reach, not authority. You get the real verdict back immediately.
- **The asleep-machine case** (the same EXO shape P2 just solved for files): if the home machine is offline, your "mark it done" is written down durably, you're told honestly ("queued — it applies the moment the Laptop is back"), and it fires automatically on its return — surviving restarts in between. The merged list shows the close as in-flight, not a stale "open".
- **No new switches**: it rides the same single machine-to-machine sync gate as the diary and the file handoff — your Laptop+Mini pair today, dark everywhere else.

Deliberately NOT in this phase: the heartbeat reminders for a promise stay on its home machine (a sleeping machine's reminders pause until it wakes — closing still works from anywhere). If that pause turns out to hurt in practice, transferring reminder duty is the named follow-up.

**Build status:** the "seeing" half (P1.5a) is built and tested — every machine can now list every machine's promises with honest freshness labels. The "closing from anywhere" half (P1.5b: forwarding + the durable queue) is next.
