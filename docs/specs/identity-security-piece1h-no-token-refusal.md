---
title: "A missing or unreadable API key: safe, visible, and the owner decides"
slug: identity-security-piece1h-no-token-refusal
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1h-no-token-refusal.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Signal vs. Authority; Security Fixes Keep the Experience Whole; The Person Decides, the Agent Does the Rest; An Instar Agent Is Always a Multi-Machine Entity"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 1 and section 10 (known-invalid authentication refused at once; any other enforcement observed first and decided by the owner per agent)"
split-from: "identity-security-piece1b (round 1 reviewed this as its §1)"
lessons-engaged: "a-dark-guard-is-worse-than-no-guard, no-single-device-lockout, spec-reviews-not-falling-means-cut"
review-convergence: "2026-11-18T10:35:00Z"
review-iterations: 2
review-completed-at: "2026-11-18T10:35:00Z"
review-report: "reports/identity-security-piece1h-no-token-refusal-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1 and 2; gemini-cli gemini-4-argon (as piece 1b round 1)"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# A missing or unreadable API key: safe, visible, and the owner decides

## Problem statement

Two broken states of the agent's API key (`authToken`):

1. **Unreadable key.** The config holds a `{ "secret": true }` placeholder because the secret store failed to load it. `Config.ts:976` stops only non-loopback binds, and a loopback bind is what a tunnel forwards to. Every compare then hashes an object and throws: the middleware compare (`middleware.ts:~588`), `bearerMatches` (`:221`), the WebSocket `verifyToken` (`WebSocketManager.ts:344`), `/jobs/events` (`routes.ts:~21270`) and `verifyViewSignature`. Requests fail with a crash instead of a clear refusal. The lifelines send `Bearer [object Object]`.
2. **No key.** `authMiddleware` lets everything through (`middleware.ts:284`), `bearerMatches` returns true, the WebSocket admits everyone, and `/jobs/events` skips its check. Fresh installs always get a key from `instar init`, so this affects legacy installs. Sessions on such an install start with `INSTAR_AUTH_TOKEN="undefined"` (`SessionManager.ts:5036, 5525`), and some lifeline calls send `Bearer undefined` (`TelegramLifeline.ts:475, 494`).

Two review rounds (this was §1 of piece 1b, then piece 1h round 1) showed that creating a key automatically causes more harm than it prevents. Running sessions keep the old value in their environment, so their replies are refused. Each machine would mint a different key. The lifelines keep a stale key and stop delivering. Umbrella section 10 makes closing an open API the owner's per-agent decision, not an automatic one. This spec therefore makes both states safe and visible. It changes nothing for the no-key case until the owner decides (piece 5's card).

## Proposed design

### 1. An unreadable key is refused cleanly, always

A non-string key is known-invalid authentication (umbrella section 10: refused at once). At every compare site, a placeholder or any other non-string key is never hashed:

- **Auth middleware:** every credential with its own proof is judged first, as today: device keys, mesh RPC signatures, Threadline peer routes, document pages, pairing codes, Secret Drop, the unlock route, view signatures, the dashboard's `dst_` session tokens and `mps_` session tokens. A request with no bearer gets the ordinary 401. Only at the final key comparison does a non-string key get `503 { error: 'agent-credential-unavailable' }`. Absent means `undefined`, `null` or empty; any other non-string value (a placeholder, `false`, `0`) is unreadable, never "no key".
- `bearerMatches`, the WebSocket upgrade, `/jobs/events`, `verifyViewSignature`, the dashboard unlock route (which checks `!authToken` and then signs a marker with it) and every other place that hashes, signs or compares with the key refuse cleanly for a non-string key. A unit test scans `src/` for uses of `config.authToken` in a hash, HMAC or compare and fails on any without the check.
- The server raises one owner security item, `agent-api-key-unreadable`: "Your agent's stored API key could not be loaded, so its API is refusing requests. Your agent is retrying; if this lasts, ask it to repair the secret store." First the server re-reads the store (the same merge `loadConfig` uses) with backoff: 1, 2, 4… minutes, up to 30. It raises the item only after 3 failed re-reads. A successful re-read restores service and closes the item. The re-read stops after 24 hours of failures, and the item says so.

### 2. No key: unchanged, counted, and the owner is told

