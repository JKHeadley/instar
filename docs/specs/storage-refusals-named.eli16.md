# Storage refusals name the machine — the plain version

## What this is

When the agent's machine runs low on disk, the agent refuses new files instead of filling the disk. These are the photos, documents and voice notes sent from the app or Slack. Until now, the refusal said "This machine is nearly out of disk space, so the file was not stored." Justin saw that under a message on his phone and couldn't tell which of his five machines it meant. It was the Mac Studio. His words: "Errors like this should specify what machine it's referring to."

## What already existed

- A safety floor: below 5% (or 2 GiB) free, no new files are stored on that machine.
- A cap on the total size of the app's file store.
- A limit on how many uploads can be in flight at once on a machine.
- A notice in the agent's attention list when one of these keeps refusing.

## What is new

- Every one of these refusals names the machine: "Mac Studio is nearly out of disk space, so the file wasn't stored." The same goes for "The file store on Mac Studio is full" and "Mac Studio has too many uploads in progress".
- Copying a file between machines says which machine is out of space.
- The low-disk notice used a machine's internal id (a long code) as its title. It now uses the machine's name.
- When a machine has no name registered yet, its own computer name is used. It never says "this machine".

## Safeguards

- Nothing about when files are refused changes. Only the words do.
- The error codes the app relies on are the same.
- One test used to read the real disk, so it failed on any nearly-full computer. It now uses a fixed reading.

## What you need to decide

Nothing. It is a small wording change that follows Justin's request directly.
