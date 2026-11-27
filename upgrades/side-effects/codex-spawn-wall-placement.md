# Side-Effects Review — headless Codex spawns skip walled accounts

**Version / slug:** `codex-spawn-wall-placement`
**Date:** `2026-11-12`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (session lifecycle: spawn)`

## Summary of the change

Feedback fb-39e55b95-f00 and fb-fb4d0e68-3a2: on the Mama PC, `POST /sessions/spawn` with `framework: codex-cli` launched five sessions on `codex-sagemindai`, which the pool read at weekly 100% (resetsAt 2026-11-14T18:01Z); each died at its first turn. **Cause:** the headless lane in `SessionManager.spawnSessionInternal` asked `spawnAccountResolver` only when the framework was `claude-code`, and `UsageWallRescue.spawnAccount()` is Claude-only, so a Codex spawn rode the default `CODEX_HOME` login untagged and nothing compared it with the quota reading. The account's `status: active` was not the cause (placement keys on readings, not status). Fix: `UsageWallRescue.codexSpawnAccount()` (new) mirrors the Claude resolver `spawnAccount()`: it picks a usable Codex account that is not walled (same `isKnownWalled` predicate the rescue uses: a window at >= 100% until its resetsAt) AND has a fresh reading under the soft threshold, coolest first; it tags every Codex spawn only when the rescue is effective (2+ usable Codex accounts, pinning not explicitly off), and otherwise acts only when some usable Codex account is known walled (the Codex default login cannot be matched to an account, so any wall is treated as possibly the default). It refuses when every usable Codex account is walled, and returns null (default login, as before) when there are no Codex accounts, the switch is off, or no account qualifies. `SessionManager` gains `setCodexSpawnAccountResolver` and consults it in the headless lane for `codex-cli` only when no explicit `accountPin` is given; a refusal throws `codex-accounts-walled` before any tmux session exists. `server.ts` wires it next to the existing resolver. `classifySpawnRefusal` recognises the code so the route returns 409 with it. `ReapLog.recordExited` carries `subscriptionAccountId`. Files: `src/core/UsageWallRescue.ts`, `src/core/SessionManager.ts`, `src/commands/server.ts`, `src/core/heavyWorkPlacement.ts`, `src/monitoring/ReapLog.ts`, two test files, release fragment, ELI16.

Tier 1 (declared): narrow, reverts cleanly, no state or config migration. Size: 5 src files, about 100 added lines; tests about 260 lines. Effort: no spec rounds (Tier 1), two second-pass review rounds (round 1 found a real placement defect, fixed).

## Decision-point inventory

- `SessionManager` headless-lane account placement — modify — Codex spawns now consult a Codex placement resolver.
- `UsageWallRescue.codexSpawnAccount` — add — chooses the Codex account or refuses.
- `classifySpawnRefusal` — modify — one more definite refusal code.

---

## 1. Over-block

The refusal fires only when every usable Codex account in the pool has a reading at or above 100% in some window whose reset is still in the future (or a fresh 100% reading, or a corroborated wall seen recently by the rescue). A stale 100% reading with an unparseable resetsAt is not walled. Case: the default `CODEX_HOME` login is an account NOT enrolled in the pool and has room, while every pool Codex account is walled — the spawn is refused although the default login would have worked. Judged acceptable: a pool that enrols Codex accounts is the pool's view of Codex capacity, and the refusal is plain and immediate (the caller can retry after reset or enrol the account). Placement (not refusal) moves a spawn off the default login only onto an account with a FRESH reading under the soft threshold (a recent successful read is evidence the login works), and only when the rescue is effective (2+ usable Codex accounts) or some Codex account is walled. An enrolled account with an expired login never gets a fresh reading, so it is never picked (second-pass concern, fixed in round 2). With 2+ usable accounts and nothing walled, spawns are tagged and spread to the coolest account — the same posture Claude spawns have.

## 2. Under-block

- A walled account whose reading lags below 100% (Codex already refuses) can still be picked if its fresh reading is under the soft threshold; the mid-work rescue for Codex spawns is a separate known gap (named in the PR).
- The interactive Codex lane (`spawnInteractiveSession`) is not changed; it still uses the default login. Out of this unit by the desk's brief; named in the PR.
- With `pinSessionsToPool: false` and no account reading walled, the default login is used even if it is walled-but-unread.
- When some Codex account is walled but no other account has a fresh reading under the soft threshold (poller behind, or every other account above 90%), the spawn falls back to the default login, which may be the walled one. Chosen over picking an unproven login; the refusal only covers the all-walled case.

## 3. Level-of-abstraction fit

Right layer: the decision lives in `UsageWallRescue`, which already owns spawn-account choice and the walled predicate; `SessionManager` only applies the result, mirroring the existing Claude resolver. No parallel quota logic was added — `isKnownWalled`, `walledWindowResetMs`, `usableAccounts`, `bindingUtilization` and the soft threshold are reused.

## 4. Signal vs authority compliance

The refusal is a block, but it is not brittle pattern-matching: it acts only on the pool's own measured quota reading at or above 100% (the provider's hard wall) with an unexpired reset, the same evidence the rescue already acts on. The alternative it replaces is a guaranteed failure (the session exits at its first turn), so the block removes no working outcome in the evidenced case. Any uncertainty (no reading, stale reading past reset) resolves to placing, not refusing.

## 4b. Judgment-point check

Not a competing-signals judgment point: one measured number against the provider's fixed 100% wall. Ranking among accounts with room is an optimisation, not a gate.

## 5. Interactions

- `accountPin` (explicit pin) wins, unchanged.
- The `account-pin-framework-unsupported` check applies only to explicit pins; the resolver pin goes through `resolvePinnedSpawnHome` (credential-location gate) like the existing Codex pin path.
- Codex model swap on rate limit (`resolveCodexLaunchModel`) still runs; it reads the default home's rollout, so with a pinned account it may decide on another account's reading. Pre-existing for explicit pins; noted.
- Scheduler: a Codex job spawn that is refused now throws instead of launching and exiting 1. Both are a failed run for the scheduler; the refusal is faster and names the cause.
- Heavy-work forwarder: the 409 with a code is classed "refused", so it can try another machine — desired.
- Sessions now tagged with a Codex account become visible to the existing wall rescue's tag lookups; the rescue's Codex move still requires 2+ usable accounts and its own gates.

## 6. External surfaces

`POST /sessions/spawn` can now return 409 `codex-accounts-walled`. Reap-log rows gain an optional `subscriptionAccountId`. Session records for Codex spawns gain `subscriptionAccountId`. No user-facing message text added.

## 7. Multi-machine posture (Cross-Machine Coherence)

Wiring note: the resolver is set in the same `server.ts` block as the existing Claude spawn resolver, which runs only when a Telegram or Slack adapter is present. An agent with neither gets neither guard; that gap predates this change and applies equally to Claude, so this change does not widen it.

Machine-local by design: each machine's pool lists the accounts executable on that machine (`isLocallyExecutable`), and a spawn runs on the machine that places it. The incident was machine-local (Mama PC). No new status surface.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit; no data or config migration. Sessions already tagged keep their tag harmlessly.

## Conclusion

Narrow fix making the documented "never launch on a walled login" rule apply to headless Codex spawns, reusing the rescue's predicate. Ship.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, round 1

Round 1: **Concern raised** — the first version pinned every Codex spawn with 1+ usable accounts, including unread (possibly expired-login) and pressured accounts, unlike `spawnAccount()`'s fresh-and-under-threshold rule; a healthy default login could lose every spawn to an enrolled account with a broken login, and the artifact wrongly called that the Claude posture. Also noted: the wiring sits inside the Telegram/Slack block (pre-existing, now named in §7). Cause, refusal logic, throw-site leaks and interactions were confirmed.

Round 2: **Concur with the review** (stale wording in §2 and the summary noted and corrected).

Round 1 resolution: selection now requires a fresh reading under the soft threshold, tags all spawns only when the rescue is effective (2+ usable) and pinning is not off, and otherwise acts only when a Codex account is walled; unit tests cover unread, pressured and stale candidates being refused as picks.

## Evidence pointers

- `tests/unit/codex-spawn-wall-placement.test.ts`
- `tests/integration/codex-spawn-wall-placement.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller (spawn placement runs once per spawn request) — not applicable.
