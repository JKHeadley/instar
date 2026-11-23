# Side-Effects Review — census row names `telegram-topic-name-record` (CMT-2105)

**Version / slug:** `no-data-loss-on-machine-death-census-amendment`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (documentation only, no runtime surface)

## Summary of the change

Tier 1, documentation only, no runtime surface. One file changed, `docs/specs/no-data-loss-on-machine-death.md` (PR #3530): the §2.2 census row `conversation-names` now names `telegram-topic-name-record` as the carrier of Telegram topic names, and a clearly marked §2.2b "Amendment after convergence (census only)" row records where that record lives, how it replicates and what its loss cost in the Studio outage, as `docs/specs/topic-name-replication.md` (PR #3591) defines. The parent spec defers to that spec by reference for everything about the record. Size: about 10 added lines; no spec review round was run for the amendment (it is marked as added after convergence); one commit attempt. Everything below is "no issue identified" because nothing here executes.

## Decision-point inventory

None. A spec table row gates nothing, blocks nothing, filters nothing. The increment-3 census build will read it; that build has its own spec-driven review.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Right layer: the parent census spec names the carrier and defers the mechanism to the child spec that converged on it, instead of restating the fold and drain rules in a second place that could drift.

## 4. Signal vs authority compliance

Not applicable: no detector and no authority is added or changed.

## 5. Interactions

The row replaces the earlier wording "both are built", which conflicted with the child spec and with the parent's own hub-topics row (`agent-setting` is a new kind, increment 4). No other section references the `conversation-names` row by that wording.

## 6. External surfaces

None. Nothing visible to agents, users or other systems changes until the census build ships under its own review.

## 7. Multi-machine posture (Cross-Machine Coherence)

Documentation only. The row it adds describes a replicated record (WS2 path, carried once per machine); that posture belongs to the child spec and its shipped code, not to this edit.

## 8. Rollback cost

Revert the commit. No data, config or agent state is involved.
