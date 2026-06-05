# Upgrade Guide - vNEXT

<!-- bump: patch -->

## What Changed

Instar now has a post-drive transcript auditor for operator-seat UX review. Given topic ids and a drive window, it reads the existing topic message history, classifies duplicate notices or deliveries, resend or retry asks, internal infrastructure noise, and content-free status updates, then files each finding into the framework issue ledger with a stable dedupe key.

The framework issue ledger also now preserves related-spec citations when observations are recorded, so findings can keep their link to Observation Needs Structure and the UX-blindspot work instead of losing that context after the write.

## What to Tell Your User

I can now audit a supervised Telegram drive after it happens and turn visible friction into durable findings instead of leaving it buried in chat.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Post-drive transcript UX audit | Run the new developer audit command with topic ids and a time window. |
| Framework issue citations | Automatic when an observation includes a parent-principle or related-spec citation. |

## Evidence

Live fixture verification used topics 2278 and 2271 for the 11:15-11:21 PDT window on 2026-06-05. Dry-run first reported one duplicate-delivery group and two content-free status-notice groups after the ACK false positive was removed. Filing mode then wrote three framework issue observations with stable dedupe keys; rerunning the command deduped them instead of creating duplicates. Targeted tests passed for 50 cases across the auditor and framework issue ledger suites, build passed, lint passed, and the Tier-1 dev gate accepted the ELI16 plus side-effects artifacts.
