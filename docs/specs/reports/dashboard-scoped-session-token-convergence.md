# Convergence report — dashboard-scoped-session-token (SEC-002b)

**Spec:** docs/specs/dashboard-scoped-session-token.md · **ELI16:** docs/specs/dashboard-scoped-session-token.eli16.md
**Reviewers each round:** internal lenses, the Standards-Conformance Gate (`POST /spec/conformance-check`), GPT-6 (codex-cli), and the Claude clean-door read (claude-code). Gemini/Grok unreachable this session (recorded, not blocking).

## What it is, in one paragraph

Today `POST /dashboard/unlock` returns the agent's MASTER API token to the browser on a correct PIN, and the browser uses it as Bearer on dozens of calls plus `/ws?token=` and SSE. So a guessed PIN (SEC-002 makes guessing hard, not impossible) or a stolen browser is a permanent, full-API compromise. SEC-002b returns a short-lived, revocable DASHBOARD-SESSION TOKEN instead — reusing the existing `DashboardOperatorSessionStore` mechanism, generalized into the dashboard's primary bearer — and the master token is never handed to the browser. `authMiddleware`, WS and SSE accept the scoped token; the client stores and silently refreshes it under an absolute lifetime cap; the master token stays valid for API/CLI/agent callers (back-compat). The blast radius of any dashboard-auth weakness shrinks from "the whole agent, forever" to "a dashboard session that expires and can be revoked." HIGH; defense-in-depth; ships behind a switch after the full live dashboard proof.

## Findings resolved (4 rounds, GPT-6 + Claude clean-door + conformance)

- **Sliding refresh defeats expiry.** A stolen token could refresh forever. Fixed: an ABSOLUTE lifetime cap (server-side store state, not signed claims), checked on every refresh.
- **Opaque vs signed model mismatch.** "Signed claims" contradicted the opaque-store model. Fixed: tokens are opaque; the cap + family root are server-side store state keyed by token.
- **Expiry didn't terminate open streams.** Auth at WS/SSE connect only → a thief's open stream outlived revocation. Fixed: open streams are CLOSED server-side on family invalidation; the client reconnects with a fresh token.
- **Revocation didn't kill refreshed successors.** Logout invalidated one token, not a thief's independently-refreshed ones. Fixed: a session FAMILY rooted at the unlock; revoke / PIN-rotation / absolute-cap kill the whole family.
- **Scoped token could escalate to the master.** A credential-read/PIN-change/rotate route would hand back the permanent master. Fixed in stages: first a credential-route boundary, then (clean-door) the insight that a blocklist can't bound INDIRECT reach → the airtight deny-by-default allowlist is explicitly deferred to SEC-002c, and SEC-002b's claim is scoped to LIFETIME + direct-credential reach.
- **"Operator-session proof" wasn't fresh.** It is returned alongside the bearer at unlock, so a storage thief holds it too. Fixed: credential operations require a live-PIN STEP-UP minting a one-time proof of a DISTINCT token type (a bearer/refresh-descendant is never accepted as a step-up proof); no existing owner capability is removed (re-entering the PIN is a normal confirmation).
- **Symbol scope clarified.** The lifetime bound is on a stolen TOKEN; a KNOWN PIN is SEC-002's domain (the throttle). Stated so "expires" is not mis-read as bounding a guessed PIN.
- **Machine-local key.** Classified `physical-credential-locality` — a session token is a bearer secret verified against one server's store, like the existing `DashboardOperatorSessionStore` / `PinAttemptStore`; replicating a bearer secret widens exposure for no gain. (The conformance gate contests this taxonomy choice as signal-only; the posture — a per-endpoint session — is behaviorally correct.)

## Residuals, stated honestly

- **Indirect master reach.** A live stolen scoped token keeps broad read/operate reach, so within its unexpired window a determined thief could try to reach the master INDIRECTLY (a config/file/log/backup read, a session spawn) rather than the named credential routes. A blocklist can't be proven complete; the airtight answer is a deny-by-default ALLOWLIST of exactly the dashboard's routes — the larger per-route project deferred to SEC-002c. SEC-002b still delivers permanent-master → expiring+revocable+family+step-up, a large real reduction.
- The absolute cap means a genuinely continuous session re-authenticates once per cap window; a conservative default (7 days) makes this rare and is strictly safer.
- The exact defaults (24h token / 7-day cap) are operator-tunable; the invariant is that a finite absolute cap EXISTS (recorded as an invariant decision row). Conformance's "Judgment Within Floors" note is this signal-only numbers point.

## Verification plan

Unit (session-token store issue/verify/expire/invalidate), integration (unlock returns a non-master token accepted as Bearer + WS + SSE; master not in the response; refresh/revoke/expiry; non-browser master-token back-compat), e2e feature-alive, and the full live-user dashboard proof across every tab + live stream + operator-gated action BEFORE the operator is asked to test. Build sequenced after SEC-002 (#3211) merges, since both touch the unlock handler.

## Status

Converged after 4 rounds: the substantive design holes (sliding refresh, stream termination, session family, master escalation, stale operator proof, token-type confusion) are all resolved, and the remaining conformance flags are signal-only (the numbers note and the machine-local taxonomy choice) plus the explicitly-deferred SEC-002c boundary. The build follows #3211's merge (both touch the unlock handler).
