# Messages can reach the exact young session on another computer

## What Changed

Adds a signed receiving-session observation and exact generation binding, so messages can reach newly started sessions without drifting into replacements. Stops automatic retyping when physical delivery may already have happened. Adds durable bounded holder waiting and diagnostic refusal records.

## What to Tell Your User

The repair ships switched off while computers update. After the repair owner verifies support across the pool and enables it, young sessions can receive messages immediately. If the intended session has changed or cannot be proved, the system records a clear failure and attempts to notify the sender instead of delivering to a replacement. A crash during typing produces a may-have-arrived outcome rather than an automatic duplicate.

## Summary of New Capabilities

Machine-authenticated POST /api/messages/session-generation; sender-only live multiMachine.messageSessionGeneration.enabled, off by default; exact signed recipient generation and guarded uncertainty recovery. The receiving endpoint is available independently of sender rollout.

## Evidence

Targeted unit, fifteen authenticated HTTP integration checks and seven AgentServer lifecycle/wiring checks pass. The shared full suite awaits its reserved slot. Proactive terminal notices remain best-effort under separately tracked fb-292ec9c9-9d3. No release or deployment has occurred.
