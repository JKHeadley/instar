# Side-Effects Review — interactive session stuck at an expired Claude login (CMT-1008)

**Version / slug:** `interactive-login-expired-recovery`
**Date:** `2026-10-25`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary of the change

Tier 1 (declared; reasoning in the trace). A Claude pool account with an expired CLI login whose token still answers the OAuth usage endpoint stayed `active`; interactive topic sessions placed on it printed "Login expired · Please run /login" / "Not logged in · Run /login" forever. Files: `src/core/LoginExpiredSignature.ts` (new wording), `src/core/SessionManager.ts` (interactive detection, signal only), `src/core/QuotaPoller.ts` (`observeCliLoginExpired` + hold), `src/core/InteractiveLoginExpiredRecovery.ts` (new: mark then swap), `src/commands/server.ts` (wiring; job sink now uses `observeCliLoginExpired`), `src/core/SubscriptionLoginLedger.ts` (comment), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (awareness bullet + migration), tests in all three tiers.

## Decision-point inventory

- `SessionManager.reportInteractiveLoginExpired` — add — detector: live-tail, glyph-led, line-start frame, 60 s dwell, once per episode. No authority.
- `QuotaPoller.observeCliLoginExpired` — add — pool authority: readable credential + one dwelled sighting → needs-reauth (`cli-login-expired-observed`, exchange-corroborated).
- `QuotaPoller.pollAccount` / `pollAll` restore — modify — a successful usage read no longer restores `active` while a hold applies (same credential fingerprint, same slot, under 12 h). The hold blocks only the poller's own restore: a status set back to anything else from outside (assisted-repair success, operator) releases it.
- `InteractiveLoginExpiredRecovery.handle` — add — calls the existing reactive swap funnel only once the pool reports the account needs-reauth (or the pool read failed); own brakes: 10-min cooldown and a 3-attempt cap per session (`decideLoginExpiredSwap`, registered as self-action controller `interactive-login-expired-swap` and driven by the convergence ratchet), protected skip, kill switch.
- Job-session sink — modify — a message-led frame now goes to `observeCliLoginExpired` (was sighting-only), so one job session at the screen on a readable credential also marks the account; a tool-result-led frame stays a sighting. The job kill decision itself is unchanged.

---

## 1. Over-block

The marking takes an account out of placement. A false mark would need Claude Code's own MESSAGE line (`⏺`/`●`-led, line-start frame naming `/login`) on the live tail for a full minute while the credential reads. Tool-result lines (`⎿ Not logged in · Run /login` from `claude auth status`, `⎿ Please run /login` from a grep) never change pool state: the new wording only matches when message-led, and both authoritative paths require `messageLed`. Known residual: if the CLI reads a different credential store than the poller (both readable, CLI's one dead), the hold keeps the account out until a sign-in changes the poller-visible credential, a slot swap, or 12 h — that is the correct outcome (sessions on it cannot work). A locked keychain (unreadable credential) is excluded and keeps the two-session rule.

## 2. Under-block

- After a server restart the in-memory hold is gone; the next poll restores `active`, and the next session landing there is detected again within ~1 min and moved (one bad minute per restart, bounded).
- A session the swap cannot move (no eligible alternate, refresh refused) stays at the screen; a degradation is reported, re-offered up to 3 times (10 min apart), then left alone until restart; the account still reads needs-reauth so new sessions avoid it.
- Unreadable credential (locked keychain or genuinely removed): the session is not moved until the two-session rule marks the account; then the 10-minute re-offer moves it. Up to ~10 min of a stuck session in that case.
- Codex sessions are out of scope (Codex has its own app-server login check).

## 3. Level-of-abstraction fit

Detection stays in SessionManager (it owns pane capture), pool status stays in the QuotaPoller (the existing single authority), and moving a session reuses `QuotaAwareScheduler.onQuotaPressure` → `SessionRefresh` (account selection, anti-thrash observation, swap work gate, rate guard). The new module only sequences them.

