# Autonomous-Session Progress Heartbeat — ELI16 overview (plain English)

> This is the plain-English companion to `autonomous-progress-heartbeat.md`. The technical spec is the appendix.

## What problem this fixes

When the agent is running a long autonomous job, it sometimes goes heads-down for a long stretch — building, fixing tests, running sub-agents — doing real work the whole time, but never sending the operator a message. From the operator's chair, an hour of silence looks exactly like the agent froze or died. That actually happened on 2026-06-16: the agent worked for about an hour straight fixing a pull request, said nothing, and the operator had to ask "did you stall?"

The agent is already *told* to "report progress every ~30 minutes." But that's just a sentence in its instructions, and when it's deep in a task it forgets. Instar's core rule is "Structure beats Willpower" — if a behavior matters, don't rely on the agent remembering it, back it up in code. The REAL fix is still the agent sending its own updates; this feature is just a safety net for when it lapses.

## The trap we had to avoid

Our first idea was a simple timer that every so often posted "Still working — N minutes since my last update." We threw that out. Instar already did a big piece of approved work (HONEST-PROGRESS-MESSAGING) that DELETED exactly that kind of "still on it, nothing new" filler, because a periodic "still working" line carries no real information and just trains the operator to ignore the channel. Re-adding it under a new name would undo that honesty work.

So this feature is redesigned as an honest, rare, observational safety net — not a progress simulator. It does NOT fire on a bare timer. It fires only when BOTH things are true: the operator hasn't heard from the agent in that conversation for a long while (25+ minutes, much longer than the old filler), AND the terminal genuinely shows that its output has CHANGED recently (not just a spinner glyph that a frozen session also shows). One honest caveat: "the output changed recently" only proves the session is ALIVE — it does NOT prove the work is actually getting anywhere (a noisy log loop or a retry storm also makes the output change). That's exactly why the wording is deliberately observational and never claims progress: "I haven't posted here in a while — last observed activity was «whatever the focus was». Message me if you need me." Notice there's no "still working" or "still going" in it — it just reports what was last seen and invites the operator to reach out. The "focus" is treated as untrusted quoted context, not a first-person boast — and it gets scrubbed for secrets/paths and length-capped before it's ever shown.

## What already exists (and why it doesn't cover this)

Instar has three watchers already, but none catches this exact case:
- One watches for sessions that **freeze** (no output at all). Here the agent is busy and producing output — so it correctly stays quiet. It's an "are you stuck?" detector.
- One answers when the **operator sends a message and gets no reply**. Here nobody messaged the agent — it just went quiet on its own. So it never triggers.
- One sends heartbeats for **promises** the agent made — and its "no new output" line is the very filler the honesty work suppressed. A general autonomous job isn't a promise anyway.

## How it can't spam you (the three real brakes)

An earlier draft claimed the existing duplicate-blocker would stop floods. That was wrong: the heartbeat text changes every time (minutes, focus), so the duplicate-blocker never matches it. So there are three REAL brakes instead:
1. It only speaks after a long real gap of silence — and ANY message the agent sends (including its own normal reply) resets that clock, so the net only ever fills a true silence.
2. A per-conversation cooldown: once it speaks, it can't speak again for a good while.
3. A widening backoff plus a hard cap (about 6 lines max per run). A silent-but-working 24-hour job gets a handful of honest check-ins, not fifty.

It also only ever ADDS a line — it never blocks, delays, or rewrites the agent's real messages. If anything is uncertain (can't read history, can't see the screen, the run is mid-move to another machine), it stays silent. And it ships dark: off for the whole fleet, and even on a development agent it starts in "dry run" — it just logs what it *would* have said (using the SAME cooldown, so dry-run isn't a flood either) until we've watched it behave correctly for several days.

## What the reader has to decide

Whether this observational-backstop shape is the right fix (a small watcher that fires rarely, on real silence plus a real recent-output change, with honest liveness-only wording), and whether the dark + dry-run-first rollout is cautious enough before it's ever allowed to message a real person. Everything else — the 25-minute gate, the wording, the secret-scrub, the per-run cap, the multi-machine guards — is decided in the spec, not left open.

## Two honest tradeoffs we're accepting on purpose

- **Across two machines, a rare double-message is possible.** When a job moves from one of the agent's machines to another, the two machines coordinate using a file marker plus a short timer — which isn't bulletproof against clock differences or a crash mid-move. So in a rare case both machines could post the same "haven't posted in a while" line. We accept that because this feature only ever ADDS one gentle observational line, so a rare duplicate is low-harm (two near-identical notes), never a wrong action. The flip side is also accepted: during a handoff there can be a brief extra stretch of silence (about one silence-window) where neither machine speaks — fine, because keeping the actual conversation flowing across a machine move is handled elsewhere, not by this heartbeat. A sturdier cross-machine lock is a future improvement, deliberately out of scope for this first, dark-shipped version.
- **It reads the screen, which is a bit brittle.** The "did the output change?" signal comes from reading the terminal screen — the same approach the existing freeze-watcher already uses, and this feature REUSES that watcher's reading rather than doing its own, so it adds no extra cost. The cleaner long-term design is for the agent to emit proper "I'm alive" signals directly instead of reading the screen — also future work, out of scope for v1.
