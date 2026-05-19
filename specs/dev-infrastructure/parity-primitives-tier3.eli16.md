---
title: "Parity primitives Tier-3 lifecycle tests — ELI16"
slug: "parity-primitives-tier3-eli16"
parent: "parity-primitives-tier3.md"
---

# Parity primitives Tier-3 tests — explained simply

## What this fixes

Instar has a Testing Integrity Standard that is non-negotiable. Every feature needs three test tiers — unit tests that exercise the module in isolation, integration tests that hit the HTTP routes, and Tier-3 end-to-end lifecycle tests that prove the feature is actually alive in the production-init path. The Tier-3 is the most important of the three because it answers the question that matters: when the server boots, does this thing actually work?

The recent primitive PRs (skill, hook, agent, tool, memory) shipped excellent unit tests but skipped Tier-3. The rules were verified in isolation but never verified to be alive in the production-init path. That gap was visible in the audit and noted as a remaining v1.0 item.

This release closes the gap with one consolidated end-to-end suite. Twelve tests cover registry-is-alive-at-boot, each rule's contract surface, end-to-end render cycles for skill and hook, memory verify, the post-update migrator's parity-renderings backfill, and the FrameworkParitySentinel's boot lifecycle. No mocks, real fixture project, real rendered files on disk, real verify-read-back assertions.

## Why one file instead of four

The four primitives share the same registry, same boot path, same fixture setup. Splitting into four files would duplicate setup and dilute the actual assertion. The boundary "the parity layer is alive in production-init" is more meaningfully tested as one cohesive end-to-end suite than four siloed checks. Each rule still gets its own describe block so failures localize cleanly.

When Agent and Tool parity rules land in future PRs, the same suite picks them up automatically via the registry-iteration pattern.

## What changes for you

For Justin: the v1.0 Testing Integrity gap is closed. Every primitive in the parity layer now has the Tier-3 lifecycle proof. On every CI run, the suite exercises the full chain — canonical source → rule.listInstances → rule.verify → rule.remediate → framework-native rendering on disk → sentinel scan — against a real fixture project.

For future contributors: the suite is the template. New parity rules added to the registry are covered by the registry-iteration assertion. Per-rule end-to-end coverage is a 5-line addition following the skill / hook patterns in the file.

## What this is NOT

Not a change to the parity rules themselves. Not a Tier-2 HTTP route addition (the parity rules don't have HTTP endpoints — Tier-2 is not applicable for this primitive layer). Not a stub that imports the module and calls it good — every test exercises the production-init path against real fs operations.