## 4. Signal vs authority compliance

The pane classifier remains a signal. The authorities are the existing ones (QuotaPoller for status, the swap funnel for moving). The poller's new rule is narrow and evidence-based (the CLI's own refusal), and is released by any credential change. Ref `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

Not a competing-signals judgment point: the CLI refusing to run is direct evidence, not a heuristic weighed against others; the only competing signal (usage read succeeds) is exactly the false positive being corrected, and the hold is bounded.

## 5. Interactions

- Assisted relogin: `observe()` emits `transition-to-needs-reauth` with an actionable cause, so the ledger records the needs-reauth status and the repair can open; `verifyAuthenticatedUse` calls `pollAccount` (a new token releases the hold) and `finalizeSuccess` restores `active` directly, which the poller treats as releasing the hold. Note: for this cause, `verifyAuthenticatedUse` proves only that the token answers the usage endpoint, which it did all along; if the CLI is still refused afterwards, the next session to land on the account detects it within ~1 min and re-marks it. Bounded by the repair's own retry/breaker; a CLI-level verify step for this cause is a separate improvement (filed as feedback).
- Credential swaps call `invalidateIdentityCache`, which now also clears holds for the slot.
- ProactiveSwapMonitor login-loss path (identity drift) is separate; a needs-reauth source is simply not a target there.
- Reaper/idle: the interactive check does not `continue`; the default lane runs unchanged.

## 6. External surfaces

User-visible: a stuck conversation resumes on another account (the swap's normal behavior). Pool status of the dead account reads needs-reauth on the dashboard/API. New config key `subscriptionPool.loginExpiredSwap.enabled` (absent = on, read live).

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: a Claude login (config home + keychain) exists per machine, sessions are per machine, and the subscription pool cell is account × machine. No user-facing notice is added (the swap's existing behavior only); no durable state is added (hold is in memory); no URLs.

## 8. Rollback cost

Pure code change. Swap off live via `subscriptionPool.loginExpiredSwap.enabled: false`; full back-out is a revert. No persisted state beyond the account status, which the assisted repair or next clean poll restores.

## Conclusion

Second pass raised five points; all changed in code or recorded above (see below). Re-review concurred; clear to ship.

## Second-pass review

Reviewer (independent subagent, 2026-10-25), first read: **Concern raised** —
1. `⎿`-led tool output (`claude auth status`, greps) could mark a healthy account from one session. → Fixed: `messageLed` on the classifier; the new wording requires it, both authoritative paths require it; tests for `⎿` tool output.
2. The hold fought the assisted repair / operator restore (finalizeSuccess set active; next poll re-marked). → Fixed: any outside status change releases the hold; test flipped.
3. Hold is in memory. → Accepted residual (§2): after a restart the next session re-detects within ~1 min.
4. Rerouted bullet's pool sentence was now wrong. → Rewritten + V1→new migration with test.
5. Locked keychain: sessions swapped every 10 min onto the same failure. → Fixed: swap only when the pool confirms needs-reauth (outcome `not-confirmed` otherwise); test added.
Also noted (not changed): for this cause the repair's `verifyAuthenticatedUse` cannot prove the CLI works (§5).

Re-read after the fixes: **Concur.** All five points confirmed closed or accepted as documented. The reviewer named one remaining residual: `verifyAuthenticatedUse` proves nothing for this cause, so a repair that "succeeds" without changing the credential is detected again by the next session within about a minute (bounded). The ⎿-led older frames still trigger the job kill path, which is how it worked before this change and touches no pool state.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (the new recovery swaps a session on its own).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts}`. Registered controller `interactive-login-expired-swap` drives the real `decideLoginExpiredSwap` brake: at most one swap per session per 10 min and 3 per session, so under a permanently refused swap the count settles at 3 (horizon-independent); successes are bounded by the pool size because each dead source account is marked needs-reauth and excluded.
