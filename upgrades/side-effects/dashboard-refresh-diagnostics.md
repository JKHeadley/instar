# Side-Effects Review - Dashboard refresh diagnostics

**Version / slug:** `dashboard-refresh-diagnostics`
**Date:** `2026-06-04`
**Author:** `instar-codey`
**Second-pass reviewer:** `not run - subagent delegation unavailable without explicit user request in this session`

## Summary of the change

This change improves diagnostics for the built-in `dashboard-link-refresh` job and the `/telegram/dashboard-refresh` route. It adds `src/server/DashboardRefreshDiagnostics.ts`, switches the default job gate and command in `src/commands/init.ts` from curl-only shell commands to Node/fetch diagnostic scripts, makes `src/server/routes.ts` return structured failure bodies with stage/detail/nextStep, and makes `src/messaging/TelegramAdapter.ts` throw on hard dashboard broadcast failures instead of swallowing them. Focused coverage lives in `tests/unit/dashboard-refresh-diagnostics.test.ts`.

## Decision-point inventory

- `src/server/routes.ts` `/telegram/dashboard-refresh` - modified - maps missing Telegram/tunnel state and broadcast failures into explicit HTTP failure responses.
- `src/messaging/TelegramAdapter.ts` `broadcastDashboardUrl` - modified - treats failure to edit/send the Dashboard message as a hard delivery failure; pinning remains best-effort.
- `src/commands/init.ts` `dashboard-link-refresh` default job gate and command - modified - chooses diagnostic scripts installed or repaired for built-in legacy jobs.
- `src/server/DashboardRefreshDiagnostics.ts` generated refresh command - modified - reads the injected auth token from the job environment first and only uses a string-valued config token as fallback.

## 1. Over-block

The route now returns failure for a hard Telegram dashboard broadcast failure where the previous adapter could log the error and return normally. A legitimate refresh call can therefore fail if Telegram send/edit is unavailable. That is intentional because the job's purpose is delivery of a dashboard link; a false success here is the opaque failure mode being fixed.

Named tunnels still skip refresh as before. Agents without Telegram or without a tunnel still receive skipped precondition responses instead of a successful refresh.

## 2. Under-block

This does not verify that the pinned Telegram message is visible to every user, nor does it validate that the remote tunnel URL actually serves the dashboard after the Telegram message is sent. The route checks local state and Telegram delivery, not end-to-end browser reachability.

The diagnostic script reports the response body and common request failures, but it cannot diagnose every OS/network layer beyond the thrown request error. It gives the next local step rather than attempting repair.

## 3. Level-of-abstraction fit

The change sits at the right layers: the job script diagnoses local execution and HTTP request failures; the route diagnoses server-side preconditions; the Telegram adapter reports hard delivery failure. It does not add a parallel health checker or a new scheduler policy. It uses the existing built-in job repair path in `refreshJobs`, which syncs built-in gate/execute fields while preserving user-tunable schedule/enabled/priority settings.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No - this change is structural precondition/request validation, not a brittle judgment gate.

The route and script have blocking authority only over malformed or failed infrastructure operations: no Telegram adapter, no tunnel URL, failed HTTP request, or failed Telegram delivery. These are mechanical facts, not semantic judgments about user intent or message meaning. The change does not add a detector that blocks conversational content.

## 5. Interactions

- **Shadowing:** The route's precondition checks now return structured bodies, but the same preconditions already caused non-success responses. No higher-level authority is bypassed.
- **Double-fire:** Startup tunnel rebroadcast callers already catch dashboard broadcast failures where they want best-effort behavior. The scheduled refresh route awaits the same adapter method and now receives the hard failure.
- **Races:** The tunnel URL can disappear between reading `ctx.tunnel.url` and broadcasting; that remains a runtime race. The failure now reports the stage if delivery fails rather than pretending the job succeeded.
- **Feedback loops:** The built-in legacy job refresh path may update existing built-in `dashboard-link-refresh` execute content on update, which is intended for built-in job implementation details. User-forked job files are not touched by this path.

## 6. External surfaces

The visible external surface is improved job output and HTTP error JSON for `/telegram/dashboard-refresh`. The Telegram user-facing Dashboard message content is unchanged. The change affects existing agents when the built-in job definition is refreshed, because the built-in `execute.value` is treated as implementation-owned. It does not write persistent state beyond the existing dashboard message ID path when a new Telegram message is successfully sent.

The gate and script no longer depend on a shell HTTP client being installed, which improves portability for Gemini/Codex-style environments where the shell path may not include curl.

The refresh command now preserves compatibility with externalized auth tokens. Job sessions receive the resolved token in their environment, and the config-file fallback rejects non-string placeholder objects instead of sending them as bearer tokens.

## 7. Rollback cost

Rollback is a patch revert of the helper, route, adapter, default job command, test, ELI16, release note, and this artifact. No data migration is introduced. Existing agents that already received the improved built-in job command would receive the reverted command on a later update through the same built-in job repair path.

## Conclusion

The review did not identify a signal-vs-authority violation. The main behavior change is that a dashboard refresh can now fail loudly when Telegram delivery fails; that is the intended correction because silent success was the operationally harmful path. The change is clear to ship with the focused test and lint coverage.

## Second-pass review

**Reviewer:** `instar-codey separate pass`
**Independent read of the artifact: concur with constraint**

The high-risk checklist would normally call for a delegated reviewer because this touches Telegram delivery. The available subagent tool is policy-limited to explicit user requests for delegation, so no subagent was spawned. A separate read of the code and artifact found the design acceptable: hard delivery failures now surface only for the dashboard refresh operation, while best-effort pinning remains non-fatal and startup callers already catch broadcast errors.

## Evidence pointers

- `npm test -- --run tests/unit/dashboard-refresh-diagnostics.test.ts` passed.
- `npm run lint` passed.
