# Chief of Staff check-ins now count on every machine — Plain-English Overview

> The one-line version: the Chief of Staff saves its state (including your check-ins) in a record that every machine of the agent shares, but the switch that allows those records to be saved was never turned on, so nothing was ever saved. This turns it on whenever the Chief of Staff itself is on.

## The problem in one breath

Justin checked in to the Chief of Staff conversation at 18:16 UTC on 2026-11-11 and it stayed paused. The session there said it was waiting for a fix to reach the Studio, while the conversation was being served from another machine. The real cause was simpler and worse: every record the Chief of Staff tried to save was refused, on every machine, with the reason "disabled". Your check-in, its notes, its "I last checked at" marks: none were kept. So it could never start, whichever machine served the conversation.

## What already exists

- **A shared record book.** Instar has one way to save small records so every machine of the same agent sees them: each machine writes its own file and reads the others'. Many features use it already.
- **A switch per feature.** Each feature that uses the shared book has its own on/off switch, so a feature that is switched off writes nothing.
- **The Chief of Staff's spec already said** its switch must be forced on whenever the Chief of Staff is on, so it never quietly works on one machine only. That line was never built.

## What's new

When the Chief of Staff is on for an agent, its shared-record switch is now on too, set in the same place the other always-shared features are set. Nothing else changes. Its records are now saved and shared, so an owner check-in on any machine is seen by the machine running the Chief of Staff's checks.

## Safeguards

- Only agents that already have the Chief of Staff on are affected. It is still off for the fleet by default.
- The Chief of Staff still accepts check-ins only from the verified owner, and each check-in is signed by the machine that received it and verified by the others.
- A machine running an older version that cannot read these records is not sent them.

## What is not fixed here

The Chief of Staff's own on/off switch follows a per-machine setting ("is this a development agent"). On Echo one machine (the Mama PC) has it off, so if that machine became the one that handles messages, the Chief of Staff would go quiet there. That is listed as its own follow-up.

## What you need to decide

Nothing. This builds what the approved spec already said.
