# Side-Effects Review — Store Content Write Plans

**Slug:** local-history-store-content-plans
**Date:** 2026-11-23
**Author:** echo
**Risk:** Tier2, private durable filesystem mutations and recovery.
**Second-pass reviewer:** channel_side_effects, independent source/artifact review; concur.

## Summary and build location

Adds writer-scoped opaque plans for exact serialized conversation/attachment content and whole-manifest replacement. Reuses the actual legacy conversation serializer/executor and temporary-file writer. No apply child, owner grant, real ledger reservation, source-claim accounting or app action is enabled. Branch echo/local-history-store-budget-143810 in isolated same-named worktree, parent a78431b073b3662f555ca98af7bf5231da1e1abd, package1.3.1984. GitHub publication remains with Chief. Approved driving spec and ELI16: local-history-native-contract at the committed parent. This change touches its store-enforced budgeting requirement, not the separately unapproved routing amendment or denied SQL retirement. Original parent external/conformance limitations remain disclosed.

Size: one production module, one new focused regression plus component/awareness/upgrade/review documents; approximately250 production lines and a comparable regression. Three independent source reviewers checked correctness, security and architecture. They found temporary-publication/disposal and descriptor-acquisition failure gaps; these are fixed with direct neighboring tests. No new spec-convergence run is claimed for this implementation of the approved store contract. Normal commit/gate attempts: the first passed all55 lint steps and the real Tier2 gate. A second normal attempt records this final audit-metadata clarification; no bypass.

## Decision points and must-haves

Actual writer lease and active local source claim; exact private plan identity and revision; safe-integer content ceiling; unchanged generated destination state; one-use consumption before attempted mutation; actual descriptor verification; owned temporary disposal evidence. These are protocol, durable provenance and resource invariants, not inferred intent or copy authority. The public descriptor carries only kind/contentBytes. Existing write APIs share serializer/executor so the approved bytes do not drift from the actual writes. Independent copies of a token, a new writer acquisition and future caller changes cannot revive an old plan.

## 1. Over-block

A changed destination, another store mutation, replacement plan, underfunded attempt or writer exit invalidates the token. A failed attempt requires a fresh plan even if no file grew. All are conservative reuse boundaries; source/selection consent is not repeated here. A hard-link attachment remains unavailable to replan while an owned temporary link is unresolved. The exact cleanup handle removes only that temporary link after the filesystem allows it; the published attachment is preserved. Unverified creation intentionally refuses automatic deletion. Existing export/manual callers still use legacy methods and gain no new content-ceiling requirement.

## 2. Under-block

The numeric ceiling is not proof of disk capacity, owner admission, source identity, a signed parent permit or user consent. Fixed future apply must use planned writes exclusively and independently reserve claims, SQLite, filesystem metadata/allocation and same-volume peak costs. Existing legacy APIs do not acquire a content budget. Full import/UI remains false. Output plans are consumed before validation/write attempts; failures may have appended real bytes, created private temporaries or published attachments. Parent accounting must remain until actual cleanup/reconciliation and worker exit. A prefix write and a full write followed by lost completion are separately tested.

## 3. Abstraction fit

One pending plan per store uses the actual writer Database lease and mutation revision, and is invalidated by all related mutators. Encoded private strings remain inside the isolated writer; no main-server proposal hydration or portable approval is introduced. The plan records content costs and expected file state; execution rechecks path state and the actual opened append inode. Missing append creation is exclusive and no-follow. Manifest cost includes its complete temporary replacement; first attachment publication transfers one temporary content inode through an atomic link. Existing export/manual paths share the same serialization and temporary ownership functions.

## 4. Signal vs authority

Reviewed against docs/signal-vs-authority.md. Exact object identity, safe integers, cryptographic provenance already enforced by the existing source claim, real writer transaction state, file identity and one-use consumption are hard-invariant exceptions. No semantic classifier or advisory metric blocks a person. Content ceilings implement a future trusted permit's size, never supply that permit. No user-facing decision or new attention loop is added.

## 5. Interactions and ownership

