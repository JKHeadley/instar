# Side-effects review — subscription-pool OAuth access-token auto-refresh

## What changed
- New `src/core/OAuthRefresher.ts`: a corruption-safe refresh-token→access-token exchange for a config home's Claude Code credential (keychain on macOS, `<configHome>/.credentials.json` elsewhere). Endpoint + client id are the public Claude Code values extracted from the official client binary.
- `src/core/QuotaPoller.ts`: on a usage-read 401/403 the poller now attempts a refresh + one retry BEFORE marking the account `needs-reauth`. `defaultTokenResolver` refactored to share the OAuthRefresher locator (single source of truth for where a config home's credential lives).
- `src/core/SubscriptionPool.ts`: new optional `lastRefreshAt` field (visibility only).
- `dashboard/subscriptions.js`: a "Token auto-refreshed <ago>" line + `relativeAge()` helper.

## Blast radius / who is affected
- Only anthropic/claude-code accounts in a SubscriptionPool. A pool of zero accounts (single-account agents) is entirely unaffected — the poller only runs when accounts are enrolled.
- Behavior change is strictly a NARROWING of when `needs-reauth` fires: it no longer fires on a recoverable access-token expiry. Genuinely dead logins still flip to `needs-reauth` exactly as before.

## Corruption safety (the load-bearing concern)
- The ONLY mutation is the credential write-back. It is gated three ways: (1) only on a fully-validated 200 (new access token shaped `sk-ant-oat…`, positive numeric `expires_in`); (2) read-merge-write that preserves every existing field (scopes, subscriptionType, rateLimitTier, unknown fields); (3) refresh-token rotation persisted when present, old token kept when the server doesn't rotate — never dropped.
- Any failure (wrong endpoint, wrong client id, network error, malformed body, write failure) writes NOTHING and returns a typed failure → the caller's existing `needs-reauth` path. A misconfiguration can only ever fail to improve, never corrupt a working login. This is fail-CLOSED, not silent-degrade-to-heuristic (consistent with the no-silent-llm-fallback standard, though this path is auth not inference).

## Secrets handling
- Token values are never logged and never returned to any persisted surface. The pool registry's existing `assertNoCredentialFields` guard still rejects any credential-bearing field name; `lastRefreshAt` is a timestamp, not a secret.

## Framework generality
- Scoped to claude-code OAuth specifically (the refresh-token grant is provider/framework-specific). It does NOT touch the session launch/inject abstraction (frameworkSessionLaunch / MessageDelivery), so it cannot regress codex-cli / gemini-cli / pi-cli. Non-claude-code accounts are skipped by the same provider/framework guard the poller already applies.

## Migration parity
- No agent-installed files change (no settings.json hooks, no config defaults, no CLAUDE.md template, no hook scripts, no skills). This is an in-process monitoring component; existing agents pick it up on the next server update. The new `lastRefreshAt` field is optional and back-compatible with existing `subscription-pool.json` on disk.

## Tests
- Tier 1: `tests/unit/oauth-refresher.test.ts` (rotation, no-rotation, no-refresh-token, exchange-failed, malformed, read-failed, write-failed, locator, request shape) + extended `tests/unit/quota-poller.test.ts` (refresh-recovers, still-401-after-refresh, dead-refresh-token) + `tests/unit/subscriptions-render.test.ts` (token-health line + relativeAge).
- Tier 2: `tests/integration/subscription-quota-routes.test.ts` — recovery + dead-login through the real `/subscription-pool/poll` HTTP route.
- Tier 3: `tests/e2e/subscription-quota-lifecycle.test.ts` — expired token auto-refreshes end-to-end, account stays active, stamped to the on-disk registry.
