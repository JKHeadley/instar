# Slack ambient mode can acknowledge without interrupting

## What Changed

The existing conservative Slack ambient gate now chooses exactly one of three actions for an eligible undirected message: speak, add the fixed `eyes` reaction, or remain silent. Reactions reuse the existing proactive-action cap and never create a conversational turn. Invalid output, low confidence, provider errors, and reaction uncertainty all resolve to silence.

## What to Tell Your User

In a Slack channel explicitly opted into ambient contribution, the agent may use the eyes reaction to mean “seen and considered” when a written reply would be intrusive. It does not mean ownership, approval, or a future response obligation. Channels where that convention would imply commitment should remain opted out.

## Summary of New Capabilities

- One conservative LLM decision now returns `speak`, `react`, or `silent`.
- `react` adds exactly one fixed `eyes` reaction and sends no reply.
- The existing shared proactive cap bounds both speech and reactions.

## Evidence

- Gate and adapter unit coverage verifies the strict closed schema, all three actions, fixed emoji, one provider call, shared budget exhaustion, and fail-to-silent paths.
- TypeScript build passes.
