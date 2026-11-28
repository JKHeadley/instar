# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A Local Verify peer entry can specify a stricter load ceiling for new full verification offers.

## What to Tell Your User

Set an optional load limit on a peer entry to let that machine take new runs only when its latest reading is below the limit.

## Summary of New Capabilities

The coordinator can enforce a per-peer load ceiling immediately before it reserves a new run.
