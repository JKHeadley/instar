# Side-Effects Review — Quiet Update Mechanics

**Version / slug:** `quiet-update-mechanics`
**Date:** `2026-06-04`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Update **mechanics** notifications (raw version numbers + restart plumbing) are reclassified as housekeeping and routed to the logs instead of the user's Agent Updates topic. A new pure module `src/core/updateNotifyPolicy.ts` classifies every update notification into `mechanics | interruption | actionable | failure-escalated`; `AutoUpdater.notify()` (`src/core/AutoUpdater.ts`) and the restart-handshake emit (`src/commands/server.ts`) gate on that decision at their single notify funnel. The default kind is `mechanics` (silent). All restart/interruption copy was rewritten version-free. A `updates.backgroundRefreshHeartbeat` config flag (`src/core/types.ts`, default false) opts into a single quiet background-refresh note. Files: `updateNotifyPolicy.ts` (new), `AutoUpdater.ts`, `server.ts`, `types.ts`, CLAUDE.md template + `PostUpdateMigrator.ts`, spec + eli16 + release fragment, and updated/new tests.

## Decision-point inventory

- `AutoUpdater.notify()` funnel — **modify** — now consults `decideUpdateNotify(kind)` and drops non-`reachUser` messages to the log.
- `server.ts` restart-handshake `failed` emit — **modify** — non-escalated mismatch → silent; escalated → reaches user, version-free.
- version-skew nudge / transient apply failure / cascade-batch notice — **modify** — reclassified `mechanics` (silent).
- max-deferral forced restart / restart narration / deferral threshold warnings — **modify** — `interruption`, version-free, still reach the user.
- manual-update-available (auto-apply off) — **modify** — `actionable`, version-free, still reaches the user.
- idle-restart path — **add** — emits a `mechanics` + `isBackgroundRefreshConfirmation` note (silent unless option B).

## 1. Over-block

This is a notification *suppression* surface, so "over-block" = silencing a message the user genuinely needed. Concrete cases considered:

- A restart that interrupts the user's active work → still sent (`interruption`), so NOT over-silenced.
- A genuinely stuck update (restart won't take after retries) → still sent (`failure-escalated`), so NOT over-silenced.
- A manual update awaiting the user's go-ahead (auto-apply off) → still sent (`actionable`), so NOT over-silenced.

The only messages now silenced are version churn, restart-batch coordination, transient self-healing skew, and transient apply failures that retry next cycle — none of which carry user-actionable information. The user explicitly requested this silence (option A, 2026-06-04).

## 2. Under-block

"Under-block" = noise that still reaches the user. The default-`mechanics` rule means a *new* update message is silent unless explicitly classified user-facing, so the failure mode points at silence, not leakage. Residual: the three reaching kinds (`interruption`/`actionable`/`failure-escalated`) still send — by design — but are now version-free, so even they can't leak version churn. A test asserts no `\d+\.\d+\.\d+` appears in the interruption/actionable copy.

## 3. Level-of-abstraction fit

Correct layer. The policy is a low-level pure decision function (no I/O, no state) that the existing `notify()` funnel *uses* — it does not re-implement sending and does not run parallel to an existing gate. It feeds the single chokepoint every update notification already passed through, rather than adding a new interception point. This mirrors the sibling `mature-update-announcements` design (the announcement layer) one level down at the mechanics layer.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface in the security sense; it is a routing/visibility decision over the agent's OWN outbound status messages (not user input, not another agent's traffic).

The policy holds "reach the user or log" authority, but the logic is trivial and deterministic (a 4-way switch on an internal enum the calling code sets), not a brittle classifier guessing at untrusted input. There is no content parsing, no heuristic, nothing to be fooled. It cannot wrongly suppress a user message because it never sees user messages — only the auto-updater's own status strings, each explicitly tagged at the callsite by the developer.

## 5. Interactions

- **Shadowing:** the policy runs at the top of `notify()`, before the Telegram send. It can suppress the send, but suppression is the intended behavior and is logged. It does not shadow any other check — `notify()` is the terminal step. The patch-only Fork-3 suppression (mature-update-announcements) still runs upstream and is unaffected; the restart handshake is still written for verification even when the message is suppressed.
- **Double-fire:** none introduced. The existing per-version dedup guards (`notifiedVersionMismatch`, `lastNotifiedRestartVersion`) are untouched; reclassifying their messages to silent doesn't change their once-per-version semantics.
- **Races:** no new shared state. The `backgroundRefreshHeartbeat` flag is read-only config. No new timers or files.
- **Feedback loops:** none. Suppressing a notification cannot feed back into the updater's decision logic.

## 6. External surfaces

- **Other agents same machine:** none — this only changes what this agent posts to its own Updates topic.
- **Install base:** yes, intentionally — every agent gets quieter update messaging on npm update. This is the requested behavior. No breaking change to any API or message contract consumers depend on (the Updates topic is human-facing, not machine-parsed).
- **External systems:** Telegram — strictly *fewer* sends. No format change to the messages that still go out beyond removing version numbers.
- **Persistent state:** none. No ledger, DB, or state-file schema change. `backgroundRefreshHeartbeat` is an optional config key (absent = default false).
- **Timing/runtime:** none.

## 7. Rollback cost

Pure code change — revert the PR and ship as the next patch. No persistent state is written, no migration to undo (the config key is additive and optional; absence = the shipped default). No agent-state repair needed. During a rollback window the only "regression" the user would see is the *return* of the version-churn noise — annoying, not harmful, and self-corrects when the revert propagates. Worst realistic failure mode (over-silencing) is recoverable: flip `backgroundRefreshHeartbeat` on for a heartbeat, or revert. Low risk → Tier 1.

## Conclusion

The review surfaced no over-block of user-needed messages (interruption / actionable / stuck all still reach the user) and no new races, double-fires, or external-contract breaks. The one design refinement made during review: the option-B heartbeat flag was scoped so it can surface ONLY the single background-refresh confirmation, never any other mechanics message — closing the "flag reopens the flood" path. Clear to ship as Tier 1.

## Second-pass review (if required)

**Reviewer:** not required — Tier 1 (low-risk, notification-suppression-only, no persistent state, additive config, user pre-approved the approach).

## Evidence pointers

- `tests/unit/update-notify-policy.test.ts`, `tests/unit/update-notify-routing.test.ts` — 16/16 green (policy both-sides + funnel wiring).
- `tests/unit/PostUpdateMigrator-quietUpdateMechanics.test.ts` — 5/5 (migration parity).
- Updated to new contract + green: `notification-spam-prevention`, `auto-updater-failures`, `graceful-updates-phase2`, `update-notification-topic-lock`.
- Regression-safe: `AutoUpdater`, `AutoUpdater-cascade-dampener`, `restart-window`, e2e `self-heal-cascade-and-drift`, integration `updates-status-restart-immediately-route`, `stall-recovery-e2e`.
- `tsc` build clean.
