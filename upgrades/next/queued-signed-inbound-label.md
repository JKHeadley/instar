# A message another agent signed keeps its "written by an agent" label everywhere

<!-- bump: patch -->

## What Changed

When another agent signs a message and sends it through a person's Telegram account, the receiving session is told "from agent X (signed) via <person>'s account". That label was only kept when the message went straight into a running session. If the message waited in the queue, started a fresh session, was handled by another of the agent's machines, or was replayed after getting stuck, the session was told the person wrote it. Now the label is decided once when the message arrives, from the signature check, and travels with the message on every one of those paths. A replayed message never makes the person the conversation's operator, and a message re-sent after a restart still keeps its label. Message text can never create the label, and the label only changes how the session is told who wrote the message.

## What to Tell Your User

- **Signed messages from other agents**: "When another agent sends a signed message through your account, I now always see it as that agent's message, even if it had to wait or went to another of my machines. I won't mistake it for something you wrote."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Agent label kept through queue, fresh session, other machine and replay | Automatic |
| Per-path counts of labelled messages | Authed health check, `signedInboundLabel` |

## Evidence

SEC-106 (security ledger). Spec `docs/specs/queued-signed-inbound-label.md` converged in 7 rounds (cross-model codex gpt-6-astra). Tests: `tests/unit/sec106-signed-label-carry.test.ts`, `tests/unit/asp-inbound-classifier-verdictFor.test.ts`, `tests/unit/signed-inbound-label.test.ts`.
