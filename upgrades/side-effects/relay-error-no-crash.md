# Side effects: a relay error frame can no longer crash the agent server (SEC-136)

In plain words: a relay error frame that no part of the agent listens for is now logged and shown as a health degradation instead of being thrown, which used to exit the agent server.

Tier 1. Size: 3 source files edited, 1 new small helper, 1 new unit test file.

## What changes for running agents
- `ThreadlineClient`'s handler for `RelayClient`'s `error` still runs `handleRelayErrorFrame` (ban handling) first, unchanged. It then emits `error` only when `listenerCount('error') > 0`; otherwise it calls `reportUnheardRelayError`.
- `RelayClient`'s message handler: a frame that is not an object with a text `type` (for example the JSON `null`) is dropped and reported as `malformed-frame`; the whole `switch` runs inside a try/catch, so a frame whose fields are the wrong shape (a challenge with no nonce, an `auth_error` whose message is not text, or anything a listener throws on) is reported as `bad-<type>-frame` and never throws out of the socket callback.
- `ThreadlineClient`: `handleIncomingMessage` accepts an envelope only when `from` and `payload` are text and every other envelope field (`to`, `threadId`, `messageId`, `timestamp`, `nonce`, `ephemeralPubKey`, `salt`, `signature`) is text or absent (`isWellFormedEnvelope`); anything else is dropped and reported as `malformed-envelope`, before any `unknown-sender` or `message` event; `ingestDiscoveredAgents` ignores anything that is not a list, and skips entries that are not objects with a text `agentId`.
- `ThreadlineBootstrap`: the bodies of the two async relay listeners (`message`, `unknown-sender`) run inside try/catch. Before, a throw there (including a rejected inbound gate evaluation) became an unhandled rejection, which the server treats as fatal; now it is reported as `inbound-message-listener-failed` / `unknown-sender-listener-failed`.
- The un-awaited pairing-op gate evaluation in the `unknown-sender` listener has its own `.catch` (reported as `unknown-sender-gate-failed`).
- `RelayClient` makes `auth_ok.sessionId` and `displaced.reason` text before passing them on.
- `reportUnheardRelayError`: one `console.warn` line and one `DegradationReporter` event (`ThreadlineClient.relayErrorFrame`) per code per 10 minutes, and, for codes the relay does not document, at most 5 reports in any 10 minutes across all of them, so cycling made-up codes cannot flood the 500-event store; documented codes (`RELAY_ERROR_CODES`, such as `banned`) keep their per-code limit only, so junk cannot hide them. The report names only the code; the relay's own words go only into the labelled log line, cleaned of control, bidi and line-separator characters and cut to 200 code points. It never throws.
- Code that listens for `ThreadlineClient`'s `error` (SDK users, the adapters in `src/threadline/adapters`) behaves exactly as before.

## Other emitters checked on this path
- `RelayClient` `error`: `ThreadlineClient` listens; `listener-daemon` listens (`listener-daemon.ts:281`).
- `WakeSocketServer` `error`: the server listens (`commands/server.ts:22530`); `listener-daemon` listens (`:472`).
- No other `emit('error')` exists under `src/threadline` or `src/messaging`.

## Signal vs authority
Turns a crash into a report; grants and blocks nothing.

## Rollback
Revert the commit. No state change.

## Tests
- `tests/unit/relay-error-frame-no-crash.test.ts` (new): a real `ThreadlineClient` logs in to a ws stand-in relay (real challenge, `auth_ok`), which then sends error frames.
  - No `error` listener: no uncaught exception; two frames give one degradation; control characters are gone. Fails on main with "Unhandled error.".
  - With a listener: the frame arrives and nothing is reported.
  - Malformed frames after login (`null`, a number, a string, `{}`, a null envelope, a discover result with no list, a non-list, or bad entries): nothing is thrown. Fails on main.
  - Malformed frames before login (a challenge with no nonce, an `auth_error` whose message is a number): nothing is thrown. Fails on main.
  - Fifty different codes give 5 reports in 10 minutes; a later one is reported; `banned` is still reported after junk codes used up the shared cap.
  - An envelope whose `from` only pretends to be text (`{ toString: 1 }`) never reaches an async `unknown-sender` listener that calls `String(env.from)`; no uncaught exception and no unhandled rejection.
- Also pass: `threadline/ack-stage-wiring`, `no-silent-fallbacks`, `ThreadlineClient-affinity`, `ThreadlineClient-encrypt-to-pinned`, `threadline/ThreadlineClient-resolve`, `ThreadlineClient-wire-thread`, `a2a-honest-delivery`, `relay-connection-observer`, `threadline/ThreadlineBootstrap`, `a2a-inbound-id-ledger`, `a2a-relay-unknown-sender-trust`, `feature-delivery-completeness`, `threadline/relayIngressHistory`, `a2a-local-route-signed-envelope`, `threadline/identity-single-writer`.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. It went three rounds.

- **Round 1: do not concur.** Malformed relay frames still threw inside the `RelayClient` socket handler. Examples were a JSON `null`, a challenge with no nonce, a numeric `auth_error` message, a null envelope, and a discover result with no list. The reviewer reproduced each one against the built code.
- **Round 2: do not concur.** An envelope whose `from` only pretended to be text reached the server's async `unknown-sender` listener. There it became an unhandled rejection, which the server treats as fatal.
- **Round 3: concur.** The reviewer re-ran its poison probe. It also tabled every relay-driven listener (`gate-passed`, `displaced`, the connection observer, the relay verdicts, `auto-discovered`, the REST adapter and discovery) and found none that a relay value can still turn into a throw or an unhandled rejection. It confirmed `isWellFormedEnvelope` refuses no legitimate sender.

Its round-3 non-blocking notes:
- The un-awaited gate evaluation: fixed with its own catch.
- Untyped `sessionId`/`reason`: made text at the boundary.
- `decodePlaintextPayload` passing a non-text `type` through: no crash path, since its consumers tolerate it; not changed here.