Temporary files use exclusive creation. Identity capture occurs inside descriptor-protected try/finally. On ordinary failure, owned temporary disposal runs through SafeFsExecutor after exact dev/inode/owner comparison. A failed disposal returns ImportWriteCleanupPending with a generated basename, conservative retained-content bytes and verified-inode/unresolved-creation state. Disposal authority is held in a module-private WeakMap; forging an error cannot delete a path. If identity capture failed, the descriptor still closes, the artifact remains charged and disposal refuses without proof. Exact inode comparisons use BigInt. A failed temporary unlink after actual attachment publication retains an actionable handle; removing its temporary link restores nlink1 and permits a fresh writer to reconcile without replacing content.

Serialization may invoke caller getters or toJSON. The captured writer/revision must remain unchanged before publishing a plan. The future parser supplies validated values, but the lower-level store also directly tests this reentrancy boundary. Existing source claim checks run again before conversation execution. No SQL cleanup/row retirement or safety denial is touched.

## 6. External surfaces and agent awareness

Adds only internal store APIs, no HTTP route, config, migration, watcher or app UI. Awareness content names exact uses and limitations through the normal data/awareness update path for new and existing agents; no duplicate template edits. Temporary failure messages are finite; error metadata contains generated artifact identity and no selected text. No new logging exposes selected source paths or message content. SafeFsExecutor records the generated temporary path as existing filesystem-operation audit metadata. Existing history HTTP behavior is exercised through its real router and AgentServer construction path, independently of the dormant API.

## 7. Multi-machine posture

No new durable library surface or replication policy. A plan is ephemeral capability metadata within one actual writer lease; it cannot transfer approval to a sibling process/machine or substitute a destination. The unified selected-target journey and credential custody remain the parent contract's responsibility. No new machine-local knowledge island or operator-ratified exception is introduced.

## 8. Rollback cost

Revert the new store planning methods and associated regression/awareness/documents together. Existing data/schema/claims need no migration and are not removed. Reverting does not dispose a previously unresolved temporary file: retain its charge/evidence and require actual ownership proof. Preserve published content and avoid treating an exception as a no-copy outcome. Full source removal must respect any future caller dependency; none is connected in this checkpoint.

## Evidence and limits

53 focused real-store/source-claim checks pass (16 new and37 existing). After the final source fixes,46 export/parser/store compatibility checks,11 actual imported-history HTTP integration checks and1 existing AgentServer-wiring export lifecycle check pass. TypeScript noEmit passes. Earlier13 search/privacy checks also passed, but are not counted again as new final-source evidence. Existing E2E uses AgentServer construction/mount, not a newly listening installation; no new planned-API production wiring or installed-native journey is claimed. New source review concurrence: metadata_security, metadata_correctness and capture_architecture, all read-only and not independent attestations of test counts.

Full frozen-head verification will be requested through Chief/throughput after the normal commit. No complete suite, publication, merge, release or complete import claim. Routing amendment and denied bookkeeping retirement remain unresolved independently.

## Second-pass review

Concur with the review. I independently read the complete production diff, the new real-store regression, component documentation, awareness and upgrade fragment, the parent spec frontmatter and `docs/signal-vs-authority.md`. The artifact accurately separates exact content planning from real capacity reservation, durable claim/metadata accounting and permission to copy. Writer/lease/revision identity, one-use consumption, opened-inode validation and exact temporary-disposal ownership are hard invariants rather than semantic judgment. Shared legacy serialization/execution and attachment-publication behavior are disclosed; the tests cover neighboring partial-write, collision, lost-completion, failed-unlink and initial-descriptor-identity failures. Ephemeral plans grant no cross-process or cross-machine authority, and rollback must preserve unresolved residue and published bytes. No new route, apply worker or UI wiring is claimed, and the inherited approval/report limitations and separately unresolved amendment remain explicit. No new concrete blocker found. This is source-only concurrence; I ran no tests/builds and do not independently attest the reported pass counts.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This component manages actual private store write resources rather than spawning, dispatching or restarting agents. Reviewed neighboring failures cover publication collision, failed owned unlink, initial identity failure, actual prefix append, lost completion and stale descriptor reuse. No denial is bypassed.
