# Whole-disk measurement by owner — Plain-English Overview

## The problem in one breath

When the Laptop's disk filled up on Nov 11, the disk watcher could only say which of its own folders were big, and those explained about 25 GB of 746 GB used. The real space was in other agents' work copies and backup folders, which it never looked at, so its warnings could not point at the cause.

## What already exists

The disk watcher (Disk Steward) checks free space every 15 minutes, runs a safe cleanup in a separate background process, and every 6 hours measures the folders inside its own agent folder. Its warnings list the biggest of those.

## What this adds

Once a day, the same background process also measures the main folders in the whole home folder and says who they belong to: which agent, or which plain folder such as Projects or a backup folder. The warning gains one line with the top owners and how much space it did not look at.

## The new pieces

A read-only measuring step, a list of agents read from the machine's agent registry, one new field in the disk status, and one line in the warning text.

## The safeguards

It only reads; nothing is deleted or moved. On a Mac it never opens private folders such as Documents, Desktop, Downloads, Photos or app data. It never takes more than a quarter of its remaining time on one folder, finishes before the cleanup run's own deadline, and names any folder it could not finish instead of guessing.

## What ships when

All at once, in the next release, after the repeat-backoff change it builds on. No setting to change.

## What you actually need to decide

Nothing. It adds information to warnings that already go out.
