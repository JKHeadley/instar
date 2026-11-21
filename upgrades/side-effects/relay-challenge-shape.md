# Side effects: relay login challenges are signed only when they look like one (SEC-133)

In plain words: the agent signs the relay or registry login challenge with its identity key only when the challenge has the exact shape the real relay sends, so a relay cannot get anything else signed with that key.

Tier 1. Size: 2 source files edited, 1 new small helper (shape check and refusal report), 1 new unit test file.

## What changes for running agents
- `isRelayChallengeNonce(nonce)`: a string of exactly 43 base64-alphabet characters plus one `=`, decoding to 32 bytes. That is what `src/threadline/relay/ConnectionManager.ts` mints (`crypto.randomBytes(32).toString('base64')`).
- `RelayClient`: any other challenge gets no signature. It is handled like a failed login: `connect()` rejects with "Auth refused: the relay sent a login challenge that is not 32 random bytes", the back-off starts at about 32 seconds (as for a rate-limited login), and the socket closes with code 4000. If the bad challenge arrives after login, it also emits `disconnected` so waiting callers are released at once. It emits `challenge-refused`, never `error`: on the server path nothing listens for `ThreadlineClient`'s `error`, and an unhandled `error` event would exit the server process.
- `RegistryRestClient.authenticate`: rejects with "Registry auth refused: the relay sent a login challenge that is not 32 random bytes", and closes.
- Refusals are reported to the degradation reporter, at most once per relay host per 10 minutes, (`RelayClient.challengeRefused` / `RegistryRestClient.challengeRefused`), naming the relay host, so it shows in the agent health degradations and the operator can see a relay keeping the agent off the network.
- A real challenge is signed exactly as before (raw UTF-8 bytes of the nonce), so every deployed relay keeps working, with no protocol or version change.

## What this closes and what it does not
- Closed: the signing oracle. Every other thing this key signs has a different shape and cannot pass the check: pair-verify receipts carry a context string plus length bytes including NUL, handshake answers sign a raw 32-byte digest, and envelopes sign JSON.
- Not closed: a dishonest relay can still pass a genuine challenge from another relay through to this agent and use the answer to log in there as this agent. Closing that needs the signature to name the relay, a relay-side change with a compatibility window. It is step 2, tracked as commitment CMT-025 on the M5 (m_a804869356): spec converged and PR opened by 2026-11-28 17:00 PST.

## Known pre-existing risk (not in this PR)
Any relay `{type:'error'}` frame makes `RelayClient` emit `error`, which `ThreadlineClient` re-emits with no listener on the server path, so a relay can still crash the agent server that way. This predates SEC-133 and was reported to the Chief of Staff as its own finding.

## Signal vs authority
Refuses to produce a signature; grants nothing.

## Rollback
Revert the commit. No state change.

## Tests
- `tests/unit/relay-challenge-shape.test.ts` (new):
  - the shape check accepts 50 real-style challenges and refuses receipt bytes, JSON, 32-byte hex, 16-byte base64, broken padding and a trailing newline;
  - the real `RelayClient` against a ws stand-in relay signs a real challenge, and the signature verifies against the identity key;
  - with no `error` listener attached, it sends no signature for the bytes of a pair-verify receipt; `connect()` rejects, one `challenge-refused` event fires, and the refusal is reported as a degradation (fails on main);
  - the report is throttled to once per relay host per 10 minutes;
  - `RegistryRestClient.authenticate` refuses a forged challenge.
- Also pass: `relay-connection-observer`, `threadline/identity-single-writer`, `a2a-backup-routes`, `threadline/ack-stage-wiring`, `a2a-cross-machine-route`, `no-silent-fallbacks`.
- Integration and e2e tests that run the real relay were not run on the M5, per the machine rule; they use real relay challenges, which pass the check.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. It checked every place the identity key signs and every verifier, and confirmed the shape check closes the signing oracle: no signed format can be a 44-character base64 string, and no other code signs relay-chosen bytes raw.

- First pass: do not concur. The blocking finding: the refusal emitted `error`, which `ThreadlineClient` re-emits with no listener on the server path. A hostile relay could therefore crash the agent server, and the reviewer reproduced it.
- Fixed: `challenge-refused` instead of `error`; `connect()` now rejects instead of hanging; about 32 seconds of back-off; reports throttled.
- Second pass: concur. It re-ran its crash probe, which now raises no uncaught exception, and confirmed every `connect()` caller handles the rejection.

Non-blocking notes: a bad challenge after login left waiters to time out (fixed: `disconnected` is emitted). An outside `connect()` can skip the back-off; that predates this change and also applies to `auth_error`. Relayed challenges are CMT-025. The pre-existing crash on a relay `error` frame was reported to the Chief of Staff as its own finding.
