# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Fix: mentee receiver wiring now fires on the lifeline-forward path.** The
mentee receiver wiring shipped in PR #462 installs an a2a hook on the primary
`TelegramAdapter`. But the hook only fired when the adapter polled directly.
In production both Echo and Codey run with `--no-telegram` — the primary
adapter is in send-only mode and never polls; the lifeline polls and forwards
messages via `/internal/telegram-forward`, which called
`ctx.telegram.onTopicMessage` directly and BYPASSED the a2a hook gate. The
mentee-side receiver was dead in production as a result.

This PR closes the gap end-to-end:

1. **`TelegramAdapter.dispatchAgentMessageHook(ctx)` (new public method)** —
   extracts the hook invocation from the polling text-dispatch path into a
   reusable dispatcher. Polling now calls it; the lifeline-forward handler
   ALSO calls it. Same gate, both paths.
2. **`/internal/telegram-forward` (server)** — invokes
   `dispatchAgentMessageHook` BEFORE falling through to `onTopicMessage`. If
   the hook claims the message (`handled:true`), the route short-circuits
   with `{ ok: true, forwarded: true, agentMessage: true }` and the
   user-message path is NOT also dispatched.
3. **`TelegramLifeline.forwardToServer` (lifeline)** — populates `senderIsBot`,
   `senderChatId`, `senderBotId` in the forward body from the Telegram update.
   Required so the a2a hook's spoof defense (drop a marker from a real user
   typing a marker-shaped string) can apply on forwarded messages.

**Backward compatibility:** newer server / older lifeline → `senderIsBot`
omitted → treated as falsy → marker-bearing forwards drop closed (matches the
spec invariant: a real user typing a marker MUST be dropped). Newer
lifeline / older server → unknown fields ignored, no regression.

**Caught by:** dogfood — Echo + Codey on v1.3.49, both with the receiver
wiring from PR #462 installed and Codey's `config.mentee` block populated.
Manual `/mentor/tick` failed silently because Codey's hook was never invoked
on the lifeline-forward path. Spec §Recipient side describes the hook as
"registered with `TelegramAdapter.onMessage`"; the original implementation
read this as the polling path, missing the dual-path nature of message
ingress in send-only mode.

## What to Tell Your User

A small fix that closes a quiet but real gap: the cross-agent mentor pipeline
now actually fires end-to-end in production, not just in tests. The previous
release shipped the receiver wiring, but only the polling adapter saw
inbound a2a messages — and in production we run a separate process for
polling, so the wiring was dead. After this update, mentor prompts route
correctly through to mentee sessions, and replies come back. No config
changes required on your end.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `TelegramAdapter.dispatchAgentMessageHook(ctx)` | Public dispatcher — any caller in possession of the adapter can invoke the agent-message hook the same way the polling path does. The lifeline-forward handler now does this automatically. |
| Lifeline-forward carries spoof-defense fields | `senderIsBot`/`senderChatId`/`senderBotId` are populated in the `/internal/telegram-forward` body so the a2a hook's spoof defense applies on forwarded messages. |

## Evidence

11 new tests, all green: 8 unit on `dispatchAgentMessageHook` (no-op safe,
handled returns true, fall-through, FAIL-OPEN on hook throw, three
senderBotId derivation modes, caller override); 3 integration on the
`/internal/telegram-forward` route (short-circuit when claimed,
fall-through when not, backward-compat with adapters lacking the method).
`tsc --noEmit` clean. Side-effects review:
`upgrades/side-effects/mentee-receiver-forward-dispatch.md`.
