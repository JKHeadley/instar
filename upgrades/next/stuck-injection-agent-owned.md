# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The health warning for an unsubmitted session message is marked as agent-owned. The existing Needs You filter uses that classification to leave it out of the owner's queue.

## What to Tell Your User

A message waiting at a session prompt no longer creates a Needs You item. The warning stays visible in Health while background recovery handles it.

## Summary of New Capabilities

No new settings. This corrects who is asked to act on an existing warning.
