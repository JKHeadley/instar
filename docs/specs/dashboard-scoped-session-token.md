---
title: Dashboard unlock returns a scoped, expiring session token — not the master API token
slug: dashboard-scoped-session-token
date: 2026-11-15
author: echo
parent-spec: dashboard-pin-throttle.md
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
parent-principle-fit: "Today unlocking the dashboard with the PIN hands the browser the agent's MASTER API token, which never expires and grants the full agent API. A guessed or stolen PIN, or a stolen browser, is therefore a permanent full-API compromise. This makes the dashboard log in with a short-lived, revocable session token instead — the owner's experience is unchanged, but the blast radius of a compromised PIN shrinks from 'the whole agent, forever' to 'a dashboard session that expires and can be revoked'."
binding-standards: ["Security Fixes Keep the Experience Whole", "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred", "Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails"]
eli16-overview: dashboard-scoped-session-token.eli16.md
security: true
approved: true
approved-note: "CoS-ratified 2026-11-15 (echo-chief-of-staff handoff 8afaa6e7, operator-delegated security program topic 141385). Three conditions folded in: (1) step-up declared as a degradation in User-visible-effect, kept light (rare ops, <=1/session, paired-phone device proof accepted); (2) full live dashboard proof (every tab + terminal + SSE + file edit + Remote Desktop at 1280 and 390, one broken tab fails) before the switch flips; (3) SEC-002c opened as its own tracked item."
review-convergence: "2026-11-16T02:23:37.078Z"
review-iterations: 4
review-completed-at: "2026-11-16T02:23:37.078Z"
review-report: "docs/specs/reports/dashboard-scoped-session-token-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Spec — Dashboard scoped session token (SEC-002b)

