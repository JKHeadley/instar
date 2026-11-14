# Disk warnings that back off — Plain-English Overview

## The problem in one breath

When a machine's disk got very full and there was nothing the agent could safely delete, the disk watcher kept posting the same warning every two hours, day and night. On Nov 11 the Studio and the Laptop were both in that state, so the Disk space topic filled with identical messages that said nothing new.

## What already exists

The disk watcher (Disk Steward) checks free space every 15 minutes, warns at three levels (warn, escalate and critical), tries a safe cleanup first, and posts to the Disk space topic. Plain warnings already waited longer between repeats; the two serious levels did not.

## What this adds

Every level now waits longer each time it repeats a warning that has nothing new to say: twice as long each time, up to once a day for the serious levels and once a week for plain warnings. The moment the disk drops by another 2% (about 18 GB on these machines), the wait resets and the next warning comes quickly.

## The new pieces

One small rule for how long to wait, one remembered number (how much was free at the last warning), and a check every 15 minutes for a real drop since then.

## The safeguards

The first warning of a new problem, a move to a worse level, and the first critical warning all post exactly as before. At least one critical warning still goes out every day. Nothing about cleanup or the thresholds changes.

## What ships when

All at once, in the next release; every agent gets it on update with no setting to change.

## What you actually need to decide

Nothing. This only makes repeated warnings quieter when they carry no news.
