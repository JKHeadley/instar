# Side-Effects Review — Session account must match the session's framework; exact-target swap repair

**Version / slug:** `session-account-framework-match`
**Date:** `2026-11-28`
**Author:** `echo (Subscription Management, Mac M5 Pro)`
**Second-pass reviewer:** a fresh read-only Claude sub-agent (see the section below)

## Summary of the change

On 2026-11-28 at 03:58 PT, Windows App topic 144319 on Mama was respawned. It runs codex-cli under Justin's Codex pin, but it was tagged with the Claude account `justin-gmail`. It sat at the Codex sign-in menu while `codex-sagemindai` was active. Two gaps allowed this.

The first gap: neither SessionRefresh nor `spawnInteractiveSession` checked that an explicit account's framework matches the session's.
- New module `src/core/accountFrameworkMatch.ts` holds a pure check.
- `SessionManager.setAccountFrameworkLookup()` is wired in `src/commands/server.ts` from the subscription pool, by account id or by normalised config home.
- When the check fails, `spawnInteractiveSessionUnlocked` drops the caller's `configHome` and `subscriptionAccountId`, logs the reason, and lets the normal placement for the session's own framework choose.

The second gap: `POST /subscription-pool/swap` inferred the framework from `exhaustedAccountId` and took no destination.
- The route (`src/server/routes.ts`) now passes the live session's framework.
- It accepts an optional `targetAccountId`, which it checks against the pool and the session framework.
- It hands the target to a new `repairTargetAccountId` branch in `QuotaAwareScheduler.onQuotaPressure`. That branch requires the target to be of the same framework, not the source, and measured and eligible under the soft threshold. Unlike the proactive `targetAccountId`, it does not require the source to be under pressure.

## Decision-point inventory

- Spawn account choice (`spawnInteractiveSessionUnlocked`): **modify**. A mismatched explicit account is dropped and placement re-selects.
- Swap target selection (`QuotaAwareScheduler.onQuotaPressure`): **add**. A repair branch takes an exact target with eligibility floors.
- Swap route input validation: **modify**. It gains `targetAccountId` (400, 404 and 409 refusals) and the session framework.

---

## 1. Over-block

The spawn check drops an account only when the pool says that account (or home) belongs to another framework. An account that isn't in the pool, a failed lookup, or no lookup at all keeps today's behaviour. A deliberate cross-framework launch has no legitimate use, because a Codex binary cannot use a Claude login. The route refuses only malformed, unknown or mismatched targets, and the combination with `balanceUnusedQuota`.

## 2. Under-block

Headless spawns (`spawnSession`) are not changed. Their Codex and Claude resolvers already pick by framework, and the incident path was interactive. A session whose record has no framework keeps the old inference in the route.

## 3. Level-of-abstraction fit

The spawn check sits at the one point every interactive start passes through. That covers SessionRefresh, the quota swap, stale-login refresh and future callers, so each caller does not need its own fix. The exact target reuses the scheduler's existing refresh and kill path, with its rate and lock handling, instead of adding a new mover.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No: this change has no block/allow surface over agent behaviour or messages.

The spawn check never blocks a start: it corrects an impossible account choice and continues. The repair is an explicit bearer-authenticated operator action with deterministic eligibility floors, the same class as the existing manual balance.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals point. "Same framework" is an invariant: a binary can only use its own engine's login. The repair's eligibility (measured, below the soft threshold, active, executable) reuses the existing `rankAccounts` floors.

## 5. Interactions

- **Shadowing:** the spawn check runs before the existing Codex "account pin requires its home" guard. When it drops a mismatched account, that guard no longer fires for this case, so the start continues instead of throwing.
- **Double-fire:** the repair cannot be combined with the proactive or manual intents; that is refused as `conflicting-swap-intent`. It does not feed the reactive anti-thrash counters.
- **Races:** it uses the same refresh path and its session lock. Like the existing manual balance, the repair runs as `interactive-refresh`, so SessionRefresh proceeds even over a busy turn. That is intended for an operator repair of a session stuck at a sign-in menu. The repair does not check that `exhaustedAccountId` is the session's current tag: that affects only the reason line, never which account is chosen.
- **Feedback loops:** none.

## 6. External surfaces

- **The swap route:** `/subscription-pool/swap` gains one optional field and three new refusal codes. Callers that send no `targetAccountId` are unchanged, except that the framework now comes from the live session (any framework in the shared subscription framework list; a session with none keeps the old inference). For a correctly tagged session the framework is the same, so the pick is unchanged.
- **Logs:** one new warning line when an account is dropped.
- **Other surfaces:** no change to persistent state, and no operator-facing screen.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local` by design: account homes and logins are per machine (physical-credential-locality). The lookup reads this machine's pool, and the route moves a session on the machine it is called on, the same as the existing swap. To repair a session on Mama, call Mama's route.

## 8. Rollback cost

Revert the commit. No state is written and no migration is needed.

## Conclusion

This is a small, reversible fix for a reproduced incident. Regression tests in the exact incident shape cover the pure check, the scheduler repair, the route, and the real `spawnInteractiveSession` path, in tests/unit/interactive-session-pin.test.ts: a Claude account dropped for a Codex session, the reverse, and a matching account kept.

## Second-pass review
**Reviewer:** a fresh read-only Claude sub-agent, given the diff and this artifact and told to audit the artifact against the code (2026-11-28 04:16 PT, uncommitted tree in .worktrees/session-account-framework).
**Independent read of the artifact:** at first, concern raised (MUST-FIX): the spawn guard and its server wiring had no test, so this artifact's "both layers" claim was overstated. That has been fixed. Three SessionManager-level tests now drive `spawnInteractiveSession` with the lookup wired, in both directions plus the matching case, and the conclusion has been corrected. The reviewer confirmed that items 1 to 6 are otherwise correct: the `options` reassignment reaches every later use, the home normalisation is right, the route survives `sessionManager: {}`, and the repair branch cannot reach an ineligible or wrong-framework account. Minor points: the target is now trimmed once for both the 404 check and the scheduler; the `interactive-refresh` busy-turn behaviour and the unchecked source tag are noted in section 5.

