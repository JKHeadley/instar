# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed the ROOT of duplicate agent-to-agent replies: `POST /messages/relay-agent`
now responds at the accept boundary instead of after the session spawn.** The
co-located inbound handler used to AWAIT `handleInboundMessage` — a session
spawn/resume that routinely takes 9-30 s — before responding. But the sender
(`MessageRouter.relay`) uses a 5-second fetch timeout and reads only whether the
request succeeded. So whenever the receiver's spawn outran 5 s, the sender gave
up, retried with a fresh message id, and the receiver spawned a SECOND session →
a duplicate reply. The content-hash dedup shipped earlier is the symptom
backstop; this removes the cause. The handler now responds `{ ok:true,
accepted:true, threadline:{accepted:true, async:true} }` the instant the message
is accepted + gated, and runs the spawn in the background. Everything that must
happen first — the dedup, the reply-waiter resolution, and the warrants-reply
gate (including its suppress short-circuit) — still runs synchronously before the
response. Scoped to the co-located path; the cross-machine relay-funnel path
(which has retry-on-error semantics to preserve) is tracked separately.

## Summary of New Capabilities

- No new capability — a robustness fix. Agent-to-agent messages on the same
  machine no longer risk a duplicate reply when the receiver's session spawn is
  slower than the sender's 5-second delivery timeout.

## What to Tell Your User

Agents talking to each other on the same machine no longer occasionally send the
same reply twice. The cause was that a receiving agent waited until it had fully
spun up a session — up to half a minute — before telling the sender the message
arrived, but the sender only waits five seconds and would resend. Now the
receiver acknowledges the moment the message is safely accepted and does the
slow work in the background, so the sender never times out and never resends.
Nothing changes for you; the real reply still arrives as before, just without the
occasional duplicate.

## Evidence

**Reproduction / root cause.** Confirmed in the code: the co-located sender
`MessageRouter.relayToAgent` (`src/messaging/MessageRouter.ts:486-510`) wraps its
POST to `/messages/relay-agent` in `AbortSignal.timeout(5000)` and returns only
`response.ok`. The receiver's handler awaited `handleInboundMessage` (a 9-30 s
session spawn) before responding, so any spawn over 5 s aborted the sender's
fetch → the sender retried with a fresh `message.id`, which slips past the
id-based relay dedup → a second spawn and a duplicate reply. (The 2026-05-30
duplicate-reply incidents on the echo↔codey loop are this path.)

**Before / after.** Before: the response is sent only after the full spawn. After:
the response is `{accepted:true, async:true}` sent at the accept boundary, with
the spawn running in the background. The rewritten integration test holds the
background handler open and asserts the HTTP response returns while the handler
is still mid-spawn (`router-start` present, `router-end` not yet) — i.e. the
sender is no longer made to wait. The handler still runs to completion in the
background (not dropped); a background rejection still yields HTTP 200; the
reply-waiter resolution and the warrants-reply gate's suppress short-circuit stay
green; the content-hash dedup suite and the keystone gate-before-spawn wiring
test stay green. An independent second-pass reviewer audited the change (it
touches inbound messaging) and confirmed correctness after one artifact-honesty
correction.
