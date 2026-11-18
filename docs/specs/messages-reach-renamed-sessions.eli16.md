# ELI16: messages between an agent's own sessions reach the right one, on any machine, and the sender hears if they don't

## What goes wrong today

One agent runs many sessions at once: one merges code, one is the Chief of Staff, one looks after the machines, and so on. They hand work to each other with short internal messages, addressed by the session's name. Three things break that.

**Names change.** When a session restarts, or the machine reboots, it can come back as "echo-echo-machine-stewardship" instead of "echo-machine-stewardship", or as "echo-topic-144503". A message to the old name is marked failed and never typed into anything. The sender only learns this from a reply most scripts never read. On the night of Nov 17, a 10-item report about machine access was lost this way and only found later in the failed-messages folder. The next morning, two Chief of Staff instructions to the Mac app session were lost the same way.

**Messages between machines never worked.** A message from a session on the Studio to a session on the M5 is sent to an old web address that the M5 stopped answering in August. It has been reported as "machine unreachable" ever since, even though the M5 was fine. Even when it did arrive, the receiving machine only filed it and never typed it into the session. The failures piled up in a folder nothing ever reads: 112 messages on the Studio, the oldest from Nov 6.

**The sending machine retries into the wrong place.** Its own copy of a failed cross-machine message stays "waiting", so it keeps retrying it into a local session with the same name.

## What changes

1. **A message finds the session holding that job now.** If no session has the exact name, the agent looks for the one doing the same job: the same name without the doubled prefix, or the session now serving the same conversation (topic). It delivers only when exactly one session fits. If two could fit, it refuses and names both. It never looks at another agent's sessions. It never types a message into a session that started after the message was written: a brand-new session wouldn't know what the message is about. Between machines it plays safe with the clocks: a session that started up to 10 minutes before the message was sent can be refused too, and the sender is told so it can resend.
2. **Retries stick to one session.** Once a message is aimed at a session, every retry goes to that same session. If that session has been replaced by a new one under the same name, the retry stops and the sender is told.
3. **Messages between machines work.** They go to the right address. The receiving machine checks the message really came from this agent's own machine, files it, types it into the right session, and answers with a signed receipt, so the sender knows the right machine got it. Each machine has one sender queue toward each other machine and makes one delivery pass per message. If the other machine can't be reached right now, or the conversation now lives on a different machine, the sender is told plainly ("not reachable now, resend later", or "that conversation is on the Mac Mini"). Automatic retries for a machine that is asleep, and automatic re-sending to wherever a conversation moved, come in a second step.
4. **The sender always hears about a failure.** A sending session gets one short note saying the message wasn't delivered, why, and which sessions might be the right one. The note is marked as information, not an instruction. A burst of failures is grouped into one note. Scripts that aren't sessions see the failure in their reply and in a count on the agent's health page.
5. **Names stop doubling.** New sessions no longer get the extra "echo-" in front. Old names keep working because of step 1. Two different jobs can never end up sharing one session name: if the natural name is already taken by another job, the new one gets a numbered name instead.

## What it doesn't do

It doesn't send messages to other agents, to people, or into chats. It adds no new way to block a person's message. The only new refusals are inside the agent: a machine refuses a message that didn't really come from its own agent, a session doesn't get a message written before it existed, and nobody but the system can create a delivery note. The record of each message still shows what the sender asked for, plus where it actually went. The 112 old stuck messages are not replayed, because they are hours to weeks out of date. They stay where they are; their records already show them as undelivered.

## Safety

- **Only this agent's own sessions.** A message is typed only into a session of this same agent, and only when one session fits.
- **Signatures on both ends.** Machines check each other's signatures both ways.
- **Typed at most once.** If a machine stops in the middle of typing a message, it is never typed again. The sender is told the outcome is unknown.
- **Bounded traffic.** Only one message at a time goes from one machine to another, and each gets a single pass.

## Undoing it

Revert the change. Nothing needs migrating: the new fields are ignored by older code, and the old stuck-message folder was never touched.

## What you need to decide

Nothing. This is internal plumbing between the agent's own sessions and machines.
