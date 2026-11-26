# Side-Effects Review — no false health alarms on a fresh agent (no sshd, no Telegram)

**Version / slug:** `fresh-agent-no-false-alarms`
**Date:** `2026-11-20`
**Author:** `Echo (builder #44)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 3 source files (`src/commands/recoveryMainWiring.ts` ~+35, `src/server/routes.ts` ~+12, `src/commands/server.ts` 2 lines) plus 3 new test files. Effort: no spec rounds (Tier 1), one build pass.

1. `readHostSshKey()` (now exported, path injectable for tests) classifies the read: readable → `available`; `ENOENT`/`ENOTDIR` (no SSH server set up on this machine) → `not-applicable`, a log line, and **no degradation**; any other error (EACCES, EISDIR, EIO, …) → `unreadable` and the same `ServerDownRecovery.hostSshKey` degradation as before, with the error code in the reason. The verdict is readable through `recoveryDirectSshRoute()` and is added as `directSshRoute` to the `multiMachine.serverDownRecovery.enabled` guard entry (`GET /guards`). The empty key passed to `RecoverySetupRuntime` is unchanged in every case, so enrollment behaves exactly as before (it still throws `recovery-ssh-host-key-required` if recovery is used without a key).
2. `POST /telegram/dashboard-refresh` with no Telegram adapter: when the config has no enabled Telegram messaging entry, answer 200 `{action:'skipped', reason:'telegram-not-configured'}` (the job's existing script treats 2xx as success and logs "skipped"). When an enabled Telegram entry exists but the adapter is not running, answer 503 `action:'failed'` (it was 503 `skipped` before) so that real failure keeps reporting. The tunnel preconditions and the broadcast path are unchanged.

## Decision-point inventory

- Degradation report for `ServerDownRecovery.hostSshKey` — modify — no longer emitted when the key file is absent.
- `/telegram/dashboard-refresh` precondition — modify — no-Telegram answers a 200 skip; configured-but-down stays 503.
- `/health` status computation — pass-through — unchanged; it simply receives one fewer false input.
- Scheduler failure counting — pass-through — unchanged; the script now exits 0 in the no-Telegram case.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (The change removes false failure signals; it blocks nothing.)

## 2. Under-block

Cases that no longer raise an alarm but arguably could matter:
- A machine where recovery IS enabled and paired, but sshd has no ed25519 key file (e.g. sshd installed with only an RSA key). It is now "not applicable" rather than degraded. Recovery's own readiness (`recoveryRuntime.status().ready`) and its setup blocker still show the route is not ready, so the condition is still visible where recovery is actually used.
- A config whose Telegram entry is `enabled: false` while someone expected Telegram: now a quiet skip. That is the operator's explicit setting.
- A Telegram entry that is enabled but the server never wired the adapter for another reason is still a 503 failure (tested). This includes a server deliberately started with `--no-telegram` whose topology leaves no adapter: it was a 503 before this change and stays one (only its wording changed, and the wording now names "started without Telegram on purpose" as a possible cause instead of only a broken token). Turning that case into a skip would need the route to know the start flag; it is not part of the reported bug and is left as it was.

## 3. Level-of-abstraction fit

The SSH classification lives at the single read site that produced the false signal. The Telegram decision lives in the route, the one place that knows both the config and whether the adapter is running; putting it there (not in the job's gate or script, which are copied into each agent's jobs.json) means existing agents get the fix on update with no job-definition migration and no second copy of "is Telegram configured" logic in a shell script.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It narrows two signal producers (a degradation report and a job failure) to the cases where they are true.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point: "the key file does not exist" and "Telegram is not configured" are enumerable facts about the machine and config, not competing signals.

## 5. Interactions

- **Shadowing:** `/health`'s `degradations.length > 0` and `consecutiveJobFailures >= 5` rules are untouched; they just stop receiving these two false inputs.
- **Double-fire:** none; `readHostSshKey` still runs once per start.
- **Races:** `directSshRoute` is a module-level value written at start and read by the guard snapshot; a read before start returns `unknown`.
- **Feedback loops:** the scheduler's continuity/failure tracking now sees successes for this job on Telegram-less agents, which resets any existing failure streak on the next run (desired).
- The CLI/route callers of `dashboardRefreshFailure` other than this precondition are unchanged.

## 6. External surfaces

- `/health` on a fresh WSL/app agent: `ok` instead of `degraded` (the intended fix).
- `GET /guards` adds `directSshRoute` to one entry (additive).
- `POST /telegram/dashboard-refresh` response for the no-Telegram case changes 503 → 200 with `action: 'skipped'`; for configured-but-not-running the body's `action` changes `skipped` → `failed` (status stays 503). No in-repo caller parses these besides the job script, which handles both.
- Job history for `dashboard-link-refresh` on Telegram-less agents now records successes logging "skipped".
- No operator-facing actions added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: whether a machine has an SSH server is a fact about that machine, so `directSshRoute` and the degradation are per machine, read through that machine's `/guards` and `/health` (the existing pool health views already merge per-machine health). The refresh route reads the agent's own config on the machine serving it; Telegram configuration is the same on every machine of an agent. No notices, no durable state, no URLs added.

## 8. Rollback cost

Pure code change: revert and ship a patch. Degradations are in-memory and empty at start, so no persisted state needs repair in either direction; an agent upgraded from a version that had already recorded the false degradation starts clean.

## Conclusion

Removes two false alarms every Windows-app agent (and every Telegram-less agent) showed, while keeping the real failure cases (unreadable key, Telegram configured but down) reporting, each with a test. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read the diffs and code, not this conclusion)
**Independent read of the artifact: concur, with one minor concern**

- Concern raised: a server started with `--no-telegram` while config has Telegram enabled still answers 503 "failed", and the new message pointed only at a broken token. Resolution: the 503 wording now also names a deliberate start without Telegram; the case is documented under Under-block. Its status code is unchanged from before this fix, so it is not a regression, and it is outside the reported bug (fresh agents with no Telegram config).
- Confirmed: the not-configured predicate matches the server's own Telegram start condition (`m.type === 'telegram' && m.enabled`), `readHostSshKey` has one call site, and the enrollment input is unchanged.

---

## Evidence pointers

- `tests/unit/fresh-agent-false-alarms.test.ts` — missing / not-a-dir / readable / unreadable key; route skip, disabled entry, configured-but-down.
- `tests/integration/fresh-agent-health-no-false-alarms.test.ts` — `/health` ok with no key, degraded with an unreadable key; route skip.
- `tests/e2e/fresh-agent-dashboard-refresh-skip-lifecycle.test.ts` — the shipped job's gate + script against a listening AgentServer; the no-Telegram case fails on main, passes with the fix.
- Source report: Windows dress rehearsal, builder #43, 2026-11-20.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (code defects in a degradation report and a route precondition).
