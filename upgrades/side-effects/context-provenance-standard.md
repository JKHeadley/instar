# Side-Effects Review — Source Provenance Documentation

**Version / slug:** context-provenance-standard
**Date:** 2026-11-23
**Author:** Instar Agent (echo)
**Second-pass reviewer:** Parent agent, separate session in the same model family; concurred after a full read. This is not a cross-model qualification.

## Summary of the change

Tier 1, documentation only: one provenance standard, its plain-language overview, and this impact record. No runtime surface. One independent document review; no model calls or private evaluation runs. Change size: three documentation files, 136 added lines before generated trace and decision records.

## Decision-point inventory

No runtime decision points are added, modified or removed. The document describes evidence review dispositions without installing an authority or blocker.

## 1. Over-block

No block/allow surface — over-block not applicable. The document warns against excluding an entire source just because one claim lacks support.

## 2. Under-block

No block/allow surface — under-block not applicable. Documentation cannot enforce custody or prevent a reader from overstating authentication; that limitation is explicit.

## 3. Level-of-abstraction fit

Host-side design guidance is appropriate for this card. No schema, validator, model prompt or runtime implementation is claimed.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). This change has no block/allow surface. Structural evidence observations remain distinct from judgments about authority and meaning.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The standard leaves ambiguous semantic dispositions to a reviewer with relevant evidence.

## 5. Interactions

No shadowing, double-fire, races or feedback loops: no executable path or shared state changes. The offline validator is owned by a separate card and is not edited here.

## 6. External surfaces

Public documentation only. No external API calls, messages, user data, installed files, persistent state or operator-facing actions. There are no timing dependencies or rollout requirements.

## 6b. Operator-surface quality

No operator-facing actions or dashboard surfaces.

## 7. Multi-machine posture

Documentation is replicated with git. The design explicitly treats raw source custody as machine-local unless a recorded transfer makes evidence available elsewhere. A second copy is not an independent capture. No live replication behavior changes.

## 8. Rollback cost

Revert this documentation commit. No migrations, state repair or agent rollout.

## Class-level closure

No agent-authored-artifact defect — not applicable. This card defines a design standard rather than claiming a runtime guard or closing a defect class.

## Validation

The parent independently reviewed the full draft and found no design blockers. Its requested clarification now limits normalization to evaluation views and preserves mandatory original operator wording. Validation: git diff --check passed and a direct document check confirmed all eight evidence dimensions, the offline-authentication boundary and the verbatim-operator-wording rule. The overview contains 1,781 characters. The installed commit gate runs during commit; its outcome is reported with the resulting commit. No runtime tests are applicable because no executable code changes. No private case was read or evaluation run claimed. The first checkout disappeared during provisioning for an unknown reason; both setup processes were stopped, repair reported an invalid path, and a replacement registered worktree was created from the same pinned base. Draft files were preserved outside the failed checkout. No cleanup policy changed.
