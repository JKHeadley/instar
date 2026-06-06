# Moving a conversation finally moves its desk too (P2)

Until now, when one of my conversations moved from the Laptop to the Mini, it was like an employee changing offices but leaving every paper on the old desk: the chat continued, but the working files — the overnight analysis, the run's notes — stayed behind. That's exactly what bit us in the EXO incident. P1 made the files FINDABLE; this phase makes them FOLLOW.

How it works, plainly: each machine can compute, on demand, "what files make up this conversation's workspace" — from durable evidence (the run's own file, anything matching the topic's file-naming convention, and every path the diary recorded), never from anyone remembering to declare anything. When a conversation moves, the receiving machine asks the machines that actually produced the work — not just the last owner, who may have produced nothing — "send me that workspace." Files travel in small one-megabyte slices (the review caught that my draft's single 32MB response would have re-created this laptop's famous freeze-under-load incident), each slice fingerprint-checked, the whole file verified before a single byte lands in place.

The review round earned its keep on this one — the biggest catches, all now in the design:

- **The asleep-machine case — the actual EXO failure — is now solved, not retried-then-abandoned.** If the machine holding the files is offline (or was wrongly evicted from the mesh, like the Mini was for ten hours), the request is written down durably and fires automatically the moment that machine comes back. It survives restarts. After a week unrecovered, you get one honest notice instead of eternal silence.
- **Files containing pasted secrets don't travel.** The category being "working files" doesn't make the contents safe — every file's actual bytes are scanned for credential shapes before serving; flagged files are refused out loud, never silently shipped or silently skipped.
- **A still-running job's file isn't snapshotted mid-sentence.** If the run is live, its file is marked "still being written" and the fetch fires when the run finishes.
- **Nothing is ever overwritten, and nothing can be deleted.** A genuinely different local version gets the incoming copy saved ALONGSIDE it (capped at two, identical arrivals collapse to one) plus one calm notice — real divergence gets seen, not coin-flipped.
- **Rapid back-and-forth moves can't corrupt anything**: only the CURRENT owner's fetch ever writes, one fetch per topic at a time, and a fetch superseded by a newer move aborts quietly.

Round two of review caught three more, now also designed in:

- **A returning machine isn't mobbed.** If the Mini wakes up holding files for ten conversations, the fetches line up single-file behind each other instead of all ten slamming a machine that's still booting.
- **A file changing mid-transfer can't produce a Frankenstein copy.** Each slice carries a fingerprint of the whole file it was cut from; if that changes mid-transfer, the fetch starts the file over (three tries, then one honest "this file won't sit still" note — never an infinite loop).
- **The "files I still owe you" notebook can't lose entries.** All six things that write to it go through one single-file line (the exact lost-update race that caused a notification flood last week), and if the notebook is ever corrupted you get one notice — it's never silently read as empty.
- **Honesty about the secret scan**: it catches things SHAPED like keys and tokens, not every possible secret in prose. That's acceptable only because both machines are yours — and the design says so out loud instead of overclaiming.

Also riding along, earned the hard way: the mesh-health guard. A machine that's been improperly evicted (a revocation with no who-or-why recorded — exactly what happened to the Mini) gets flagged the moment it's seen; a machine that should be in the pool but has gone missing for half an hour produces one calm notice naming it AND naming any stranded workspaces sitting on it. Flapping machines get one "it's flapping" notice, not a stream.

And the ask-me-anytime move: if you mention work this machine can't find, I can trigger the fetch reflex — "who made artifacts for this topic? go get them" — the EXO failure as a one-call recovery.

Activates only where machine-to-machine diary sync is already on (your Laptop+Mini pair today; dark everywhere else). The build starts after this spec finishes the four-round review gauntlet, under your standing 24-hour directive.

**Live-proof amendment (2026-06-06):** the first live run caught a gap — a conversation that just MOVED but hasn't received a message yet technically has "no owner" recorded, and the fetch refused to run for it. Fixed: the machine the conversation was deliberately moved TO counts as its home until real traffic says otherwise.

**Second live-proof amendment (2026-06-06):** the first amendment's fix turned out to be half-blind — the "this conversation was deliberately moved here" note is kept by the machine that DID the moving, not the machine it moved TO. The receiving machine now also accepts the moving machine's diary entry (which it already receives) as proof it's the home, so the fetch finally works from the machine that actually needs the files.
(Amendment 2 also fixes the sibling listening bug: machines announced their promise-list versions on every heartbeat, but the listener's parsing discarded the field — so no promise ever actually replicated. One pass-through line.)
