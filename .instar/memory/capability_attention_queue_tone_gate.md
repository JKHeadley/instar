---
name: Attention Queue Tone Gating
description: Automatic quality gate on all user-facing alerts — blocks low-signal items before they reach the user
type: capability
---

## What It Does

Every alert sent to your attention queue now runs through an automatic quality evaluator before reaching you. The gate checks three things:

1. **Does this need your attention?** Auto-resolved background events, routine retries, and status-only messages fail this check and get logged instead. Only actionable items get through.

2. **Is everything needed to act actually here?** If an alert says "something degraded" but doesn't say what, why it matters, or what to do — the gate rejects it and forces a rewrite. No more dangling headers with no actionable content.

3. **Is it plain English?** No jargon-soup, no log-dump format, no technical shorthand. If it reads like a robot wrote it, the gate flags it for rewrite.

## Why It Matters

This directly addresses the problem Justin identified: repeated degradation events were spawning 7+ duplicate Telegram topics, all with noise and no actionable content. Now:

- **Recurring issues collapse into one topic** — Same degradation ID = same topic, new messages append instead of spawning new topics
- **Only messages that matter reach you** — Auto-resolved events and FYI status updates stay in logs; humans act on signal
- **Messages are always complete** — Can't send a degradation alert that doesn't explain what's degraded or what to do

## How It Works

**For health-class alerts** (degradation, health, alert): The gate applies a strict ruleset (B12/B13/B14) that rejects items without clear call-to-action and high information density.

**For other alerts**: Standard ruleset (B1-B7, B11) ensures all alerts are actionable and self-contained.

**If a message is blocked**: The gate returns a structured rejection with the reason. The agent that tried to send it can fix the message or drop it entirely.

## Implementation Details

- Built on `MessagingToneGate` authority — same gate that guards other outbound message paths
- Guardian-pulse jobs should use stable attention IDs: `degradation:{FEATURE}` (no timestamp), so recurring detections of the same problem route to the same topic
- The gate is automatic and invisible when messages pass; only rejected messages require intervention

## Related

This replaced the naive deduplication approach that relied on matching IDs. Now the server intelligently routes based on semantic similarity plus metadata, while the gate ensures every message that reaches you is worth your time.
