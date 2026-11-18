# Side-Effects Review — Codex sessions launch under the account they are tagged with

**Version / slug:** `codex-launch-account-home`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

The interactive codex-cli launch builder (`frameworkSessionLaunch.ts`, `codexCliBuilder`) now sets `CODEX_HOME=<configHome>` when it is given a per-account home, as the claude-code builder already sets `CLAUDE_CONFIG_DIR`. `SessionManager.spawnInteractiveSession` places the freshest copy of a resumed Codex conversation's rollout into that home before launching (`src/core/codexResumeRollout.ts`, new). It searches the default home plus every Codex account home the pool knows (`setCodexAccountHomesResolver`, wired in `server.ts` from `subscriptionPool.list()`). If no copy exists anywhere, or placement throws, the session launches fresh with the existing `RESUME_REOPEN_FAILED_NOTE`, and a DegradationReporter entry is filed.

Cause, from live processes and files rather than timestamps. The session records for `echo-android-app` (142909), `echo-remote-desktop-locked-screen` (138345) and `echo-official-instar-dashboard` (142440), spawned 2026-11-18 00:39–00:43Z and moved by `POST /subscription-pool/swap` onto `codex-justin-gmail`, carried `subscriptionAccountId: codex-justin-gmail`. Their Codex rollouts (`rollout-2026-11-17T16-40-54-01a1ec19…`, `16-43-15-01a1ec1b…`) were written in `~/.codex/sessions` (`dawn@sagemindai.io`) until 19:50 PT. The swap path is `QuotaAwareScheduler.onQuotaPressure` → `SessionRefresh.refreshSession({configHome})` → `respawnSessionForTopic` → `spawnInteractiveSession({configHome, subscriptionAccountId})` → `buildInteractiveLaunch('codex-cli', {configHome})`, and `codexCliBuilder` never read `configHome`. So the tag changed and the login did not. The same thread ids continue in `~/.codex-followme-justin-gmail/sessions` after a hand recovery at 04:52Z. The live processes now show `CODEX_HOME=/Users/dabombstudio/.codex-followme-justin-gmail` (ps eww, tmux show-environment), and that home's `auth.json` id_token email is `headley.justin@gmail.com`.

## Decision-point inventory

No decision point is added or changed. Which account to use is still decided by the existing selectors (the swap scheduler, pin). This change makes the launch carry out the decision already recorded on the session.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest effect: a swap whose conversation cannot be found in any known home now starts fresh, where before it would have resumed on the wrong login. Starting fresh is the honest outcome, it is disclosed in the session's first message, and it is reported.

## 2. Under-block

- New interactive Codex spawns that no one pins still launch on the default login, untagged. That is unchanged and honest (untagged means default). Placing new interactive Codex sessions through the pool is a separate capability, not this defect.
- A conversation that lives only in a Codex home the pool does not list (a hand-made home) is not found, so the session starts fresh in the account's home and is reported.
- Sessions already running are not touched. The ones observed in this incident were restarted by hand onto the right home at 04:52Z.

## 3. Level-of-abstraction fit

This is the right layer. The builder is the one place that turns a launch request into argv and env for each framework, and it already does this for Claude. Rollout placement sits beside the Claude transcript placement (`placeResumeTranscript`) at the same point in `spawnInteractiveSession`, and reuses the existing rollout lookup (`findRolloutFile`, `invalidateRolloutLookup`) rather than a new walker. `planInteractiveThreadlineMcp` already assumed `options.configHome` was the Codex home, so the threadline plan and the launch now agree.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Newest copy wins" picks between copies of one file by modification time. That is an invariant choice, and it never deletes the other copy.

## 5. Interactions