Source: Instar security program (operator, topic 141385, 2026-11-15), finding SEC-002b — the deferred second half of SEC-002 (the PIN throttle, PR #3211). Class-level public text: the class (the PIN unlock returns a long-lived high-privilege credential) and the mitigation (a short-lived, revocable session token), never a repro.

## Problem (class)

`POST /dashboard/unlock`, on a correct PIN, returns `token: configRef.authToken` — the agent's MASTER API bearer. The dashboard client stores it in `localStorage` (`instar_token`) and sends it as `Authorization: Bearer <master>` on dozens of calls, plus `/ws?token=<master>` (WebSocket) and the SSE event streams. Two consequences:

1. **A guessed or brute-forced PIN yields the master token** — full agent API, permanently, until the token is rotated. SEC-002 (the throttle) makes guessing hard but not impossible; SEC-002b limits what a successful guess is worth.
2. **A stolen browser / stolen localStorage is a permanent full-API compromise** — the master token does not expire and is not scoped to the dashboard or the browser.

HIGH. It is defense-in-depth that bounds the LIFETIME and direct-credential reach of a compromised dashboard session (permanent master token -> expiring, revocable session token); fully confining its indirect reach is the follow-up SEC-002c.

## Design

On unlock, return a **scoped dashboard-session token** and NEVER hand the master token to the browser. The mechanism already exists and is reused, not invented: `DashboardOperatorSessionStore` (`src/server/DashboardOperatorSessionStore.ts`) already mints short-lived tokens (`issue() -> {token, expiresAt}`, `verify(token)`, cleared on PIN-version change) — today used only for the `X-Instar-Operator-Session` operator-gated proof. This generalizes it into the dashboard's PRIMARY bearer.

### 1. Unlock returns the scoped token as the primary credential

`POST /dashboard/unlock` returns the scoped session token in `token` (the field the client already reads) instead of `configRef.authToken`. `operatorSessionToken` continues to be returned for the operator-gated-action proof. The master token is no longer sent to the browser.

### 2. The auth middleware accepts a valid scoped token as Bearer

`authMiddleware` (`src/server/middleware.ts`) accepts EITHER the master token (agent/API/CLI callers, unchanged — back-compat) OR a currently-valid, unexpired dashboard-session token. The scoped token is verified against the session store (constant-time compare, expiry checked, invalidated on PIN rotation). So every route the dashboard already calls keeps working with the scoped token, with no per-route change.

### 3. WebSocket and SSE accept the scoped token

`/ws?token=` and the SSE event streams (`/jobs/events?token=` and siblings) accept the scoped token by the same verification. Crucially, authentication at CONNECT time is not enough: an already-open WS/SSE connection is CLOSED server-side the moment its token's family is invalidated (expiry, revoke, or PIN rotation) — the store notifies open connections, which the client treats as a signal to reconnect with a refreshed token (or fall back to the PIN screen if the family is gone). Otherwise a thief's live stream would outlive revocation. A test drives an already-open stream through a revoke and asserts it closes.

### 4. The client stores and rotates the scoped token

The dashboard stores the scoped token (not the master) in `localStorage`. A refresh endpoint (`POST /dashboard/session/refresh`, authenticated by the current valid scoped token) returns a fresh token + expiry before the current one lapses, so a live session never drops at expiry. Refresh is bounded by an ABSOLUTE session lifetime (`absoluteMaxMs`, default 7 days from the original PIN unlock). The tokens are OPAQUE (random, like today's `DashboardOperatorSessionStore`); the absolute cap and the session-family root (below) are SERVER-SIDE state in the store keyed by the token, NOT signed claims — so they cannot be altered by a holder and need no JWT. Past the absolute cap, refresh is refused and the PIN is required again. This is what makes expiry actually bound a STOLEN token — a thief holding the token can slide it forward only until the absolute cap, not indefinitely — in addition to explicit revocation and PIN-rotation invalidation. All three lifecycle endpoints (refresh/revoke/step-up) are GATED behind `security.dashboardScopedToken.enabled` (404 when dark), so the feature adds NO surface in the dark default. The step-up endpoint verifies a live PIN and therefore shares the SAME brute-force limiter as `/dashboard/unlock` (per-client + global + durable `PinAttemptStore`, keyed identically; at the SEC-002 rebase both route through the merged PinThrottle) — it is never an unthrottled PIN oracle. A logout endpoint (`POST /dashboard/session/revoke`) invalidates the WHOLE session FAMILY, not just the one token. Every token refreshed from a single PIN unlock shares a family id (minted at unlock, carried in the store, inherited by each refresh); revoke, PIN rotation, and the absolute cap all invalidate the family root, so every successor token a thief may have refreshed dies at once. Without this, logout would leave a thief's independently-refreshed token alive. On expiry with no refresh, the client falls back to the PIN unlock screen.

### 5. Scope of the scoped token (what it authorizes)

The scoped token is **expiring + revocable**, and carries the dashboard's effective API reach EXCEPT that credential-management operations require a FRESH-PIN proof on top of the scoped bearer. Specifically, any route that reads or writes a standing credential — reading `authToken`, changing or reading the PIN, rotating the API token, issuing a new unlock/session — requires a STEP-UP: a fresh PIN re-entry at the moment of the operation, which mints a one-time, short-TTL proof consumed for that single operation. The step-up proof is a DISTINCT token TYPE from the session bearer, tagged as such in the store and verified by type: a session bearer (or any token refreshed from it) is NEVER accepted as a step-up proof, and a step-up proof is never accepted as a session bearer. It must NOT accept a previously-stored operator-session token either: such a token is returned alongside the scoped token at unlock, so a thief who stole the browser's storage would hold it too — it is not "fresh". Only a live PIN entry at the time — OR the paired phone app's device proof where that exists (a device the thief does not have) — mints a valid step-up proof. The step-up is kept as LIGHT as possible (operator condition, 2026-11-15): it is required ONLY for the rare credential operations, at most once per session (a successful step-up opens a short step-up window so a burst of settings changes is not re-prompted), and the paired-phone device proof is accepted in place of typing the PIN wherever the owner has a paired phone. This PRESERVES the owner's existing ability (re-entering the PIN to change settings is a normal, expected confirmation, not a lost capability), while a thief holding only stolen storage — scoped token AND the old operator-session token — can NEVER escalate to the master token nor mint a session that resets the absolute cap. Without this boundary the whole fix would be undone (a config-read route would hand back the master). Beyond that credential boundary, the scoped token keeps the dashboard's broad read/operate reach. **Honest residual (stated, not hidden):** because that reach is broad, a determined thief holding a live stolen scoped token could, WITHIN its unexpired window, attempt to reach the master token INDIRECTLY through some broad-reach route (a config read, a file/log/backup export, a session spawn) rather than the named credential routes. A blocklist of credential routes cannot be proven complete against every such indirect path. Fully confining the scoped token to a deny-by-default ALLOWLIST of exactly the routes the dashboard calls is the real answer, and it is precisely the larger per-route least-privilege project deferred to SEC-002c (bundling it here is the broad UX-breaking change the standard warns against). What SEC-002b DOES deliver is still a real, large blast-radius reduction: today a guessed PIN yields the PERMANENT master token forever; after SEC-002b it yields a session token that EXPIRES (absolute cap), can be REVOKED (whole family, including open streams), and cannot DIRECTLY read or rotate the master without a live-PIN step-up. The claim is scoped accordingly — SEC-002b bounds the LIFETIME and direct-credential reach of a compromised session; SEC-002c will bound its indirect reach.

## Decision points touched

| Decision point | Classification | Basis / floor |
|---|---|---|
| What credential unlock returns to the browser | invariant; basis: irreversible-consequence; evidence: returning the permanent master token makes any PIN compromise a permanent full-API compromise — the exact blast-radius this fixes; a short-lived revocable token is strictly less dangerous and the dashboard needs no permanent credential | Deterministic: unlock returns the scoped session token, never `configRef.authToken`. |
| Whether a Bearer is accepted | invariant; basis: enumerable-domain; evidence: a request's bearer is either the master (agent/API callers) or a store-verified unexpired session token, or it is rejected — a deterministic membership test, no judgment | Deterministic: `authMiddleware` accepts master OR `sessionStore.verify(token)` (constant-time, expiry-checked), else 401. |
| When to refresh the session token | judgment-candidate | Floor: the client refreshes on a fixed schedule before expiry (deterministic timer), server issues a fresh token only to a currently-valid one AND only within the absolute lifetime cap; on failure the deterministic fallback is the PIN screen. No LLM. |
| Bound on a stolen token's lifetime | invariant; basis: irreversible-consequence; evidence: if refresh could extend a token without limit, a stolen token would be as permanent as the master token and this whole fix would buy nothing — the SYMBOL "expires" must map to the STATE "a stolen token really dies"; corroboration: the server-side absolute-cap + family-root state, checked on every refresh, independent of possession | Deterministic: refresh refused once `now > family.absoluteMaxMs`; revoke / PIN-rotation invalidate the family root; open streams closed on invalidation. |
| Whether a credential operation is allowed | invariant; basis: irreversible-consequence; evidence: if a scoped bearer (or a stored operator-session token a thief also holds) could read authToken, change the PIN, rotate the token, or mint a session, a thief with stolen storage escalates to the permanent master or resets the cap — undoing the fix; a live-PIN STEP-UP blocks the thief (no live PIN) without removing the owner's ability (re-entry is a normal confirmation) | Deterministic: a credential-route requires a fresh PIN re-entry minting a one-time short-TTL proof, NOT a stored token. |

## Frontloaded Decisions

1. **Scope is lifetime + revocability + a fresh-PIN re-proof on credential operations — not full per-route least-privilege.** The dashboard's effective reach is unchanged, and NO existing capability is removed: credential-management operations (reading authToken, PIN change/read, token rotation, unlock issuance) require a fresh PIN step-up (re-entry at the time), which a thief with only stolen storage cannot produce — re-entering the PIN to change sensitive settings is a normal, expected confirmation, not a lost capability. Full per-route least-privilege is a separate future project (SEC-002c); the credential re-proof is the non-negotiable minimum included here.
2. **The master token stays valid for API/CLI/agent callers.** Only the BROWSER stops receiving it. Back-compat for every non-browser caller is preserved.
3. **Ships behind `security.dashboardScopedToken.enabled` (default on after the full dashboard UX proof).** Because this touches every dashboard call + WS + SSE, it ships enabled only once the live-user dashboard proof passes across all surfaces; the switch restores returning the master token exactly (rollback).
4. **Token lifetime is a conservative default (e.g. 24h per token) with sliding refresh, under an ABSOLUTE cap (default 7 days from the unlock).** The per-token lifetime keeps a normal session from re-authenticating; the absolute cap bounds a stolen token that keeps refreshing itself. Both operator-tunable. Without the absolute cap, "expires" would not bound a stolen token at all (the Verify-the-State check this answers).

## Open questions

*(none)*

## User-visible effect

Normal dashboard use is unchanged — the owner unlocks with the PIN exactly as before, the dashboard works identically, and the browser invisibly holds a token that expires and can be revoked instead of the permanent master key. A very long idle session may re-show the PIN screen once (ordinary session-expiry, strictly safer).

**One declared added step (a degradation under *Security Fixes Keep the Experience Whole*, surfaced for the independent reviewer to judge):** the rare CREDENTIAL operations — reading the raw API token, changing the PIN, rotating the token — now ask the owner to re-confirm (type the PIN, or tap the paired phone's device approval where they have one) at the moment of the operation. This is a genuine added step on those specific actions, and the standard requires it to be declared as such. It is UNAVOIDABLE for this fix: those operations are exactly how a thief with a stolen session token would escalate to the permanent master, and the ONLY thing a thief lacks is the live PIN / the owner's paired device — so the re-confirm is what makes "expires + revocable" actually bound the blast radius. It is kept minimal: only those rare operations, at most once per session (a short step-up window covers a burst), and the paired-phone tap substitutes for typing the PIN. Every NORMAL dashboard action keeps zero added friction. The reviewer weighs whether this minimal step is justified by the critical blast-radius reduction; the spec's position is yes, because the alternative (the browser holding a permanent master key) is the larger, standing harm.

**What SEC-002b bounds, precisely (symbol→state).** The lifetime/revocation bound is on a stolen TOKEN (browser storage theft): a thief who copies the session token holds a credential that expires, is revocable, and cannot directly touch the master. It does NOT by itself bound an attacker who KNOWS the PIN — a PIN-knower can always re-unlock for a fresh session and pass the live step-up. Bounding PIN COMPROMISE is SEC-002's job (the throttle that makes guessing hard + the owner alert); SEC-002b assumes that boundary and adds the token-theft boundary on top. Stated so the "expires" symbol is not mis-read as bounding a known PIN.

## Multi-machine posture

machine-local-justification: physical-credential-locality — a dashboard session token is a BEARER SECRET (like an API token): whoever holds it is authenticated, so its value must live in exactly one place and never be copied between machines. It is minted by, and verified against, ONE server's session store; replicating a bearer secret across machines is the same anti-pattern as syncing the master token's live session, widening the secret's exposure for no capability gain (the master token is already the cross-machine credential). Its one-place locality is a security property of a bearer secret, not merely an implementation choice. A browser unlocking machine A's dashboard gets A's token and talks to A; machine B issues its own from its own store. Replicating a session secret across machines would widen the credential's attack surface for no benefit, so it must not be replicated — this is per-server auth state (like the existing `DashboardOperatorSessionStore` and `PinAttemptStore`), not continuity-bearing agent memory. The master token remains the cross-machine/API credential, unchanged.

## Self-Heal Before Notify

No new monitor or operator notice. Token expiry self-heals via the client's silent refresh; a failed refresh falls back to the PIN screen (the owner simply re-enters the PIN), which is not an escalation. Revocation is an explicit owner action (logout), not an alert.

## Rollback

`security.dashboardScopedToken.enabled: false` (live) makes unlock return the master token again exactly as today and the middleware/WS/SSE behaviour is unchanged for the master — a clean single-switch rollback. Revert the PR to remove the refresh/revoke endpoints. No data migration; session tokens are in-memory and lapse on their own.

## Maturation plan

- **test-agent-live:** proven on a throwaway/in-process AgentServer — unlock returns a non-master token that authMiddleware + WS + SSE accept, the master token is never sent to the browser, a refresh issues a fresh token, a revoked/expired token is rejected (401).
- **dev-agent-live:** enabled on this development agent (Echo) and driven through the REAL dashboard across its surfaces (every tab loads, live streams connect, operator-gated actions work) on the scoped token, before the operator is asked to test.
- **fleet:** ships enabled for every agent once the live dashboard proof passes on all surfaces; it is defense-in-depth bounding every dashboard-auth weakness.
- **graduation criterion:** the full live-user dashboard proof (all tabs + WS + SSE + operator-gated actions) passes on the scoped token with zero operator-found escapes, AND the master token is confirmed never delivered to the browser.
- **dark-window:** ships dark until the live dashboard proof passes (this touches every dashboard call, so the proof is the gate), then enabled; the switch is the live rollback.
- **ladder:** not applicable: a dark-shipped security hardening, not tracked on a formal feature-maturation ladder

## Tests

- `tests/unit/`: the session-token store issues + verifies (constant-time), expires on lifetime, invalidates on PIN rotation, and rejects a forged/expired token.
- `tests/integration/dashboard-scoped-session-token.test.ts`: through the real server — unlock returns a token that is NOT the master; that token is accepted as Bearer on a representative authed route, on `/ws?token=`, and on an SSE stream; the master token is NOT present in the unlock response; a refresh returns a fresh unexpired token; a revoked token is 401 AND every token refreshed from the same unlock (the family) is also 401 after one revoke; an expired token is 401; refresh is refused past the absolute cap; an already-open WS/SSE stream is CLOSED server-side when its family is revoked; a scoped bearer, AND even a scoped bearer plus a stored operator-session token, cannot read the master token / change the PIN / rotate the token through the named CREDENTIAL routes (403) without a fresh live-PIN step-up, while the SAME operation WITH a fresh live-PIN step-up succeeds (the owner's ability is preserved); a session bearer is rejected (by type) when presented as a step-up proof; a NON-browser caller with the master token still works (back-compat). (Indirect master reach through broad non-credential routes is SEC-002c's deny-by-default allowlist, out of scope here and stated as the residual.)
- `tests/e2e/dashboard-scoped-session-token-alive.test.ts`: the production boot path serves unlock returning a scoped token accepted by the middleware; migration E2E for the config default (additive, idempotent).
- Live-user dashboard proof (dev-agent, operator condition 2026-11-15): BEFORE the switch flips anywhere, drive the REAL dashboard on the scoped token across EVERY surface — every tab, the terminal stream, SSE live updates, file editing, and Remote Desktop — at BOTH 1280px and 390px widths, recording a signed PASS/FAIL matrix. ONE broken tab for the owner FAILS the proof. The credential-operation step-up (and paired-phone substitution) is exercised in the proof too.
