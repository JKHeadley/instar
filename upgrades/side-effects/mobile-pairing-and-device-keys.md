# Side-Effects Review — Mobile pairing link + device keys

**Version / slug:** `mobile-pairing-and-device-keys`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

One release adds pairing links and per-phone device keys for the Instar iPhone app (specs: `docs/specs/mobile-pairing-link.md`, `docs/specs/mobile-device-keys.md`). `src/core/MobilePairing.ts` (pairing codes, limiters, v1 link) and `src/core/MobileDeviceKeys.ts` (device registry, confirmation codes, low-S ECDSA verification, replay guard) are new. `src/server/mobilePairingRoutes.ts` adds the routes and the device authenticator. `middleware.ts` gains two exact public exemptions and the device check (before the bearer comparison, never on `/internal/*`). `AgentServer.ts` keeps raw request bytes on every JSON parser and wires the service. `TelegramAdapter.ts` adds the owner-DM-with-Decline send, the owner-only Decline handling and the inbound code scan; `routes.ts` routes the verified Decline tap, runs the scan on forwarded messages and strips view signatures from history served to a phone. `site/` adds the instar.sh `/pair` page and the app association file. Dev-gated. Tier 2: ~1,000 lines across 14 source files plus tests; both specs converged at the 6-round cap.

## Decision-point inventory

- Pairing code redeem (accept/refuse, transport, Host, tunnel, limiter) — add.
- Device becomes active (owner-DM code typed into the phone, 3 distinct tries, 24h budget, lease, boot expiry) — add.
- Device-signed request accepted (allowlist, low-S ECDSA, ±60 s, replay, rate) — add.
- Bearer middleware — modify: two exact public exemptions; device headers judged only by the device check.
- Telegram callback handling — add: `md:d:` Decline, owner-only, verified only.
- Inbound Telegram text — add: a live pairing code voids its pairing before logging.

## 1. Over-block

A real pairing fails when: the owner has never messaged the bot (409 with the fix); the serving lease moves during the 15 minutes (expired, pair again); the server restarts mid-pairing (expired); ten wrong codes were typed in 24 hours (paused, attention item); a message happens to contain six digits equal to a live code (that pairing is cancelled; negligible odds). A phone cannot reach routes outside the allowlist (by design); the embedded dashboard keeps the PIN.

## 2. Under-block

A process running as the agent's OS user can read the bot token, the lifeline secret and in-flight outbound bodies: out of scope, stated in the spec. A captured read can be replayed within 60 s after a restart (all allowlisted requests are idempotent). A revoke issued on a machine that cannot reach the holder answers 202 and the phone keeps access until the holder confirms (stated in the response).

## 3. Level-of-abstraction fit

Device authentication sits in the one bearer middleware every route already passes, as an alternative principal, with an exact allowlist so no route is exposed by accident. The human anchor reuses the existing owner-DM and owner-only button patterns. State is a small JSON registry read per request (no in-memory authority to diverge).

## 4. Signal vs authority compliance

Every blocking decision is a cryptographic or exact check on the agent's own credentials; the one human step is the owner reading a private code. No detector or heuristic gains authority.

## 4b. Judgment-point check

No competing-signals decision point; nothing judgment-based is added.

## 5. Interactions

Does not touch the PIN route's counters or operator sessions. Middleware: device check after the public exemptions, before the bearer comparison; `/internal/*` refuses device principals. Every JSON parser now stores `req.rawBody` (a Buffer reference; no copy). The Decline tap in `/internal/telegram-callback` uses the existing dedupe claim store. The inbound scan runs before logging on both inbound paths and is a no-op with no live codes. Token rotation no longer affects phones (they hold no token), so the rotation notice is unchanged.

## 6. External surfaces

New public endpoints (redeem, ping) on the agent tunnel; instar.sh `/pair` and `/.well-known/apple-app-site-association`; a private Telegram DM to the owner with a Decline button. The v1 link, the device signature format and the confirm/revoke routes are a published interface with the TestFlight app (updated in the same release).

## 6b. Operator-surface quality

Phone-first: tap a link, read a 6-digit code in Telegram, type it into the app. The DM says what to do and what not to do, with a Decline button. Errors are plain sentences with the next step. The instar.sh page covers the laptop case (QR, copy link).

## 7. Multi-machine posture

Device records are machine-local by design (bound to one machine's hostname; `.instar/state/` is git-ignored), read across machines with `GET /mobile/devices?scope=pool`. Pairing only completes on the lease holder. Revoke applies on the holder, forwards to peers, and reports 202 honestly when unconfirmed. A tunnel move means pair again.

## 8. Rollback cost

`mobilePairing.enabled: false` turns off pairing and device authentication (device headers then authenticate nothing). Records are inert JSON. A code revert removes both features together; the token-returning redeem never existed in a release.

## Conclusion

Phones get revocable credentials anchored in the owner's private chat, never the agent's token, and only a short allowlist of idempotent requests. Dev-gated, with honest limits stated.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact: concern → resolved, concur.** No outsider bypass found (tried device+bearer headers, case/trailing-slash, %2F, `..`, double slashes, duplicated headers); the token is never returned; codes are HMAC-only and never logged; Decline and leak scan behave as specified. Concerns, all fixed: (1) lease loss now voids codes through a 5-second lease watch, so a code issued before a lease move cannot confirm after it returns; (2) three wrong codes now DM the owner; (3) the code is consumed only after the activation write succeeds; (4) a chunked body without raw bytes is refused 415. Minor notes applied: a failed Decline write is caught and reported; expired codes and nonces are pruned; captions are scanned too.

## Evidence pointers

- Specs and convergence reports: `docs/specs/mobile-pairing-link.md`, `docs/specs/mobile-device-keys.md`, `docs/specs/reports/`.
- Tests: `tests/unit/mobile-pairing.test.ts` (11), `tests/unit/mobile-device-keys.test.ts` (13), `tests/integration/mobile-pairing-routes.test.ts` (18), `tests/e2e/mobile-pairing-alive.test.ts` (2).

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** No self-triggered loop. The 5-second lease watch only expires pending pairing records and clears in-memory codes (idempotent, no outward action, no retry). Owner DMs fire once per user-caused event (a wrong-code decline or a code pasted into a chat), bounded by the 10-wrong-codes-per-24h budget and the 10-live-codes cap.

## Follow-up: unit-gate fixes (no behavior change)

The first local verify failed on repository gates, not on behavior: the route-discoverability lint now reads `mobilePairingRoutes.ts`; the CLAUDE.md section is listed in the parity test; five already-reported catch blocks carry the `@silent-fallback-ok` marker; and one integration assertion that a redeem answer contains no six-digit run (which a random device id can contain) now checks that the actual code is absent.
