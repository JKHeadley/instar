# Explain the usage-limit pause to every agent

## What this is, in plain English

A usage-limit pause can stop scheduled AI jobs. The underlying fix can release that pause after a deadline or sooner when usage recovers. After a deadline release, AI jobs still wait for a fresh healthy usage reading, while script checks may run. Agents need to explain that difference accurately.

## What already exists

The status endpoint for usage-limit migration exists. The executor's open fix adds clearer pause and fresh-reading status, but its pull request is held by an independent safety review. New agent instructions and updates to existing instructions are generated through separate trusted code paths.

## What changes here

The trusted install template and update migration now teach both new and existing agents how to read those status fields. They explicitly say that a missing pause field is not proof that a pause is active. A regression test checks the fresh template and verifies that an existing agent receives the guidance once, without duplicates on later updates.

## Safety and rollout

This is guidance only. It does not change when jobs run or how a pause releases. The wording is conditional so it is accurate even before the executor's runtime fix is merged. The runtime fix remains subject to its own review, tests, and merge checks.
