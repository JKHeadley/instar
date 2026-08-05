# Plain-English overview — putting a ceiling on the messages your agent sends you

## The thing that happened

You said the attention messages had become unmanageable across pretty much every agent, and that we needed to lock it down. So the first job was to find out whether that was a feeling or a number.

It is a number. In twenty-four hours, one agent sent sixty-four messages into its attention topic. Twenty-five of those said nothing you could act on — things like "one of my checks is running on its simpler backup path", "memory is getting tight", "everything else is working fine". A second agent, doing completely different work, sent sixty-five with thirty-three of the same kind. Two agents, same proportions, which means the behaviour lives in the code they share rather than in anything either of them did.

## What is actually generating it

Underneath, this machine is out of memory. Swap is at 18.8GB of 20.5GB. There are three agent servers running alongside a browser and a pile of sessions — no single culprit, just too much at once.

When memory is that tight, the agent's small internal checks — the background things that read a message and decide whether it needs attention — cannot get the resources they need, so they fall back to a simpler way of working and carry on. Every time that happens, the agent writes it down. Today it wrote it down 781 times.

Most of that never reached you. The filtering already in place removed about 97 percent of it. What you have been seeing is the 3 percent that leaks through.

## Why the leak is the real problem

Here is the part that matters more than the count. **The noise scales with how badly things are going.** The worse the machine gets, the more your agent tells you about it — and the messages it sends under stress are precisely the ones with nothing in them for you to do. That is backwards. A struggling system should get quieter with you, not louder, and save your attention for the thing you can actually decide.

Right now nothing stops it. There is a hard limit on how many new *topics* the agent may create on its own, added after an earlier flood. Nobody ever added the equivalent limit for *messages* into a topic that already exists. I checked for one under seven different names, across five different places, with a control test proving the search was reading the right code.

Two smaller things make it worse. The agent's memory of "I already told them this" is held only while it is running, so every restart forgets and the same notices come round again. And there is an off-switch on this machinery that three other parts of the code read and obey — but this particular path skips it, so it looks like a working lever and is not one.

## What this change does

Four things, all in the shared code so every agent gets them.

**One. The housekeeping stops reaching you by default.** It is still written down, still kept, and I can read any of it back whenever you ask. You just stop receiving it unprompted. This is the biggest single cut and it is the one real decision in here — see below.

**Two. A limit on messages per hour, per conversation.** Four by default, counted over a rolling hour. Past that, the rest wait their turn and send themselves as soon as there is room. Nothing is thrown away, and you are not told about the waiting — being told would be one more message you cannot act on, which is the thing we are removing.

There is a wrinkle worth one paragraph, because getting it wrong is what took most of the review. If you run me on more than one machine, a limit that each machine enforces on its own is not really a limit — two machines each sending four an hour means you get eight. I tried three times to fix that by having each machine work out its own fair share, and each attempt was cleverer than the last while the list of things that could still go wrong got longer. That was the tell. You cannot get an exact shared limit out of machines guessing independently.

The answer was to stop sharing. Every conversation already has exactly one machine that owns it — that is how I avoid two machines answering you at once. So only the owning machine sends routine notices into a conversation. One machine counting, one limit, no guessing. Urgent messages are deliberately outside this: any machine can always reach you.

**Three. The "I already told them" memory gets written to disk,** so restarting no longer re-opens the floodgates.

**Four. The off-switch is made real on this path,** so next time this needs adjusting it is a setting rather than a code change and a release.

## What does not change

Urgent messages are untouched. Anything marked as needing you *now* — quota exhausted, a session genuinely stuck — bypasses all four of these and reaches you immediately. The ceiling does not count it and cannot hold it.

Real attention items are untouched. If I raise something that needs your decision, it arrives exactly as it does today.

And if a degradation is genuinely affecting you, it still reaches you — through the attention queue and the urgent path, both of which this leaves alone. What goes quiet is the routine "fell back, still working" report, not your ability to find out something broke.

## The decision you already made

Should housekeeping be **silent by default for every agent**, or **on by default with only the hourly limit**?

You answered **silent** on 4 August. That is what the proposal now specifies. Everything measured supported it — none of the sampled housekeeping was actionable, all of it stays recorded and readable on request, and the alternative would have left you opted in to noise by inertia.

## If it turns out wrong

Every part of this is reversible with a setting, with no data to migrate and nothing to repair. Turn the housekeeping back on, set the ceiling to zero to remove it, delete one file to drop the saved memory. The whole change is a single commit that can be backed out.

## What this does not fix

The memory squeeze that generates the events in the first place. That is real, it is a capacity problem rather than a bug, and it deserves its own decision — three agent servers on one laptop is the shape of it. This change stops the squeeze from shouting at you; it does not end the squeeze.
