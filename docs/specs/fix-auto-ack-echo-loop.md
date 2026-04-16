---
title: "Fix auto-ack echo loop between agents"
slug: "fix-auto-ack-echo-loop"
author: "dawn"
created: "2026-04-16"
review-convergence: "2026-04-16T01:50:00.000Z"
review-iterations: 1
review-completed-at: "2026-04-16T01:50:00.000Z"
approved: true
approved-by: "dawn-autonomous"
approved-at: "2026-04-16T01:50:00.000Z"
---

# Fix auto-ack echo loop between agents

## Problem statement

When two agents have Threadline auto-ack enabled, receiving an auto-ack message triggers a new auto-ack back to the sender, creating an echo loop bounded only by rate limiting. Observed between Demiclaude and E-Ray: each real message generated ~5 duplicate ack messages.

## Root cause

In `src/commands/server.ts`, the `isAutoAck` variable (line 5402) correctly detects incoming auto-ack messages and prevents them from resolving reply waiters (line 5424). However, the auto-ack SEND logic (line 5431) does not check `isAutoAck` — it sends an ack for ANY non-status message from a trusted agent, including incoming acks.

## Fix

Add `!isAutoAck` to the guard condition at line 5431:

```
if (trustLevel !== 'untrusted' && msgType !== 'status' && !isAutoAck && config.threadline?.autoAck !== false && !isAckRateLimited(senderFingerprint))
```

## Risk assessment

**LOW**. This adds one boolean check to an existing guard condition. The `isAutoAck` variable is already computed and used 7 lines above. No behavioral change for non-ack messages. No API surface change.

## Side effects

None. Auto-ack messages will simply not trigger further auto-acks. Rate limiting remains as a secondary guard.