- Requests are served exactly as today. **Observe log (umbrella section 10):** each request that would have needed the key is recorded in feature evidence (`security.agentApiKey`) with its caller: method, path, remote address, user agent, the `X-Instar-AgentId` and `X-Instar-Session` headers. Health probes (`/health`, `/ping`) are not recorded. Rows are keyed by route (first path segment), at most one per route a minute and at most 64 distinct routes (then `other`), so traffic cannot grow the log. This is the record the owner's per-agent enforcement card (piece 5) reads to explain each would-refuse before the floor allows enforcing.
- **One notice, the existing one.** The coherence check already tells the owner, in the Agent Attention topic: "My API doesn't have an auth token set, which means anyone with the URL could access it. Reply "fix auth" to lock it down." (`server.ts:~5064`). That stays the single notice; no second item is added. The owner's reply "fix auth" is the yes, and the agent does the rest.
- **The "fix auth" handler is made safe** (`server.ts:~585`). It creates a 32-byte key (today 16), saves it with a checked write (it reports failure instead of "Done!" when the write fails), sets it on the running config so the server uses it at once, and never posts any part of the key (today it posts the first 8 characters). Its reply says what happens next: message relays pick the key up on their own, sessions started earlier use it after they restart, and on a multi-machine agent the same key must reach every machine (the reply names the machine it was set on, and the agent copies it through secret sync, or tells the owner it could not).
- Enforcing a refusal on a no-key agent is the owner's per-agent choice on piece 5's card. This spec adds no enforcement.

### 3. The relays never send a bogus key and recover on their own

- One header helper in the Telegram lifeline (`TelegramLifeline.ts`) builds every lifeline→server request (the forward, the callback, the topic-name and pin forwards, the lifeline proof, notification classify and origin diagnose). It adds `Authorization` only for a non-empty string key, never `Bearer undefined` or `Bearer [object Object]`.
- On any bearer refusal, the lifeline re-reads the key through the same merge `loadConfig` uses, once per request, and retries. A bearer refusal is a 401 that is not a lifeline-secret refusal, a 403 `Invalid auth token`, or a 503 `agent-credential-unavailable`. This covers the forward and the callback (the owner's button taps). A burst of refusals costs one re-read: re-reads are at most one every 5 seconds. A 503 `agent-credential-unavailable` is not read as "server booting". This is always on: it acts only on a refusal, so it fixes a key changed by `fix auth`, by self-heal or by a peer's sync push.
- `SessionManager` never puts a non-string key in a session's environment: `INSTAR_AUTH_TOKEN` is the key for a string key and explicitly empty otherwise (never unset, so tmux's own environment cannot leak in). Today a token-less install exports the literal `"undefined"`, and scripts that prefer the environment use it instead of reading the config. Running sessions therefore keep working after "fix auth": a session started under this release has an empty `INSTAR_AUTH_TOKEN`, and the reply scripts and hooks read `${INSTAR_AUTH_TOKEN:-<config>}`, so they pick the new key up from the config on their next call. A session started before this release holds the literal `"undefined"` and is refused until it restarts; the "fix auth" reply says so, and the existing "restart sessions" reply restarts them.
- A re-read that throws (an unreadable config) keeps the message queued and is retried, never crashes the lifeline.

### 4. Owner notices

The notices use the existing owner security-item pattern (`raiseLockedSecurityItem` in `AgentServer.ts`): a Telegram attention item with a stable condition key when Telegram is configured, else the local attention list plus a phone push. The pattern is generalised here into `raiseOwnerSecurityItem` and `closeOwnerSecurityItem`, which piece 1i would also have used. One row per condition, retried if the write fails.

## Decision points touched

- **A non-string key is refused at every compare site** — invariant; basis: irreversible-consequence; evidence: hashing it throws today, and a placeholder is never a valid credential (umbrella section 10, known-invalid).
- **No key: no enforcement here** — invariant until the owner's per-agent card; basis: external-constraint (umbrella section 10).
- **Lifeline re-read on any bearer refusal, once per request** — invariant; basis: external-constraint (the lifeline outlives a key change).
- **Store re-read backoff 1→30 minutes, item after 3 failures, stop after 24 hours** — judgment-candidate; floor: bounded work and the owner is told within about 10 minutes; arbiter: Echo. Evidence: a re-read is one local file read plus a secret-store decrypt (milliseconds), so even the 1-minute start costs nothing; the store's usual failure (a locked keychain, a vault that has not synced yet) clears in minutes or not until a person acts, so 3 re-reads (about 7 minutes) separate a blip from an outage; 24 hours bounds an agent left alone. While the key is unreadable the whole API refuses requests (Telegram messages wait in their queue), an outage the owner already feels, so telling them at about 7 minutes, with the retry still running, is the floor rather than early noise. Self-healing has no further step to try than re-reading the store.
- **Lifeline re-read at most once per request and once every 5 seconds** — judgment-candidate; floor: a burst of refusals costs one config read; arbiter: Echo. Evidence: a key changes by a person's action or a sync, minutes apart; 5 seconds keeps a refusal storm to one read while a real change is picked up on the next message.

