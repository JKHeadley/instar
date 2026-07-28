# Side-Effects Review — LiveTestSlackCaller (xoxc web-client Slack sender for the live-test harness)

**Version / slug:** `xoxc-slack-caller`
**Date:** `2026-06-16`
**Author:** Echo (autonomous)
**Second-pass reviewer:** not-required (Tier 2; dev-gated test-harness-only surface, no fleet runtime path)

## Summary of the change

The gold-standard live-test harness's multi-machine capstone route
(`POST /live-test/multi-machine-capstone`) constructs its Slack demo sender with
`new SlackApiClient(demoSlackUserToken)` — a Bearer-only transport. The only
DISTINCT non-Echo Slack senders we have captured for the demo workspace are real
test-USER identities authenticated as a browser is: an `xoxc-…` web-client token
+ the user's `d` session cookie. These are valid (verified via `auth.test`) but
are NOT Bearer tokens, so the route's Slack arm could not actually post AS a real
member — defeating the standard's purpose (drive REAL channels as a real user).

Files added:
- `src/core/LiveTestSlackCaller.ts` — a `SlackCaller` adapter (the seam
  `SlackLiveSender` already consumes). `chat.postMessage` → posts AS the member
  via xoxc-in-body + `d` cookie header against the workspace host; every other
  method → Bearer bot token at `slack.com`. Pure transport over an injectable
  `fetch`.
- `tests/unit/LiveTestSlackCaller.test.ts` — fake-fetch unit tests asserting the
  two transports, undefined-param skipping, and loud constructor validation.
- `upgrades/next/xoxc-slack-caller.md` — release fragment.

Files modified:
- `src/server/routes.ts` — the capstone route's Slack branch: detect an `xoxc-`
  sender by prefix; when so (and the `d` cookie + workspace host + a Slack bot
  token are configured) wire `SlackLiveSender({ api: new LiveTestSlackCaller(...) })`;
  otherwise keep the existing Bearer `SlackApiClient` path. Adds config keys
  `liveTest.demo.slackUserCookie` + `liveTest.demo.slackWorkspaceHost` to the
  read-type and reads Echo's own bot token from `ctx.config.messaging` (slack)
  for the history reads.

## Decision-point inventory

- **Added**: `src/core/LiveTestSlackCaller.ts` `call()` method-routing branch —
  routes `chat.postMessage` to the member (web-client) transport vs everything
  else to the Bearer bot transport. A *transport-selection* decision, not a
  message-flow gate.
- **Modified**: `src/server/routes.ts` capstone Slack branch — a new
  `isXoxcSender` discriminator selects which sender to build. Fail-closed:
  missing cookie/host/bot-token records a loud `blockedSurfaces` entry (a real
  driver-error FAIL), never a fabricated reply or a silent fallback.

No agent-to-user message-flow decision points are added. This is developer
test-harness infrastructure behind the dev-gated live-test runner.

## Roll-up across the seven review dimensions

1. **Over-block**: none. The change only adds a new credential path; the
   pre-existing Bearer path is preserved verbatim for non-xoxc tokens. A missing
   credential records the same kind of loud blocked-surface the route already
   used.
2. **Under-block**: none. No gate was loosened. The xoxc path still requires the
   `d` cookie + workspace host + a bot token; absence is recorded as a FAIL, not
   waved through.
3. **Level-of-abstraction fit**: correct. The credential mechanics live in a
   dedicated adapter implementing the existing `SlackCaller` seam — the same
   seam `SlackLiveSender` already depends on — so `SlackLiveSender` is unchanged
   and the transport detail is isolated and unit-testable.
4. **Signal-vs-authority compliance**: N/A to message flow. The only decision is
   transport selection + a fail-closed blocked-surface record; no message is
   blocked, delayed, or rewritten. No silent try/catch (inline guards throw
   loudly) — complies with the no-silent-fallbacks ratchet.
5. **Interactions**: the route now reads Echo's own Slack bot token from
   `ctx.config.messaging` for history reads. This is read-only config access
   already used elsewhere in the same file (precedent at the channel-invite
   path). No new mutation, no shared state.
6. **External surfaces**: a new outbound HTTP path to `https://<workspaceHost>/api/chat.postMessage`
   carrying an `xoxc` token + a `d` cookie — but ONLY when an operator has
   configured those demo creds and the dev-gated live-test runner is invoked.
   The xoxc token + cookie are credentials of a throwaway demo test user, never
   the operator's, and never logged (the adapter logs only `ok`/`ts`). No change
   to any fleet runtime path.
7. **Rollback cost**: low. Single revertable commit; the new file is additive;
   the route change is a guarded branch that falls back to the prior Bearer path
   when the xoxc discriminator is false. No persistent state.

## Credential-handling note

The adapter handles two secrets: the member `xoxc` token (form body) and the
`d` session cookie (Cookie header). Both belong to a throwaway demo workspace
test user, are supplied via `liveTest.demo.*` config, and are never written to
logs — the adapter's logger emits only `ok` and `ts`. The Bearer history-read
token is Echo's own bot token, already present in `ctx.config.messaging`.

## Evidence pointers

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/LiveTestSlackCaller.test.ts` — 4/4 pass (asserts
  xoxc-in-body + cookie + NOT-Bearer for postMessage; Bearer-bot for history;
  undefined-param skip; loud constructor validation).
- Ratchets green: `tests/unit/no-silent-fallbacks.test.ts`,
  `tests/unit/CapabilityIndex.test.ts`,
  `tests/unit/feature-delivery-completeness.test.ts`.
