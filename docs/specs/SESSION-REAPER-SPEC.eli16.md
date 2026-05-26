# SessionReaper — the plain-English version

## The problem, in one picture

Think of your computer like a kitchen, and each agent "session" like a chef standing at a station. A chef who's cooking needs their station. But sometimes a chef finishes, sets down their knife, and just... stands there. Idle. Still taking up a station.

The other day, 51 chefs were crammed into the kitchen — most just standing around doing nothing — and the kitchen ran out of room. When a new order came in (a message from another agent), there was no free station, so nobody could start cooking it. The message arrived; no chef could pick it up. It *looked* like the order system was broken. It wasn't. The kitchen was just full of chefs doing nothing.

I cleared out 42 idle chefs, and instantly the next order got cooked.

## Why didn't we already clean those up?

We *do* sweep out chefs who collapsed (crashed). And we have a rule that says "if a chef has been standing idle for a while, send them home." But that rule kept failing for four sneaky reasons:

1. **The timer kept resetting.** The "how long have you been idle" stopwatch lived only in the kitchen manager's head. Every time the manager got knocked out and woke back up (the server was crash-looping that day), the stopwatch reset to zero. So a chef idle for two days never *looked* idle for more than a few minutes.
2. **We only recognized one "idle pose."** The rule checked if a chef was standing in one specific way. A chef idle in any *other* pose was mistaken for "busy" and never sent home.
3. **We never looked at how full the kitchen was.** The rule was purely about time, never about whether we actually needed the space.
4. **Each manager only watched their own chefs.** Nobody was counting the whole kitchen.

## What I want to build

A **SessionReaper** — a quiet helper that sends idle chefs home, but *only when the kitchen actually needs the room*, and **never, ever sends home a chef who's actually cooking.**

That last part is the whole point. You told me to focus hard on never reaping a session that's working, and that's what the design is built around.

## How it refuses to make a mistake

My first draft had this backwards, and the review caught it. I'd planned to check three things — is anything cooking on their stove, does their screen say "working", is their notebook still being written in — and send a chef home only if all three looked quiet.

The problem: **a chef who's just standing there thinking looks exactly like a chef who's done.** When the kitchen sends an order out to a supplier and waits for the phone to ring back, nothing's cooking, the screen isn't changing, and nothing's being written — but that chef is absolutely still working. So "everything looks quiet" is *not* proof that someone's idle.

So we flipped the whole rule. Now it doesn't send a chef home for *looking* quiet. It only acts when it can **positively confirm the chef finished their dish and is parked at the counter waiting for the next order** — and even then, only if their screen hasn't changed by a single pixel across several checks spread over ten-plus minutes (a thinking chef's screen always twitches; a truly-waiting one is frozen). **And the golden rule: if it can't tell for sure — wrong kind of chef it doesn't recognize, can't find their notebook, anything unclear — it leaves them alone.** Uncertainty always means "keep," never "kill."

On top of that there's still the long "hands off" list: waiting on you mid-conversation, made a promise they haven't kept, has a helper working, mid-build, just started. Any single reason to keep them wins.

It also won't act on a single glance — it has to see a chef idle several times over at least ten minutes. And it can only send home a few chefs at a time, so even if it somehow got confused, it can't clear the whole kitchen.

## The clever bits

- **The stopwatch now lives on paper, not in the manager's head** — so a crash can't reset it anymore (but if it sees the chef actually wrote in their notebook while the manager was out, it throws the old time away and starts fresh — no reaping on stale info).
- **It mostly sleeps.** When the kitchen has room, it does almost nothing. It only gets busy exactly when the kitchen is filling up — which is the only time the pileup actually hurts.
- **It starts in "watch only" mode.** For the first while it just writes down *who it would have sent home*, without sending anyone home, so we can check it's only ever flagging genuinely-idle chefs before we let it act for real.

## What you'd notice

Honestly, almost nothing — and that's the goal. Your agents stop fainting when the machine gets crowded, cross-agent messages stop mysteriously failing, and you don't have to manually clear out stale sessions like I did the other day. If you ever wonder "why is/isn't it cleaning up that session?", there's a page that shows every session and the exact reason it was kept or flagged.

## Where this is in the process

This is now a **converged draft spec**, not code. I ran it through a three-way review — a different AI model (GPT) plus two deep passes that read the actual instar source code. All three independently caught the same big flaw (the "looks quiet = idle" mistake above) and a pile of smaller ones, and the spec has been rewritten to fix every one. Per our rule, nothing gets built until you sign off on this converged version. Everything the review changed made the reaper *more* cautious, never less.