## Frontloaded Decisions

1. No automatic key creation. The fix for no key is agent-performed after the owner's yes.
2. No switch: the unreadable-key refusal replaces a crash, the relay and session fixes act only on refusal or a non-string value, and the no-key case changes nothing but adds a count and a notice.

## Multi-machine posture

- This spec does not create, copy or rotate the key, so it introduces no new divergence. Each machine reports its own key state (machine-local-justification: the notice describes this machine's listener); attention items merge across the pool with `?scope=pool`.
- Lifeline re-read: per machine.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Key usable | a non-empty string in `authToken` | requests can be authenticated | a real request through the mounted middleware succeeds with that key (the E2E test and the throwaway proof); the compare reads the same live getter | treated as unreadable: refused |
| Lifeline key stale | a bearer refusal | the server's key changed | the re-read value succeeds | message re-queued, as for a secret refusal |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Throwaway with a placeholder key: protected route 503 (not a crash), `/health` works, the unreadable item appears after the third failed re-read and closes when the key loads, with no restart. Then with no key: the real lifeline process forwards a message to the real server with no key; the key is set and only the server restarted, and the next message arrives after the lifeline re-reads the key. Telegram's own API is answered by a fetch shim in the lifeline: a real message from the owner's account into a test group needs a per-destination browser-send allowance that only the owner can grant. | Discard. |
| dev-agent-live | Echo has a key: the code paths run without change. | Revert. |
| fleet | Released with the merge. | Patch release. |

## Tests and evidence

- **Unit:** middleware with a placeholder (each exemption reachable, compare 503, nothing hashed); `bearerMatches`, WebSocket, `/jobs/events`, view signature with a placeholder; no-key behaviour unchanged plus counting; the lifeline header helper (no header for a non-string key); re-read on 401 non-secret, 403 invalid token, 503 credential-unavailable; no re-read on a lifeline-secret 401; `SessionManager` env with a missing key; store re-read backoff and the 3-failure item.
- **Integration:** a mounted server with a placeholder key: exemptions reachable, protected route 503.
- **E2E alive:** a placeholder agent boots and answers 503 on a protected route instead of crashing; a no-key agent serves as today and raises the missing item.

## Maturation plan

- **ladder:** not applicable: no switch, the changes replace a crash with a refusal or act only on refusal, and the no-key case adds only a count and a notice
- **test-agent-live:** the rollout rows above.
- **dev-agent-live:** the code paths on Echo.
- **fleet:** with the merge.
- **graduation criterion:** green Local Verify, merged commit, throwaway proof.
- **dark-window:** none; no-key enforcement waits for piece 5's card.

## Open questions

*(none)*

## Review rulings (round 2, cross-model)

- **Enforcement on no-key agents inside piece 1:** umbrella section 12 item 1 names it, and section 10 says how it happens: observe first, with the caller logged, then the owner's per-agent card with its floors (no unexplained scheduled-job or owner would-refuse; each affected job has run). This spec delivers the observe log. The card and its floors are the card machinery of piece 5, which every observe-first change in the umbrella shares; building a one-off card here would duplicate it. Until then the owner's existing "fix auth" reply is unchanged in authority (made safer).
- **Binding "fix auth" to the owner:** an existing command, answered only in the Agent Attention topic; this spec adds no authority to it. Consent bound to a verified owner and the exact change comes with the cards (piece 5).
- **Inventory at cutover:** no key is created or rotated automatically, so there is no cutover here. Rotation with a consumer inventory is piece 4.
- **Creation across machines:** "fix auth" refuses on a multi-machine agent; nothing is copied automatically.
- **Local link and member isolation first:** the local link is piece 1a (PR 3406), member conversations are piece 1f; neither is changed here.
- **Retry bounds and recovery proof:** the hard bounds are in the decision points; recovery is shown by a real request succeeding with the loaded key and a wrong key refused (E2E and throwaway).
- **`false`/`0` read as no key; the 503 coming before `dst_`/`mps_`:** both fixed as described in section 1.

## Left behind

Refusing requests on a no-key agent (the owner's per-agent card, piece 5); general key rotation and the dashboard credential cutover (piece 4).