- **Trust seeding:** `PROJECT_TRUST_SEEDERS['codex-cli']` reads `envOverrides.CODEX_HOME`, so the launch folder is now trusted in the account's home rather than the default one. Before, an account home could stop at Codex's "trust this folder?" prompt.
- **Threadline MCP plan:** it already resolved its plan against `options.configHome` for Codex. Plan and launch now agree.
- **CodexResumeMap / TopicResumeMap:** these look up rollouts by home. The `invalidateRolloutLookup` call after a copy clears a remembered miss for the target home.
- **Quota attribution:** usage now lands on the tagged account, so pacing, wall rescue and the quota screen see the account that is actually spending.
- **Codex hook trust (raised by the second-pass review):** Codex records hook trust per home (`[hooks.state]` in `$CODEX_HOME/config.toml`), and instar arms it only in the default `~/.codex`. An account home can hold stale hashes; `~/.codex-followme-justin-gmail` does. This does not switch instar's gates off on this fleet. When the installed codex supports it (`codexSupportsHookTrustBypass`; the live launch argv of session pid 80862 carries the flag), instar launches with `--dangerously-bypass-hook-trust`, which runs instar's own hooks without the stored-hash check. Live evidence, 2026-11-18: `autonomous-stop-hook.sh --codex` (pid 29344) was observed running as a child of session pid 80862 (a stop hook is short-lived), whose `CODEX_HOME` is `~/.codex-followme-justin-gmail` with stale hashes. The remaining case is a codex too old for the bypass flag. There, an account home's hooks would wait behind Codex's trust prompt instead of running, which is the same posture an unarmed default home has. That is accepted and stated here, not hidden. Arming per account home is the follow-on if such a codex is ever pinned.
- **Lookup cost:** a resume id that is not a Codex thread (a Claude UUID) has no date hint, so the lookup scans each home's archive asynchronously before answering not-found and launching fresh. It is slow on a large archive but never blocks the event loop.
- **Races:** placement runs before the tmux spawn. The old session was already killed by the refresh path, so its rollout is no longer being written.

## 6. External surfaces

- Which OpenAI account Codex sessions bill against changes for swapped and pinned sessions. That is the intended fix.
- On-disk effects: a rollout file is copied into the target account home's `sessions/` tree, and a stale target copy is renamed `<name>.set-aside-<ms>`. No credential or auth file is read, copied or written.
- No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. Codex homes, rollouts and the tmux launch live on the machine running the session, and each machine's pool lists its own homes. Cross-machine moves keep their existing transcript paths.

## 8. Rollback cost

A pure code change: revert and ship a patch. Rollout copies stay on disk as harmless extra history files. Set-aside files can be removed by hand if wanted. No state migration.

## Conclusion

The tag and the login now agree for interactive Codex launches, and a moved Codex conversation follows its account. Before, a swap silently kept the default login. Now it either resumes on the right login or starts fresh on the right login and says so.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (given the diff, the call chain and the verified codex resume behaviour; not my conclusions)
**Independent read of the artifact: concern raised, then resolved**

The reviewer confirmed that the tag and `CODEX_HOME` now agree on both callers that pass a home (Telegram respawn and Slack respawner), that no default launch changes, and that placement is sound. Concern: hook trust is armed only in the default home, so swapped sessions could run with gates off. Resolution: instar launches the installed codex with `--dangerously-bypass-hook-trust`, which runs instar's hooks regardless of stored trust. A live stop hook is verified running under the account home with stale hashes (see Interactions). The no-bypass-flag case is stated as accepted. Added from the review: a test for placement throwing, and the lookup cost note.

---

## Evidence pointers

- `tests/unit/frameworkSessionLaunch.test.ts` (+2): CODEX_HOME is set from configHome, fresh and resumed, and absent without it.
- `tests/unit/interactive-session-pin.test.ts` (+4, including placement throwing): the spawn argv carries `CODEX_HOME=<home>` with a matching tag; a resumed conversation is copied into the home and resumed there; a missing conversation starts fresh, not as a dead resume. With the builder line removed, these 4 tests fail.
- `tests/unit/codexResumeRollout.test.ts` (6): real files covering copied, newest-wins, present, replaced with set-aside, not-found, and target-as-source.
- Codex behaviour verified by hand (the vendored codex the sessions run): an empty `CODEX_HOME` answers `no rollout found for thread id`. The same home with the rollout copied into `sessions/YYYY/MM/DD/` finds the thread.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in launch code, and no self-triggered controller is added or changed.
