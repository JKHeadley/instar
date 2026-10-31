# Quota pause guidance for new and existing agents

<!-- bump: patch -->

## What Changed

The agent instruction template and the in-place instruction migration now explain the usage-limit scheduler pause status. Both point to the existing migration-status endpoint, describe the conditional pause field, and distinguish a deadline release from permission to run AI jobs before a fresh healthy usage reading. The migration adds the section once to existing agents, while new agents receive the same guidance at initialization.

## What to Tell Your User

- **Clearer usage-limit updates:** “I can tell you whether my scheduled work is paused and whether a fresh usage reading is still needed before AI jobs resume.”

## Summary of New Capabilities

No new setting or user action is required. Agents can explain the bounded pause and fresh-reading state from the status endpoint when those fields are present.

## Evidence

Before this change, neither the fresh instruction template nor the update migration had the quota-pause section, so an agent could infer that a deadline alone made AI jobs safe to run. The new focused test checks both instruction paths, conditional wording for an absent field, and byte-idempotent migration: 230/230 focused tests passed. The runtime pause fix remains in a separately reviewed executor PR and is not claimed as part of this guidance change.
