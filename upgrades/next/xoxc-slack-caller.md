<!-- bump: patch -->

## What Changed

The gold-standard live-test harness can now drive a REAL Slack channel as a REAL
workspace member. Previously the harness's multi-machine capstone route
(`POST /live-test/multi-machine-capstone`) built its Slack sender with
`new SlackApiClient(demoSlackUserToken)`, which only knows how to authenticate
with a Bearer token (`xoxp`/`xoxb`). But the only DISTINCT non-Echo Slack
senders captured in the demo workspace are real test-USER identities
authenticated the browser way — an `xoxc-…` web-client token plus the user's
`d` session cookie. Those are not Bearer tokens, so the harness could never post
AS a real member, which defeats the whole point of the standard (drive real
channels as a real user).

A new `LiveTestSlackCaller` credential adapter (implementing the same
`SlackCaller` seam `SlackLiveSender` already consumes) closes the gap. It routes
per method: `chat.postMessage` posts AS THE MEMBER via Slack web-client auth
(`xoxc` token in the form body + the `d` cookie in a `Cookie: d=…` header,
against the workspace host), while every other method (e.g.
`conversations.history`) reads over Echo's own clean Bearer bot token at
`slack.com`. The capstone route detects an `xoxc-` sender by prefix and wires
the new adapter; a plain Bearer sender keeps the original `SlackApiClient` path.
Two new config keys — `liveTest.demo.slackUserCookie` and
`liveTest.demo.slackWorkspaceHost` — supply the cookie + host alongside the
existing `slackUserToken`. The fail-closed `blockedSurfaces` behavior is intact:
a missing cookie/host/bot-token records a loud blocked-surface (a real
driver-error FAIL), never a fabricated reply.

This is dark harness/developer infrastructure — it only runs inside the
dev-gated live-test runner, never on the fleet runtime path, and changes no
user-facing behavior.

## What to Tell Your User

Nothing user-facing changes. This is internal developer test-harness plumbing:
it lets the live-test runner post into a Slack channel as a genuine distinct
member (via captured web-client credentials) instead of being limited to Bearer
tokens, so the harness can actually exercise the real Slack surface end-to-end
before any user does. If your agent isn't a development/instar-dev agent running
the live-test capstone, you will never see this code execute.

## Summary of New Capabilities

- `LiveTestSlackCaller` (`src/core/LiveTestSlackCaller.ts`) — a `SlackCaller`
  adapter that posts `chat.postMessage` AS a real workspace member using an
  `xoxc` web-client token + the member's `d` session cookie, and reads all other
  methods over a Bearer bot token. Pure transport over an injectable `fetch`
  (unit-testable).
- The multi-machine capstone route (`POST /live-test/multi-machine-capstone`)
  now wires `LiveTestSlackCaller` when the demo Slack sender is an `xoxc` token
  (detected by prefix) and the `d` cookie + workspace host + bot token are
  configured; otherwise it keeps the original Bearer `SlackApiClient` path.
- New config keys `liveTest.demo.slackUserCookie` and
  `liveTest.demo.slackWorkspaceHost` (read alongside the existing
  `liveTest.demo.slackUserToken`).
