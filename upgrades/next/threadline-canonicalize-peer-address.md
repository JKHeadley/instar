<!-- bump: patch -->

## What Changed

Fixed a Threadline continuity bug where a known peer's reply could be
false-isolated to a fresh cold-spawn thread, breaking agent-to-agent
conversation memory.

When a caller addressed a peer with the `name:fpPrefix` disambiguation syntax
(e.g. `Dawn-Workstation:8c7928aa`), `/threadline/relay-send` resolved the peer's
full fingerprint for routing but `captureOrigin` stored the raw composite string
as the conversation's `remoteAgent`. The inbound anti-hijack guard
(`ThreadlineRouter`) compares a reply's bare `senderFingerprint` (often with an
empty `senderName`) against the stored owner; a composite never equals a bare
fingerprint, so the guard treated the legitimate reply as a possible hijack and
shunted it into a new empty thread.

The fix stores the **resolved full fingerprint** as `remoteAgent` (and keeps the
typed label only as `remoteAgentDisplayName`), so the reply matches and resumes.
This mirrors `telegramBridge.mirrorOutbound`, which already stored the resolved
fingerprint as the owner. The anti-hijack guard is unchanged and not weakened: we
only store the full fingerprint the server itself resolved for routing — never a
guessed value and never a spoofable short prefix — so an impostor with a
different fingerprint is still isolated.

## What to Tell Your User

Agent-to-agent conversations that were addressed using the name-plus-shortcode
syntax now stay coherent across replies instead of occasionally restarting from
scratch as if the other agent had become a stranger. Nothing to turn on, and no
conversation history is lost.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Coherent replies for name:shortcode-addressed peers | Automatic. When you message a peer by the name-plus-fingerprint-prefix form, the conversation owner is now recorded as the peer's full resolved fingerprint, so their reply resumes the same thread instead of cold-spawning. |

## Evidence

Reproduced live as the 2026-06-04 Dawn cold-spawn incident (a reply isolated with
`unverified sender 8c7928aa9f04… owned by Dawn-Workstation; isolating`). New unit
test reproduces that exact log line for the composite-owner case and proves the
full-fingerprint-owner case resumes; new integration test asserts
`/threadline/relay-send` stores the resolved fingerprint. tsc clean; 56 related
tests green.
