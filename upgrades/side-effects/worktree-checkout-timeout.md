# Side-Effects Review — Worktree checkout timeout

**Date:**2026-11-23. **Author:**Instar Agent(echo). **Tier:**1, SMALL.

## Summary

A narrow reversible repair passes an optional timeout through the manager's private Git wrappers and grants only worktree add300,000 ms. The shared executor default remains30,000 ms. No new setting, API, migration, authority or automatic cleanup. Root cause is confirmed by actual wrapper/executor reads; operational evidence includes two reported dashboard failures and an unregistered Accounts partial with7,819 matching source files and no extras/edits, removed through SafeFsExecutor under Chieffc2e6fa6.

## Decision-point inventory

Only the execution deadline changes. Branch/base selection, source-tree guard, path containment, capacity checks, create serialization, identity, hooks, dependencies and audit stay as existing authorities.

## 1. Over-block

Large healthy checkouts exceeding30 seconds are no longer stopped at that point. Five minutes remains a finite operational bound; exceptionally slow copies may still time out. No claim that five minutes covers every machine.

## 2. Under-block

A hung checkout may hold a subprocess and the per-agent creation lock up to five minutes instead of30 seconds. It still receives a deadline; there is no retry. Git's partial-directory behavior after failure is unchanged. The operational cleanup in this assignment is separate and verified, not an automatic deletion capability.

## 3. Level-of-abstraction fit

The manager knows that worktree add copies the whole source tree. It owns the override; increasing the shared executor default would unnecessarily extend unrelated operations. No parallel safety gate is introduced.

## 4. Signal versus authority

Reference: [signal versus authority](../../docs/signal-vs-authority.md). The native subprocess timeout remains an execution resource bound; it grants no permission and makes no semantic judgment. All existing safety authorities remain in place.

## 5. Interactions

Both new/existing branch paths converge on one add call. The timeout propagates through both private wrappers. Other read/write calls omit it and keep their defaults. The create lock can stay held longer and existing finally cleanup must release it even on deadline failure. No cancellation, retry, failure classification or ledger ordering changes.

## 6. External surfaces

Agents may wait longer for a healthy managed checkout rather than receiving an early failure. There are no added remote requests, costs, credentials, installed-file edits or user decisions. Timing remains machine-dependent.

## 7. Multi-machine posture

Machine-local by design: the checkout and its native subprocess budget belong to the machine creating it. The shipped manager gives every installation the same behavior after normal update. No new durable state or replicated claim; existing worktree ledger/audit paths and session placement are unchanged.

## 8. Rollback

Revert the wrapper/add timeout change in a normal release. No migration or state reversal. Existing successful worktrees and branch refs remain usable.

## Verification

The authorized baseline RED admitted normally and failed both selected new/existing branch cases for the expected inherited 30-second deadline; 13 other cases were excluded by selection. After the patch, all 15 integration cases passed with zero failures or skips. Source and test hashes match the independently reviewed candidate. Tests use actual Git repositories with a simulated45-second requirement at the executor boundary; they do not sleep45 seconds. New/existing branches, ordinary-operation defaults, deadline error propagation, one attempt and no success ledger are covered. Normal full coordinator verification remains required.

## Independent review

Reviewer worktree_timeout_review accepted the design and actual regression cases. Requested assertion that failure releases the creation lock, and explicit longer lock occupancy/unchanged partial cleanup disclosure. The reviewer independently read exact GREEN source/test candidate hashes and all three artifacts, and concurred. Those exact bytes were installed only after preserving RED output and then passed GREEN. No full-suite or deployment acceptance is claimed.

## Class closure

No agent-authored-artifact defect. No new autonomous action loop: one existing checkout receives a finite budget and no retries, spawns, notifications or state-repair actions are added.
