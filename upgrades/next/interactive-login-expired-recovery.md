# A conversation stuck at an expired Claude login moves to a signed-in account by itself

## What Changed

- `src/core/LoginExpiredSignature.ts`: also recognizes newer Claude Code's `Not logged in · Run /login` frame (only as the CLI's own `⏺` message line), and reports `messageLed` so a `⎿` tool-result line (e.g. `claude auth status` output) never changes pool state.
- `src/core/SessionManager.ts`: the monitor now checks non-job Claude Code sessions' live tail (every 20 s); after the frame has stayed for 60 s it hands the session to a new sink once per episode (re-offered after 10 min if it persists). Detection only: it kills nothing.
- `src/core/QuotaPoller.ts`: new `observeCliLoginExpired()`. When the stored credential READS, one such sighting moves the account to needs-reauth (cause `cli-login-expired-observed`, exchange-corroborated, so the assisted sign-in repair can open) and holds it there against later successful usage reads while the credential is unchanged. Released by a changed credential, a credential swap on the slot, a status restored from outside the poller (repair success, operator), a restart, or a 12 h ceiling. An unreadable credential keeps the old two-session rule (locked-keychain guard).
- `src/core/InteractiveLoginExpiredRecovery.ts` (new): marks the pool first, then (once the pool reports the account needs-reauth) swaps the session through `QuotaAwareScheduler.onQuotaPressure` (the funnel behind `POST /subscription-pool/swap`, including the swap work gate). Per-session 10 min cooldown and at most 3 attempts (registered self-action controller `interactive-login-expired-swap`); protected sessions are never moved; live kill switch `subscriptionPool.loginExpiredSwap.enabled: false`.
- `src/commands/server.ts`: wires both sinks (the existing job sink now also calls `observeCliLoginExpired`).
- CLAUDE.md template + `migrateClaudeMd()`: new awareness bullet.

Why: on 2026-10-25 the sagemind agent's `sagemind-justin` account had an expired CLI login while its token still answered the OAuth usage endpoint, so it stayed `active`; every new topic session placed on it printed "Login expired · Please run /login" on every turn, nothing recovered them, and a manual needs-reauth was reverted by the next poll.

## What to Tell Your User

If one of your Claude accounts gets signed out, conversations that land on it no longer just keep answering "please log in". Within about a minute I mark that account as needing sign-in, start the sign-in repair, and continue the conversation on one of your other accounts.

## Summary of New Capabilities

- Automatic recovery for chat sessions stuck at Claude Code's expired-login screen (swap + needs-reauth). Off switch for the swap: `subscriptionPool.loginExpiredSwap.enabled: false`.

## Evidence

Unit: `tests/unit/headless-spawn-reroute.test.ts` (interactive branch: both wordings trigger after the dwell; inside the dwell, stale scrollback, prose quoting, job and Codex sessions do not; episode clears when the screen goes), `tests/unit/quota-poller-pane-login-authority.test.ts`, `tests/unit/InteractiveLoginExpiredRecovery.test.ts`, `tests/unit/LoginExpiredSignature.test.ts`, `tests/unit/interactive-login-expired-awareness.test.ts`. Integration: `tests/integration/interactive-login-expired-recovery.test.ts` (HTTP: account reads needs-reauth and stays there after `POST /subscription-pool/poll`; session refreshed onto the healthy account as `reactive-swap`). E2E: `tests/e2e/interactive-login-expired-lifecycle.test.ts` (server.ts wiring + persisted state).
