# Putting the switched-off features on the maturation ladder, in plain English

## What this is

Instar keeps a list called the maturation ladder. Every feature that ships switched off or watch-only is meant to be on it, with numbers saying when it has earned the next step. The review on November 5 found 13 features on no ladder at all, so nobody could measure them. This change puts them on it.

## What already existed

The ladder, its review, and a shared evidence log that features write to. A test already fails the build when a switched-off flag has no entry, but it only sees flags whose default sits in the shipped defaults file. These 13 keep their default in code, so they slipped past it.

## What is new

- **Eleven new entries.** Seven are real ladders with thresholds from their own specs: the self-action governor, benchmark divergence, the job completion audit, dynamic MCP, collaboration re-drive, the principal coherence watcher and response review. One moves with its parent: the feedback inbox receiver only runs on one host and feeds the drain. Three are finished: git backup, the external process notice and the stale session backstop.
- **"Finished" as a kind of entry.** Those three ship on with an ordinary off switch, and they read as off only because Echo chose that. Inventing a bar for them would be fake measurement, so the entry records why it is finished and where the code shows it.
- **Numbers at the last step.** A feature on its last step showed an empty list, even when it read "harmed". It now shows the number that judged it. The autonomous heartbeat also looks back 3 days instead of 14, so a fix shows up in days.
- **Missing tracking.** Phone permission actions, memory privacy and the class closure lint now record what they do. The governor records its would-deny rate, because its promotion bar had nothing the ladder could read.

## The safeguards

Recording can never block anything. Each new line runs after the decision it describes, and a failed write only costs a sample. No row carries a message, a target or a place. The ladder stays advice: a number only raises a question for the review, whose model decides.

## What stays open

Three of the new entries (benchmark divergence, dynamic MCP, collaboration re-drive) are registered but record nothing yet, so they read as no data. Each entry says exactly what it must record, and the review's tracking step picks those up. Listing them honestly as blind is the point: before this they were invisible.

## What you need to decide

Nothing. There is no constitution change. If this is wrong, a revert undoes all of it.
