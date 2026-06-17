# Side-Effects Review — WS5.2 §6.2 `locallyExecutable` selection gate

**Version / slug:** `ws52-account-follow-me-locally-executable`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `pending (high-risk: account selection / credential boundary)`

## Summary of the change

WS5.2 §6.2. Adds a single shared predicate `isLocallyExecutable(account)` (exported from `src/core/SubscriptionPool.ts`) — an account is executable on THIS machine iff it carries a real local `configHome` AND a valid login (status `active`/`warming`). A meta-only account replicated in from a peer (credential-less, empty `configHome`) is NOT locally executable. The predicate is applied at the account-selection chokepoint in `src/core/QuotaAwareScheduler.ts` — in BOTH `selectAccount()` (the placement/swap selector, used by `ProactiveSwapMonitor` + `onQuotaPressure`/`SessionMigrator`) AND `poolHeadroom()` (the quota-throttle), which MUST share the exact eligibility predicate to preserve the documented never-loop invariant `placeable ⟺ selectAccount(...) !== null`. A `SubscriptionPool.locallyExecutable()` convenience method returns the filtered selectable set. Files: `SubscriptionPool.ts`, `QuotaAwareScheduler.ts`, plus `tests/unit/account-follow-me-locally-executable.test.ts`.

## Decision-point inventory

- `QuotaAwareScheduler.selectAccount()` eligibility filter — **modify** — tightened from status-only (`isEligibleStatus`) to `isLocallyExecutable` (status + non-empty configHome). A credential-less account is now unselectable.
- `QuotaAwareScheduler.poolHeadroom()` eligibility filter — **modify** — tightened identically, preserving `placeable ⟺ selectAccount !== null`.
- `SubscriptionPool.locallyExecutable()` — **add** — canonical read of the machine-executable account set.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. Every genuinely-held pool account carries a non-empty `configHome` (required by `SubscriptionPool.add()`, which trims and validates it), so among real accounts this predicate is a pure no-op — it returns exactly what `isEligibleStatus` returned before. It only ever excludes an account with an empty/whitespace `configHome`, which by construction has no local credential and therefore cannot spawn a session. There is no legitimate "selectable account with no configHome" today.

## 2. Under-block

**What failure modes does this still miss?**

It gates SELECTION, not execution-time credential validity. An account that has a `configHome` and `active` status but whose on-disk token is stale/revoked still passes the predicate (the swap/refresh machinery + provider-side 401 handling owns that case — out of scope for §6.2). It also does not inspect token contents; a corrupted credential file at a valid `configHome` is caught downstream, not here. This is intentional: §6.2's job is "never select an account we hold no credential for," not "verify the credential works."

## 3. Level-of-abstraction fit

Correct layer. Account selection is exactly where "can this machine run this account?" must be decided — the predicate lives next to the `SubscriptionAccount` type (its canonical home) and is applied at the two selectors that gate placement. A higher layer (the router) does not select accounts (it routes SDK-vs-pool *path*, then the interactive pool runs whatever account the session was placed under); a lower layer (the credential store) does not know about selection. The shared-predicate design avoids the classic split-brain where two selectors drift.

## 4. Signal vs authority compliance

This is a **filter on a selection set**, not a brittle check with blocking authority over messages/actions. It is deterministic (a field-presence + status check), not heuristic — so it does not fall under the signal-vs-authority concern about brittle blocking logic. It cannot mis-fire on ambiguous input: `configHome` is either a non-empty string or not. It never blocks a user message or an outbound action; it only narrows which accounts a placement/swap may pick. Reference: `docs/signal-vs-authority.md` — a deterministic capability gate (can this machine physically execute this account) is authority appropriately exercised, not a brittle heuristic.

## 5. Interactions

The one real interaction is the **never-loop invariant** between `selectAccount` and `poolHeadroom`: the throttle's comment guarantees `placeable ⟺ selectAccount(...) !== null`. Tightening only one selector would break it (throttle says "go" while placement returns null → spin). Both are tightened with the SAME predicate, and a unit test asserts the two agree on a meta-only account. No other selector consumes these. `ProactiveSwapMonitor`/`SessionMigrator`/`onQuotaPressure` reach selection THROUGH `selectAccount`, so they inherit the gate for free. `PlacementExecutor` (cross-machine placement) does not select an account, so it is unaffected.

## 6. External surfaces

No new route, no new config, no user-facing surface. `SubscriptionPool.locallyExecutable()` is a new read method but no route exposes it in this change. Behavior visible to other agents/users is unchanged because the predicate is a no-op for all real accounts today (all have configHomes). It does not depend on timing or runtime conditions.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** This is the precise point of the change: a `configHome` is a per-machine credential location, so "locally executable" is inherently a per-machine question. The predicate deliberately treats a peer's account (which would arrive as a credential-less meta projection if/when a future scope=pool selection merges peer accounts into a local selection list) as NON-executable here. There is no replication or proxy-on-read surface — by design, each machine answers "which accounts can I run?" from its OWN configHome-bearing accounts. This is the structural guard that lets the later enrollment-execution PRs safely add accounts without any path ever selecting a peer's credential-less account.

## 8. Rollback cost

Trivial. Pure code change, no migration, no persisted state, no config. Revert is a single-commit back-out; because the predicate is a no-op for all current accounts, reverting changes nothing observable today. No agent state repair, no data migration.

---

## Second-pass review

**Concur with the review.** Verified independently against the actual code, spec §6.2/§6.3a, build, and tests:

1. **Never-loop invariant preserved** — `selectAccount` (`QuotaAwareScheduler.ts:103-108`) and `poolHeadroom` (`:141-143`) use the byte-identical eligibility predicate `isLocallyExecutable(a) && bindingUtilization(a.lastQuota) < soft`. `selectAccount`'s extra `a.id !== excludeId` is a pure narrowing on the swap path; the throttle calls `poolHeadroom` without an exclude, so `placeable ⟺ selectAccount(...) !== null` holds.
2. **True no-op for current accounts** — `add()` (`SubscriptionPool.ts:308-309`) and `update()` (`:356-359`) both trim and reject empty `configHome`; no real account can have one. For real accounts `isLocallyExecutable` reduces to the old `active/warming` status check — exact behavioral parity.
3. **Zero dangling `isEligibleStatus`** — grep across `src/` + `tests/` returns nothing; `tsc --noEmit` EXIT=0.
4. **No missed selection path** — all `selectAccount`/`poolHeadroom` callers (`ProactiveSwapMonitor:226` swap-target, `server.ts:14343` spawn-resolver, `onQuotaPressure`, QuotaTracker throttle) route through the gated selectors. `AnthropicSubscriptionRouter` routes SDK-vs-pool *paths*, not accounts; `InteractivePoolIntelligenceProvider` runs sessions already spawned under a gated account; `mapCandidates` only enumerates running-session SOURCES; no `.list()[0]`-style ungated picks exist; `PlacementExecutor` doesn't select accounts.
5. **Tests cover both boundary sides + invariant agreement** — 9/9 pass; explicit `poolHeadroom.placeable ⟺ selectAccount !== null` assertions for meta-only and real cases.
6. **No fail-OPEN** — predicate is fail-closed (missing/non-string/empty `configHome` → false).

Sound, well-tested pure tightening with the never-loop invariant correctly preserved.
