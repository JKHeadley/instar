# Commitment detection reads recent Telegram history

## What Changed

The scheduled job and sentinel can see newer local Telegram messages in TopicMemory when the flat log is missing or stale. Matching log entries retain their automation labels. Known stock job prompts pick up the fix during update.

## What to Tell Your User

Commitment detection can resume from its existing bookmark. If it cannot read history, the job reports the failure and keeps its place.

## Summary of New Capabilities

The scheduled job reads the latest 100 messages across local Telegram topics. It advances its bookmark after it processes the batch and registers the actions it found.

## Evidence

Unit tests reproduced the missing-log and stale-log cases. A two-update fixture exercised the installed helper, operator settings, and repeated bookmark acknowledgements. Private loopback verification is pending.
