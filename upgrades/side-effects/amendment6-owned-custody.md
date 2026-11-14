# Side-Effects Review — Amendment 6, owned-machine Pending exception

**Version / slug:** `amendment6-owned-custody`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra, independent read of the registry diff`

## Summary of the change

Constitution text only, Tier 1: four edits to one article in `docs/STANDARDS-REGISTRY.md`, plus the Building audit, its review report, the ELI16 and a release fragment. It supersedes unmerged PR #2796. Justin's 09:50 ruling (telegram 136110/139094) makes an outside witness unusable as the basis of the exception. The new text makes owned machines the default, names three states the person is told, and adds a native-owner-loss policy. No runtime code changes. Effort: two Astra rounds plus one launch killed before finishing; the first round found one real must-fix.

## Decision-point inventory

None added or changed in code. The article sets a rule for future designs; only the Conversations hierarchy may use it.

---

## 1. Over-block

No block surface. The text refuses nothing at runtime.

## 2. Under-block

Nothing deterministic checks the text yet, and the article says so: the five reviewer questions are the only hold. A design could still claim a state early until the Conversations build adds its checks.

## 3. Level-of-abstraction fit

The exception belongs in the survivability article because that is the rule it narrows. Mechanism detail stays in the design; the article states outcomes and what the person is told.

## 4. Signal vs authority compliance

Not a decision point. No detector or gate is added, so `docs/signal-vs-authority.md` is not engaged.

## 4b. Judgment-point check

Not a decision point: no judgment is added to runtime.

## 5. Interactions

It relies on *No Feature May Require a Purchased Service* and leaves it unchanged. It keeps the existing all-member rule for acknowledged graph changes, erasure tombstones and completed answers. PR #2796 edits the same sentences, so only one of the two can merge; #2796 stays open for the hub to close.

## 6. External surfaces

None at runtime. The three state names are the words a future Conversations screen must use. Nothing ships to agents except the registry text.

## 6b. Operator-surface quality

No operator surface is added.

## 7. Multi-machine posture

Pending items are a transient state of `unified` state, not a new posture. This change itself is a document and has no machine-local state.

## 8. Rollback cost

A revert of one commit. No migration, data or agent repair.

## Conclusion

A text-only change that removes the purchase dependency from the exception and states the loss risk openly. It needs the operator's approving review because the wording is new.

## Second-pass review

**Reviewer:** GPT-6 Astra
**Independent read of the artifact: concur**

Round 2 returned YES, 0 must-fix, after the loss-debt sentence was corrected. Full record: `docs/specs/reports/amendment6-owned-custody-review-2026-11-06.md`.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This replaces an unmerged draft, not a shipped text.

## Counterpart

Constitution counterpart is none: Amendment 6 is scoped to the 1.x Conversations hierarchy, which the 2.0 rule book does not have.
