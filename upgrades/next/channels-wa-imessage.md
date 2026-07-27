# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`GET /channels` covers WhatsApp and iMessage. Both adapters existed but had no registry row — a gap
recorded explicitly when the direct user channels shipped, and a hole in the registry's own
"absence is impossible" property, since a channel with no row cannot report that it is missing.

WhatsApp is read from `getStatus().state`, a real state machine rather than a boolean, so
`qr-pending` maps to `reachable-no-credential` — the link is alive and waiting for a human to scan a
pairing code, and a restart will not help. `connecting`/`reconnecting` report `unknown` with the phase
named rather than being guessed; `disconnected`/`closed` are `broken`; an unrecognised state is
`unknown`, never `working`.

iMessage is read from `getConnectionInfo().state`, deliberately NOT the sibling `connectedAt` — that
field is computed as `started ? new Date().toISOString() : undefined`, so it reports the moment you
asked rather than the moment it connected. A source ratchet fails if anyone wires it in.

## Evidence

Falsified by flattening `qr-pending` to `broken` in production:

```
× THE STATE A BOOLEAN LOSES: qr-pending is reachable-no-credential, not broken
  → expected 'broken' to be 'reachable-no-credential'
  Tests  1 failed | 15 passed (16)
```

Restored byte-identical. Green across every suite touching the change:
`Test Files 5 passed (5) · Tests 59 passed (59)` (`user-channel-wa-imessage`,
`user-channel-liveness`, `channel-registry`, `channel-registry-claims`, `channels-route`);
`tsc --noEmit` exit 0. The integration test pinning the exact channel set and the audience partition
was updated in this change rather than left for CI to catch.

## Also in this change: the Telegram row now names its subject

Found by checking the shipped feature on a running agent rather than only in tests. `/capabilities`
reported `telegram: { configured: true, adapter: true, bidirectional: true }` while `/channels`
reported `user-telegram: unknown — the Telegram poll loop is not running` — the config surface and the
live surface disagreeing, which is exactly what this registry exists to expose.

But the row was measuring the SERVER process's adapter and presenting it as the channel's state. On a
lifeline deployment inbound never goes through that adapter: a separate lifeline process polls and
forwards, and the server logs "Telegram relay wired (via lifeline callback forwarding)". Inbound was
healthy; a stopped server poller is normal there.

That is the same scope error the `threadline-relay` row was fixed for in #1667 — a true statement
whose subject is unstated, so the reader concludes something about a path that was never measured.
The verdict stays `unknown` (what it can see is genuinely undetermined); it now names the server
adapter and says plainly that this alone does not mean messages are not arriving.

## Known limits

`working` means the link was up when probed — not that a message to a particular chat or contact
would land. Neither row probes a round-trip, because a status read must not send. iMessage is bound to
the host running its backend, recorded as a real cost of choosing it.

## What to Tell Your User

Your agent can now tell you whether WhatsApp and iMessage are actually working, alongside Telegram and
Slack.

The useful part is what it says when WhatsApp is waiting for you to scan a pairing code. That is not
broken — the connection is fine, it just needs you for a moment — and restarting things would not fix
it. It now says exactly that, instead of lumping it in with a dropped connection.

It is also careful about what it does not know. If a link is mid-connection it says so rather than
guessing, and a working link means the connection was up when it checked, not a promise that a message
to one particular person will arrive.

## Summary of New Capabilities

No new endpoint, command, or config key. `GET /channels` gains `user-whatsapp` and `user-imessage`
rows with live-state verdicts.
