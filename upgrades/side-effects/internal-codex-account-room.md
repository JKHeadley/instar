# Side-Effects Review — internal Codex calls use the account with the most room

**Version / slug:** `internal-codex-account-room`
**Date:** `2026-11-08`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Internal Codex calls (sentinels, gates, extractors) ran only on the machine's ambient `~/.codex` login. When that login hit its weekly wall, every background check failed until it reset, even with other enrolled Codex accounts `active` (Mama PC, 2026-11-06 20:49 PST, bug fb-feb1652a-948). This change wires the provider's existing `resolveAccount` hook. A new `pickInternalCallAccount` chooses the `active`, locally executable Codex account with the most room by its last live quota reading, and returns null (ambient, the old behavior) when none qualifies. `src/core/internalCodexAccount.ts` holds the late binding, because providers are built before the pool. The sibling failure tail (`eligibleSiblingAccounts`) now skips siblings whose live reading is at a wall and siblings holding the same login (email) as the failed account. It orders siblings by room and excludes the account the internal call was given. Off switch: `intelligence.codexAccountSelection.enabled: false`.

Files: `src/core/SubscriptionPool.ts`, `src/core/internalCodexAccount.ts` (new), `src/core/intelligenceProviderFactory.ts`, `src/core/types.ts`, `src/commands/server.ts`, tests in `tests/unit/` and `tests/integration/`.

Tier 1: small and reversible; a revert or the off switch restores the ambient-only behavior. About 200 lines of source plus tests, one review round.

## Decision-point inventory

- Which login an internal Codex call runs under — **modify**: ambient-only becomes the pool account with the most room, falling back to ambient.
- Sibling-account eligibility in the router failure tail — **modify**: adds wall, same-identity and picked-account exclusions and orders by room.
- No block/allow decision about messages or actions is added or changed.

---

## 1. Over-block

No block/allow surface. In selection terms, an account with room but no fresh reading (no `lastQuota`, or a window past its reset) is never picked as the primary; ambient is used instead. That matches the old behavior, so it isn't a regression.

## 2. Under-block

- A login at its wall that still has credits is treated as walled and is not chosen. Calls then go to an account with room, or to ambient, which may spend credits as before. Spending credits is allowed (no extra charge), so this is a choice, not a miss.
- If the ambient home is unenrolled but holds the same login as an enrolled row, its identity is unknown, so the twin exclusion cannot fire for it. The wall exclusion still applies when that login is walled.
- `lastInternalCodexAccountId` is the latest pick, not a per-call record. Two concurrent calls given different picks could exclude the wrong one in the tail. Picks come from quota readings that change every few minutes, so this is rare, and the worst case is the old behavior: one retry on an account that may also fail.

## 3. Level-of-abstraction fit

Right layer. The pool owns account state and quota readings, so the policy lives in `SubscriptionPool.ts` beside `eligibleSiblingAccounts` and `isLocallyExecutable`. The provider already had the hook (`resolveAccount`, documented as "a separate, deliberate act"); this is that act. No parallel selector was added.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It picks a route for a call that would run anyway; it never refuses a call. A broken source degrades to ambient.

## 4b. Judgment-point check

A static rule (most room by the last reading) at a routing point. Signals here are enumerable numbers (window percentages and reset times), not competing live judgments, and every branch falls back to the pre-existing behavior. No new static heuristic at a competing-signals decision point.

## 5. Interactions

- **Router sibling tail**: the primary now usually runs on the roomiest account, which is also the first sibling candidate. Without excluding the pick, the tail would retry the same account. Fixed with `lastInternalCodexAccountId`, plus a wiring test that pins it.
- **`accountOverride`** (the tail's retry) still wins over the resolver, unchanged.
- **Per-account health observer** (`onCallObserved`) now receives samples for internal calls, because an account is named. This is the intended input; it was dark before because no account was ever named.
- **Codex quota guard / builders**: internal calls now consume the roomiest account. On 2026-11-07 that was justin@ (1%), which builders were also told to use. Internal checks are light-model calls; Justin's rule (topic 130742, 2026-11-07 12:53 PST) is that they always keep room.
- **SpawnCap / breaker** wrap unchanged; one breaker per framework, as before.

## 6. External surfaces

Which provider account answers internal calls changes, and so does which account's quota they use. Rollouts land in the picked slot's home instead of `~/.codex`. No user-visible message, route or dashboard change. Depends on poller readings being reasonably fresh; a stale reading only shifts preference.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Each machine picks among the accounts it holds locally (`isLocallyExecutable` excludes meta-only rows replicated from peers), using its own pool readings. No login crosses machines. No new status surface.

## 8. Rollback cost

Set `intelligence.codexAccountSelection.enabled: false` and restart: every call is ambient again. Or revert the commit. No data migration or state repair needed.

## Conclusion

Ships. The defect stranded every background check on one walled login, and the fix reuses existing hooks with an ambient fallback at every step.

## Second-pass review (if required)

Not required by category (no messaging gate, session lifecycle or sentinel authority changes), but an independent read was requested because it changes which credential internal calls use.

**Reviewer:** independent general-purpose subagent, 2026-11-08 01:08 PST
**Independent read of the artifact: concern**, now resolved:
1. The twin-login check could follow the ambient row instead of the account that ran, so the tail could retry the same login under another slot. Fixed: a known id identifies the failed account; the ambient home only when no id is known. Test: "the twin check follows the account that RAN".
2. When a call ran on a named account, the tail still excluded the ambient login, which never ran and may be the one healthy login left. Fixed: ambient is excluded only when the call ran ambient. Test: "a call that ran on a NAMED account keeps the ambient login as a sibling".
3. `lastPicked` is process-wide, not per call (already listed under Under-block). Accepted: the worst case is one retry on an account that also fails, then the existing door tail.
4. Re-read after the fixes (01:09 PST): **concur**. Noted side effect of item 3: if a stale pick reaches the tail for a call that actually ran ambient, the tail may offer the failed ambient login once. That needs concurrent picks flipping between "no account" and "an account", so it is rare, and the cost is one retry.
5. `onCallObserved` has no consumer in the server, so per-account health samples are not recorded. Not a defect of this change; it was already dark.

## Evidence pointers

- `tests/unit/internal-codex-account-room.test.ts`
- `tests/unit/eligible-sibling-accounts.test.ts` (existing, still passing)
- `tests/integration/internal-codex-account-room.test.ts` (real pool, real factory build, real child process)
- Live incident data: fb-feb1652a-948; pool readings 2026-11-07 20:45Z on five machines.
