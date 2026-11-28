# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A Local Verify peer entry can specify a stricter load ceiling for new full verification offers.

## What to Tell Your User

Use an optional `maxLoadPerCore` on a peer entry to let that machine take new runs only when its latest load reading is below the value.

## Summary of New Capabilities

The coordinator can enforce a per-peer load ceiling immediately before it reserves a new run.
