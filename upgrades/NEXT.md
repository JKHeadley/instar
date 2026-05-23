# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = adds the LocaltunnelProvider class — Tier-2 relay backend, not yet wired into the active pool -->

## What Changed

**feat(tunnel): add LocaltunnelProvider — Tier-2 consent-gated relay backend.**

PR 4 of the tunnel-failure-resilience chain. Adds the
`LocaltunnelProvider` implementation of the `TunnelProvider` interface
from PR 1. This is the relay backend the upcoming consent state
machine (PR 5) will activate when Cloudflare is unavailable and the
owner approves.

What's new:

- `src/tunnel/LocaltunnelProvider.ts` — implements `TunnelProvider`
  with `name: 'localtunnel'`, `tier: 2`. `isAvailable()` returns true
  only when the `localtunnel` npm package is installed (dynamic-import
  with graceful degradation when absent — agents without the dep see
  the provider report unavailable and the manager skips it). `start()`
  spawns the localtunnel client and surfaces the `.loca.lt` URL.
  `stop()` closes the client cleanly.
- Failure classification matches the existing
  `ProviderFailureReason` enum: rate-limit responses surface as
  `rate-limited`, network failures as `network`, anything else as
  `process-exit`.

Behavior is unchanged for users today: the manager's provider pool is
still Tier-1 only. The provider class is added to the codebase so the
next PR can wire it into the pool behind the consent gate without
touching the underlying provider implementation again.

What's NOT new yet (deliberate, future PRs in the chain):

- The state-machine transition into `awaiting-consent` when Tier-1
  exhausts (PR 5).
- The inline-button consent UX in the owner DM (PR 5).
- The Telegram `callback_query` handler that grants consent on a
  matching nonce (PR 5).
- The `relay-active` activation path that actually starts the
  LocaltunnelProvider after consent (PR 5).
- `authToken` / PIN rotation on relay-episode end (PR 6).
- Full N-consecutive-success self-heal stability gate (PR 7).
- The auth-gated `/tunnel` route + `ConfigDefaults` migration + agent-
  awareness CLAUDE.md template (PR 8).

The lifecycle state machine already supports all of these; the manager
just doesn't transition into the relevant states yet. This PR is
narrowly the relay backend.

## Evidence

7 new unit tests in `tests/unit/localtunnel-provider.test.ts`:

- Surface: `name === 'localtunnel'`, `tier === 2`, exposes the
  `TunnelProvider` interface.
- Graceful degradation: `isAvailable()` returns false when the
  `localtunnel` npm package is not installed; `start()` rejects with
  the `binary-missing` classification under the same condition; the
  "unavailable" verdict is cached across calls.
- Constructor options: accepts a custom start timeout and an optional
  subdomain hint.

`tsc --noEmit` clean. `npm run lint` clean. No existing tests modified.

The actual relay-active flow (manager driving the provider after
consent) is exercised end-to-end in the integration tests landing in
PR 5; this PR ships the provider class in isolation so security review
can focus on the surface.

## What to Tell Your User

This release adds plumbing for a backup tunnel option that the
upcoming release will activate. Nothing visible to you yet — the
backup is offered only when Cloudflare is fully unavailable, and only
after you tap an approval button in your DM. This release just puts
the backup capability in the codebase; the next release wires it into
the failure path.

If you want the backup capability to be available when the next
release lands, install the `localtunnel` npm package alongside your
agent. Without it the backup option will silently be unavailable and
the agent will continue retrying Cloudflare. Details on how to do
this safely (exact-version pin, etc.) will land in the next release's
guide.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| LocaltunnelProvider class | Internal — wired into the active pool in the next release |
| Graceful degradation when `localtunnel` npm dep is absent | Automatic — provider reports unavailable, manager skips it |
