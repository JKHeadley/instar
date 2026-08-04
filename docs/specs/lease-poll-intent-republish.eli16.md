# A machine in charge was telling itself it was the standby — plain-English overview

## What this changes, in one sentence

When one agent runs on two machines, exactly one of them is supposed to answer Telegram. The machine in charge was leaving a note for its own messenger saying "you are the standby, do not answer" — and never correcting it once it worked out that it was, in fact, in charge. This change makes it correct that note every time it checks.

## What already exists

Instar runs an agent across more than one machine. To stop both machines answering the same Telegram messages twice, there is a "lease": a numbered badge that exactly one machine holds at a time. The machine holding it is `awake`; the other is `standby`.

The part that actually talks to Telegram is a separate process called the lifeline. It does not hold the badge itself — the server does. So the server writes a small note on disk saying "you should be answering" or "you should not", and the lifeline reads that note and follows it. That note is called the poll intent.

Two safety habits already exist around the note, and both stay exactly as they are:

- At startup, before the server knows whether it holds the badge, it writes the **cautious** answer — "you are the standby, do not answer". That way a leftover note from a previous run can never make a machine start answering when it should not.
- The lifeline **ignores** a note that is too old, or one written by a server process that is no longer running. An ignored note means "no opinion", and the lifeline just keeps doing whatever it was doing.

## What was actually wrong

The server only ever replaced that cautious startup note when its role **changed** — standby becoming awake, or the reverse.

But a machine remembers what it was before it restarted. So a machine that was already in charge, restarts, and is still in charge, never *changes* role. There is no transition. The replacement never happens, and the cautious "you are the standby" note stays on disk permanently — on the machine that genuinely holds the badge.

There is a second, quieter half. Because the note was only rewritten on a change, on a machine whose role was steady the note simply got older and older, until it passed the age limit and the lifeline started ignoring it entirely.

So the note was either wrong or ignored. It was almost never both correct and listened to.

## What this was actually doing to a live agent

This was measured, not theorised. On a two-machine agent, in the same second and at the same badge number, the server reported "this machine is in charge" while the note beside it said "this machine is the standby, do not answer".

Because the feature that makes the lifeline obey the note currently ships switched off, the lifeline ignored it and tried to answer Telegram anyway — while the other machine was already answering. Telegram refuses the second asker. That happened 812 times. After enough refusals the lifeline concluded it was stuck, shut itself down to be restarted, and took the server down with it — 260 times, roughly every ten minutes for eight hours. Every restart also took that agent's dashboard offline.

Switching the feature on made it worse in a different direction: the lifeline then **obeyed** the wrong note and muted the machine that was supposed to be answering.

## The second thing that was wrong, which we only found by testing the real startup

There was a second fault sitting right beside the first, and it would have defeated the fix on its own.

The cautious "you are the standby" note was being written at the **end** of startup — after the code had already worked out whether this machine holds the badge. So it was not standing in for a decision not yet made. It was landing on top of the decision that had just been made, and erasing it.

This one is worth dwelling on because of how it was found. The obvious fix — publish the note every time, not only on a change — passes a test that pokes the function directly. It does **not** fix the machine, because startup immediately overwrites the corrected note. It only showed up because a test was written that runs the real startup sequence end to end. Without that test, this would have shipped green and changed nothing in production.

Both faults are fixed. The cautious note now goes first, where it was always meant to be.

## What is new

The server now writes the note **every time it checks its role**, not only when the role changes; and the cautious startup note is written **before** the role is worked out rather than after. The note therefore always says what the badge actually says, and it stays recent enough for the lifeline to trust.

To avoid writing a file on every single check, an unchanged note is only rewritten every 30 seconds. The lifeline ignores notes older than 90 seconds, so 30 leaves a three-times margin. If the note's contents change — the role flips, or the badge number moves — it is written immediately, without waiting.

## The safeguards, in plain terms

- **The cautious startup note is untouched.** A machine still says "do not answer" before it knows anything.
- **The lifeline's protections are untouched.** It still ignores a note that is too old or written by a dead process.
- **Nothing new gets the power to block anything.** This only fixes the accuracy of a piece of information. The decision to answer or not still belongs to the same code as before, still behind the same off-by-default switch.
- **Everything that only happens on a real role change still only happens on a real role change** — the audit entry, the promote/demote signals, the flap protection. Those were deliberately left where they were.
- **A failed write is retried** on the next check rather than being recorded as done.

## Why this matters beyond the one agent it broke

The plan on record is to switch the "obey the note" behaviour on for every agent, once a live two-machine test proves it works. This was that test, and it failed. Switched on as it stood, every machine that restarted while in charge would have quietly muted its own Telegram — the exact silence the whole feature was built to prevent.

## What you actually need to decide

Whether this fix goes in as written. The change is two functions in one file plus tests. If it turns out wrong, reverting the commit restores the previous behaviour completely — the note is regenerated at runtime, so there is nothing to migrate and no state to repair.

One thing to remember separately: the agent that was broken by this is currently running with a blunt manual setting that tells it never to answer Telegram from that machine. That has to be removed once this fix is deployed, or it will override the corrected behaviour. It is recorded on the attention queue rather than carried in anyone's memory.
