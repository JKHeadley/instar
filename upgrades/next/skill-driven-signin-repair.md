# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

On macOS, the automatic subscription sign-in repair can now hand its browser step to ONE short-lived agent session that follows `/subscription-signin` section 3, the same way the hand-run repairs on 2026-09-24 and 2026-09-25 did (spec `docs/specs/skill-driven-signin-repair.md`). The new `subscriptionPool.assistedRelogin.navigation` value `agent-session` turns it on. It is honored on macOS only. When the value is omitted it resolves to `agent-session` on a macOS development agent and to the existing driver everywhere else. Rollback is setting `navigation` back to `agent` or `closed`.

The server keeps every decision that must not depend on judgment:
- **Pre-attempt check.** In the orchestrator's `approved` branch, before an attempt is counted, three checks run: the machine's Playwright seat lease (one helper per machine, renewed every 2 minutes), session capacity, and a helper account. The helper account must be a healthy account on this machine, Claude or Codex, never the one under repair. Healthy means active, not identity-drifted, not walled, and a just-in-time authenticated read. For Codex that means `codex login status` plus a live app-server read.
- **Waiting.** A busy seat or full capacity returns `waiting` without spending an attempt. The approval is extended through the new `SubscriptionReloginStore.extendApproval`, which is version-checked and capped at 60 minutes. No healthy helper account moves the episode `approved → waiting-operator-only` / `no-healthy-seat`.
- **Spawn.** The helper is a headless session `relogin-<episodeId>`. It is pinned to the helper account's login by the new `spawnSession({ accountPin })` option (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, resolved through the credential-location gate). It has no project MCP, no topic, is never revived, and is capped at `min(15 min, login expiry − 60 s)`. A Codex helper runs with full access.
- **Code route.** `POST /subscription-relogin/:episodeId/code` is loopback-only and takes a 32-byte per-episode token that is held only in memory. It accepts a strict tagged-union body capped at 1 KB and sends no CORS headers. It takes `{"code"}` (checked by the paste-back validator and accepted once), `{"notify":"phone-tap"}` (a new URGENT fixed notice), or `{"notify":"macos-permission","permission":…}` (the existing `automation-permission` operator-only notice, now naming the permission).
- **Success.** Success is still decided only by pending-login completion, then `verifyIdentity === 'match'`, then an authenticated call. A helper that exits or reaches its cap without delivering ends `failed` / `agent-sign-in-unfinished`.
- **Cleanup.** The helper is killed on every exit from `browser-driving`, on restart recovery, and at boot.
- **Approval.** Approval is forced on this path whatever `mode` says.
- **Detached ticks.** `SubscriptionReloginService.tick` now starts episodes detached.

Pool health comes from real logins:
- **Codex.** Only a LIVE app-server read proves a Codex login. The rollout-file fallback is usage history and never restores `needs-reauth → active`, and the arbiter's authenticated-use check requires the live read too. A Codex account now turns `needs-reauth` (new cause `cli-signed-out-auth-refused`, repair-admissible) when `codex login status` and the live read both say signed out on two consecutive polls. A transport failure never counts. `codex login status` is trusted only after a canary proved it says "Not logged in" for an empty home.
- **Visibility.** `GET /subscription-pool` carries `loginCheck` (`ok` / `signed-out` / `unavailable`) next to each status.
- **Claude.** `claude auth status` is deliberately NOT used anywhere, because it reports signed in for expired sessions. Claude's login signal stays the authenticated OAuth usage read.

An open repair no longer outlives the problem. When the server verifies an account×machine cell healthy by another path, an open repair on that cell is closed as `resolved-elsewhere` through the store's own audited transition. Healthy by another path means: signed in by hand or from the phone, pool `active`, no identity drift, and an authenticated read. The close counts as neither a success nor a failure, so the dashboard stops showing "Sign-in needs your help" for an account that already works. The operator found this on the Laptop on 2026-09-25.

Other changes:
- **Store (additive).** The transition `approved → waiting-operator-only`, the failure classes `agent-sign-in-unfinished` and `no-healthy-seat`, and the notice kind `phone-tap`. Notice delivery keys now carry the attempt number, and a new attempt clears the previous attempt's phone-tap and operator-only rows.
- **Dashboard.** A cell whose repair is waiting on the operator now also shows **Sign in**, so the operator can finish from a phone.
- **Skill.** The `/subscription-signin` skill gains an "Agent-run repair" subsection.
- **Existing agents.** They receive the skill subsection and the CLAUDE.md bullet through `PostUpdateMigrator`.

## What to Tell Your User

On a Mac, when one of your Claude or Codex subscriptions gets signed out, the automatic repair now works the way the hand-run sign-ins did. After you tap Repair sign-in once, a short-lived helper session on the same Mac signs the account back in, looking at the screen and clicking through like a person would. Your agent still decides for itself whether it worked: the account must be the right one and must really work. If the helper needs you, you get one short message, for example to tap "Yes, it's me" on your phone or to click Allow on the Mac. If there is no other working account on that Mac to run the helper, the message links you to the dashboard, where you can finish the sign-in from your phone. Separately, Codex accounts no longer show as working when they are actually signed out, and a repair notice no longer lingers on the dashboard after you have signed the account in some other way.

## Summary of New Capabilities

- macOS sign-in repair can be driven by one short-lived agent session following the proven by-hand procedure. It is approval-forced, uses one helper per machine, and success is decided only by the server.
- A loopback, per-episode-token code route lets that helper hand back the Claude code and ask for a phone tap or a macOS permission.
- The pool shows each account's `loginCheck`. Codex accounts count as signed in only after a live authenticated read, and turn `needs-reauth` when the CLI and the live read agree they are signed out.

## Evidence

- Unit (new, 67 tests): `subscription-relogin-helper.test.ts` (16), `subscription-relogin-agent-session.test.ts` (13), `CliLoginStatus.test.ts` (7), `quota-poller-login-check.test.ts` (6), `PostUpdateMigrator-subscriptionSigninAgentRun.test.ts` (4), `skill-driven-signin-repair-wiring.test.ts` (3), plus 18 tests added to existing files (`codexLiveRateLimitReader` +5, `subscription-relogin-service` +4 including resolved-elsewhere, and the updated navigation, store, render and migrator tests).
- Integration (new, 16 tests): `subscription-relogin-agent-session.test.ts` (11): the full runtime flow, forced approval, no-healthy-seat, Codex seat rules, `codex-live-read-disabled`, an unfinished helper, resolved-elsewhere, the code route through the real CORS + bearer + JSON middleware, and pool `loginCheck`. `subscription-relogin-helper-spawn.test.ts` (4): production ports into a real SessionManager, with the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` pin. `subscription-relogin-runtime.test.ts` (+1): a Codex rollout read never counts as authenticated use.
- Full unit suite, run in parallel: 2512 files and 45,302 tests passed, 0 failed.
- E2E: `tests/e2e/subscription-relogin-agent-session-lifecycle.test.ts` (2). A real AgentServer, composed through the same `subscriptionReloginRouteContext` as `server.ts`, receives the helper's code over HTTP with only its token and verifies the repair to `succeeded`. On the legacy path the code route is honestly dark (503).
- Live probe, 2026-09-25 on the Mac Studio: `CODEX_HOME=<empty dir> codex login status` prints "Not logged in" (exit 1). The app-server's `account/rateLimits/read` then answers `{"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}`, which is the exact refusal the detailed reader classifies as `auth-failed`.
