<!-- bump: patch -->
## What Changed

One session's `Login expired` screen no longer benches a working subscription account (spec `docs/specs/stale-process-login-expired.md`).

- Before the quota poller marks an account `needs-reauth` because one Claude Code session showed the CLI's expired-login line, it tests the stored login with one contained real call (`src/core/freshLoginProbe.ts`). The call uses no tools, MCP servers, hooks, settings sources or transcript; credential and provider environment is stripped; and the verdict comes from the CLI's structured result (`apiKeySource: none`, `served_by_anthropic: true`).
- If the stored login answers, the account stays usable, and the stuck session is restarted on its OWN account (`SessionRefresh`, conversation resumed), never swapped to another account. If the call is refused, or cannot run, today's mark-and-swap path is unchanged.
- A hold created before the update, or before a probe answered, is released when a validated `ok` lands. The reissue sweep then closes the stuck re-sign-in it caused.
- Bounds: at most 6 probes per account per 12 h (persisted in `state/fresh-login-probe.json`, reserved inside the host spawn cap); never inside the 15-minute token-expiry margin; backoff and a 24 h breaker for inconclusive results; at most 3 in-place refreshes per account per 10 min. Each probe records one `QuotaPoller.freshLoginProbe` feature-metrics row.
- NeverSilent holds an automatic swap or engine move for at most 3 minutes per incident while that check or restart is under way, and sends a plain waiting notice instead.
- Live switch `subscriptionPool.freshLoginProbe.enabled` (default on; `false` restores the previous behaviour exactly).

## What to Tell Your User

If one of your conversations got stuck showing an expired sign-in while the account itself was fine, the agent no longer takes the whole account out of use or starts a sign-in that keeps restarting. It checks the account's saved sign-in first, and if that works it just restarts the stuck conversation on the same account. Nothing to do.

## Summary of New Capabilities

- A stored-login check before an expired-login screen benches an account, and an in-place restart for a session holding a stale sign-in (switch `subscriptionPool.freshLoginProbe.enabled`; metrics feature `QuotaPoller.freshLoginProbe`). No new routes.

## Evidence

- Live, 2026-11-20 on the Mac Studio: the shipped probe runner answered `ok` on a working login (claude-haiku-5-5, 4 output tokens) and `refused` (`not-logged-in`) on an empty login folder. The originating incident was the 2026-11-20 `sagemind-adriana` bench and re-sign-in loop.
- Unit: `freshLoginProbe.test.ts` (real captured CLI output), `FreshProbeScheduler.test.ts` (settling under every mode, restart persistence), `quota-poller-stale-process.test.ts`, `InteractiveLoginExpiredRecovery-stale-process.test.ts`, `never-silent-stale-login.test.ts`, `interactive-login-expired-awareness.test.ts` (in-place migration).
- Integration: `tests/integration/stale-process-login-expired.test.ts` (the 2026-11-20 timeline with the real runner).
- E2E: `tests/e2e/stale-process-login-expired-alive.test.ts` (server wiring plus the production builder releasing a real hold).
