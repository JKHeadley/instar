# Lease flap fix: the plain version

## What went wrong

When an agent runs on two machines, exactly one of them is "in charge" at a
time. Instar settles this with a lease: a signed note saying "machine A is in
charge for the next minute", which A keeps renewing. The other machine waits as a
backup and takes over only if A really stops.

On 3 October a laptop and a Mac Studio were paired for the same agent. About
twenty minutes later they began taking charge from each other every few
seconds. While they fought, the agent's Telegram messages were held, because a
machine that is not clearly in charge is not allowed to speak.

## Why it happened

Two faults fed each other.

1. **A frozen clock said the other machine was dead.** Each machine decided
   whether the other was alive from a timestamp in a shared file. That file is
   deliberately kept out of git in this agent, so the timestamp never moved.
   After fifteen minutes each machine decided the other had died, even though
   both were hearing from each other over the network the whole time.
2. **A failed write was read back as a real one.** The laptop keeps the lease in
   a local file. The Mac Studio, set up fresh when it joined, tried to keep it in
   that same out-of-git file, so every write it made went nowhere, silently. When
   a write failed, it re-read its own unsent claim and believed it now held the
   lease.

## What changes

- **"Is the other machine alive?" uses live evidence only.** Instar stops trusting
  the old timestamp on every kind of setup. A machine counts as alive if this one
  has recently heard from it directly over the network, or has seen its signed
  "I'm still in charge" renewals. If it has never heard from it at all, it treats
  it as unknown, not dead, and only takes over once the other machine's lease
  actually runs out.
- **Both machines keep the lease the same way.** If the shared file is kept out
  of git, every machine uses a local file plus the network, exactly as the laptop
  already does. Instar reports this once, instead of failing silently.
- **A restart no longer hands the lease away.** After a restart the machine in
  charge used to start counting its "I'm still in charge" messages from zero
  again. The other machine remembered the old, higher count and ignored them,
  so about a minute later it took over from a perfectly healthy machine. The
  count now starts from the clock, so it is always higher than before the
  restart. The live test caught this; it happened on every restart.
- **Quiet warnings** appear in Instar's internal log when lease writes keep
  failing, or when a paired machine has never been heard from.

## What does not change

- A machine that really dies is still replaced. Its lease runs out within about a
  minute, and that lets the backup take over.
- When a backup machine first starts, it can think it is in charge for a few
  seconds before it hears from the other machine and steps back. Both could reply
  to the same message once in that window. This already happens today. It is
  what the Mac Studio did when it first started on 3 October, and it fixed itself.
- When the machine in charge cannot reach its partner (for example the laptop
  lid is closed), it only stays in charge about half the time, dropping out and
  back in repeatedly. Replies are held in the gaps. This already
  happens today and this fix does not change it. Instar has a backup setting
  for this case, switched off today. This fix makes that setting slower to kick
  in, so the follow-up change has to cover it properly; switching this part of
  the fix off restores today's timing, along with the original fault. It matters
  most for using the Mac Studio while the laptop sleeps, so it is the next thing
  to fix, as its own change.
- If both machines start at the same moment, both may act as in charge for a few
  seconds before they settle on one.
- If the two machines lose touch with each other completely, each may still act
  as in charge until they reconnect, and then they settle on one.
- Each part of the fix has its own off switch, so any part can be undone without
  a new release. But undoing either of the two main parts, or going back to the
  previous release, brings back part of the original fault. So the undo steps
  are: stop the backup machine and keep it stopped, remove it from the pairing
  (stopping alone is not enough, and removing it while it still runs is worse),
  then switch off or go back. The agent then
  runs on one machine, as it does today, until a fixed version is ready.
- Nothing needs cleaning up on the Mac Studio. The stray claim it wrote sits in a
  file the new setup no longer reads.

## What is left for later, with Echo

These are written up and passed to Echo, Instar's maintainer, to design properly. They are tracked together as one commitment (CMT-1226), with a report back within two weeks of the fix landing:

- Making a newly started machine ask before it claims, which closes the
  few-second window above. A first attempt here turned out to need careful
  design: in one version, a restart could leave nobody in charge for a few
  minutes.
- A warning for one rare git failure that can leave a machine in charge on a lease
  git never accepted. In normal running it can only happen when the shared file
  is tracked in git and a write fails, or when the check that picks the lease
  store fails, which is not this agent's setup (the
  undo steps above are the exception).
- Three rarer weaknesses in how Instar writes the lease to git when the file is
  tracked.

## What you are deciding

Whether to approve this fix for Instar. Before merging, I prove it on two
throwaway test agents that talk through a separate demo Telegram group and a demo
Slack channel, never your real chats. I set up the Telegram side myself through
the Telegram profile you set up for me, and the Slack side too, unless the
workspace needs an admin to approve a new app, in which case I'll ask for that up
front.

Two sign-offs come with the approval. One is to agree that staying reachable
matters more than a strict single machine in charge: if the machines lose touch
completely, and for the few seconds of overlap at startup and restart described
above. The other is to agree that the three rarer git weaknesses go to Echo,
reported back within two weeks. (Handing Echo the warning and the
ask-before-claiming work was already agreed on 3 October.)

After it lands and both machines run it, the Mac Studio is paired again as a
quiet backup and watched for half an hour to prove it stays steady. The Roblox
topic moves onto it only after the separate fix that keeps the Mac Studio
steadily in charge while the laptop sleeps.
