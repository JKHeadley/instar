# Side-Effects Review — quota pacing step 3: spend by served account

**Version / slug:** `quota-pacing-spend-by-account`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `not required (read-only measurement; no gate, sentinel, lifecycle or messaging surface)`

## Summary of the change

Tier 1: read-only, additive and dev-gated, so a revert or the switch undoes it.

**Size:** 19 files, about 1,800 added lines. About 1,230 are source:
- new: `IdentityCheckLog.ts`, `servedAccount.ts`, `servedAccountReport.ts`, `usageAccountRoutes.ts`, an awareness entry
- changed: `UsageLedger.ts`, `QuotaPoller.ts`, `AgentServer.ts`, `usageRoutes.ts`, `usageReadModel.ts`, `CapabilityIndex.ts`, `devGatedFeatures.ts`, `types.ts`, `feature-ladders.json`

The rest is tests: three unit files, one integration file and one e2e file.

**Effort:** 3 spec review rounds (the Tier-1 cap); the build took one commit attempt.

**What it does.** Every usage-ledger row now records which account served it:
- **Slot:** the transcript folder (config home).
- **Account in the slot:** from the credential ledger when re-pointing is in use, verified at or before the row. Otherwise from the enrollment home, judged against a new per-slot record of the poller's identity checks at the row's time.
- **Basis:** every row carries one. The tag stays in `account_id`, untouched.

It adds three bearer-only read routes:
- `/usage/accounts`
- `/usage/accounts/size`
- `/usage/account-mismatches`

There is also `/usage/accounts/spend`, the per-machine target the size route fans out to.

## Decision-point inventory

No block/allow surface. Nothing reads the new numbers to place, swap, shed or route work.
- `servedAccount` resolver: **add**. A measurement classification of each row, with its basis. It decides nothing about work.
- `QuotaPoller.reconcileIdentity`: **pass-through**. It now also writes one line to the identity-check record. The poll result, drift handling and credential ledger writes are unchanged.

---

## 1. Over-block

No block/allow surface, so over-block does not apply. The nearest analogue is a row recorded with a null account when the evidence was thin: `identity-unconfirmed`, `slot-changed`, `ambiguous-root`. That is shown as its own labelled bucket, never dropped.

## 2. Under-block

No block/allow surface, so under-block does not apply. Known measurement gaps, all labelled:
- Codex identity is never checked, so every Codex row is `identity-unconfirmed`.
- Use of a login outside this agent adds points but no ledger cost. The cost per point is therefore labelled a lower bound.
- The credential ledger's journal is pruned, so an old row with no verification on record reads `ledger-unverified`.

## 3. Level-of-abstraction fit

It is a detector: cheap, local, deterministic classification. It sits where the data already is, the ledger's scan path, which already knows the root of every file it reads. It reuses what exists rather than re-implementing it:
- the credential ledger (verified tenancy)
- the poller's identity oracle (it now records each check)
- step 1's reading history and identity key
- the shared pool fan-out
- the on-read pricing

The rollups are deliberately left alone. Re-keying them would be a table rebuild plus a replication change, and the raw rows already serve this read.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It is a measurement. No consumer acts on it in this step; a later step that does needs its own spec, with a floor and an arbiter.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The spec's `## Decision points touched` classifies:
- the root as the slot: invariant, external-constraint
- the tenant judgment: judgment-candidate, floor null-never-guess
- the size-of-a-point labels, which only label and never withhold: judgment-candidate

The identity-check grace (3 poll intervals) and the low-quality marks (5 points, 10%) can only make a row unconfirmed or a figure labelled. They never make a figure appear.

## 5. Interactions

- **Scan path:** the per-row work is an in-memory lookup. The slot map is rebuilt only when the pool list or the ledger version changes. The session-start lookup is one indexed query per row on the no-binding path.
- **Copied-history promotion:** this path now also writes the served fields.
- **Dedupe pairs:** unchanged. In the account reads, a paired invocation counts its call but not its tokens, which moved to the transcript row. That matches the rollups.
- **`/usage/coverage`:** gains `accountMismatches` (a local count).
- **Poller:** one extra durable write per identity-check change, plus a rewrite of the last line every 15 minutes at most. A failed write is caught and leaves the poll unchanged.

## 6. External surfaces

- **New routes:** three, plus one machine-to-machine route.
- **New state files:**
  - `.instar/state/identity-checks/<hash>.jsonl`, one per slot. Hashed names, identity keys only, never emails.
  - `.instar/state/served-account-switch.jsonl`.
- **No messages.**
- **No phone allowlist:** the routes are bearer only.

## 6b. Operator-surface quality

No dashboard, approval page or grant form is touched, so this does not apply.

## 7. Multi-machine posture

- **Raw rows and the new columns:** unified, proxied on read. The holder fans out to every machine at request time and names peers that did not answer: `served-account-unsupported` for a 404, `served-account-off` for a 503. A standby proxies to the holder.
- **Slot resolver and the identity-check record:** machine-local by design. Justification: physical-credential-locality. A config home and its credentials are on this disk.
- **Switch:** resolves from the agent-wide development flag. A machine with it off writes `served_basis: 'off'`, and its switch history travels with its answers, so a split shows in every read.
- **Status surfaces:** CapabilityIndex `usageServedAccount` entry and the awareness entry.

## 8. Rollback cost

- **Off without a revert:** set `usage.ledger.servedAccount: false` and restart. Rows are then written as `off`, the routes answer 503, and the columns stay inert.
- **Full back-out:** a revert. The added nullable columns and the two small logs are harmless if left behind.
- No data migration to undo; no agent state to repair.

## Conclusion

A read-only measurement that fixes the label-only account attribution behind the 2026-11-17 wrong-account mix-up. It adds nothing with authority over work.

## Second-pass review (if required)

**Reviewer:** not required: no gate, sentinel, watchdog, lifecycle, messaging or trust surface.

## Evidence pointers

- **Unit:**
  - `tests/unit/served-account-resolver.test.ts` (7)
  - `tests/unit/UsageLedger.servedAccount.test.ts` (6)
  - `tests/unit/served-account-report.test.ts` (9)
- **Integration:** `tests/integration/usage-served-account-routes.test.ts` (4).
- **E2E:** `tests/e2e/usage-served-account-alive.test.ts` (2).
- **Existing suites re-run green:**
  - the five UsageLedger unit files (79)
  - `feature-ladders-coverage`, `awareness-entry-registry`, `quota-poller`, `usageLedgerTick` (100)
  - `devGatedFeatures-wiring`, `CapabilityIndex`, `awareness-entry-registry-consumers` (357)

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration). This change adds no self-triggered action. It is a read-only measurement: usage rows record their served account, and new read routes report it. Nothing restarts, swaps, spawns, notifies, retries or kills. The only new writes are two small state logs, an identity-check record per slot and the switch history, each written on a change and bounded.
