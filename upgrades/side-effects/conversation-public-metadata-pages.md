# Conversations public metadata pages

## Scope and approved intent

Prerequisite DATA storage for reviewed conversation-effort-hierarchy-v3 and owned-custody design. Only GraphPublicMetadataPages and its tests are in this checkpoint. No runtime producer, permission verifier, receipt, erasure classification, cloud target or feature flag is enabled. See docs/signal-vs-authority.md: exact saved bytes are not a grant of authority.

## Side effects

1. Storage: explicit per-object total-byte policy; immutable 128 KiB pages and bounded index nodes, root published last. File and containing-directory fsync plus readback are required. Exact retry preserves inodes. This is not filesystem preallocation or a global/concurrent disk quota.
2. Privacy: callers must supply public-schema-verified bytes. The utility cannot establish that arbitrary input is public; it does not exempt this directory from the erasure/copy census. No content keys or private bodies should be passed by future typed producers.
3. Under-block: a hash/descriptor/data handle proves neither owner permission, membership, Native authority nor Source ACK. Partial/range reads are not completed protocol proofs; final whole-set assertCurrent remains required before actuation.
4. Over-block: corruption, missing pages/indexes, changed inode/stamps, links, replaced directories and failed durability barriers refuse the handle/read. There is no permissive old-cache fallback.
5. Memory: byte working set is page bounded; page references/stamps scale with explicit admitted page count. No claim of constant total memory at arbitrary limits or bounded domain proof without typed consumers.
6. Interrupted work: exclusive owned scratch cleanup only; unknown scratch and immutable orphan objects remain visible debt. No TTL cleanup, key destruction or retirement follows publication alone.
7. Compatibility and rollback: additive unused utility. No old signed object is rewritten, no signature format is replaced with a digest, and no history ceiling is reduced. Remove unused callers/code for rollback; retain any durable objects until a separate reviewed disposition proves safety.

## Verification and independent review

Current bounded utility/tail author run21 passed,2 larger cases explicitly filtered/skipped. Directory-fsync and selected-page mutation faults covered; final whole-set mutation refusal preserved. Actual >32 MiB and integrated Source/Transfer/default policy proofs are not claimed. Independent source reviews: review-public-metadata-foundation.md (initial cold directory barrier defect), review-public-metadata-tail.md (fixed), review-public-metadata-range.md (final range delta concurrence). Normal compiler and commit hooks remain required; no gate waiver.

## Independent bounded source and side-effects concurrence

Reviewer: review_graph_checkpoint. Exact foundation source SHA256 `bf372b3914ecdf6bcb542927e2115328f5cec4441d94efa5a086545fed702d17`; test SHA256 `995e1d0adc80abd474558296c40bf1584e12373636ec450d2d0de78d7c5f198f`. Reviewed this side-effects artifact and `upgrades/conversation-public-metadata-pages.eli16.md` against the actual foundation implementation and prior finite reviews. Scoped concurrence for this unused DATA utility and its stated boundaries; no new concrete source blocker found. The original cold page/index-directory fsync defect is corrected; the bounded range contract remains selected-file freshness followed by required whole-set final validation at the consumer boundary.

Clarification to interrupted-work wording: known-shaped immutable orphan pages/indexes are retained and physically inspectable, but `inspectDebt()` does not determine reachability or flag every such orphan as debt. It reports unknown names/scratch/type/link issues; a later census/typed consumer must classify retained known-shaped copies before cleanup or erasure completion. This is not a utility GC/erasure assurance.

The ELI16 correctly describes an internal building block, not enabled Conversations or a permission/durability receipt. The21/2-skipped result is author utility-plus-tail evidence; only foundation source/tests belong to this checkpoint. Typed-tail, its pending getter, live consumers, global quota, large/full-state performance, actuation and deployment acceptance are excluded. No new test, source/protocol/runtime edit or gate override was performed for this documentation concurrence; compiler and normal commit gates remain required. Approval provenance remains the existing reviewed-v3/owned-design record, not a new approval invented by this review.

Additional exact checkpoint evidence: HEAD 0e57bf145 plus only this four-file foundation checkpoint was archived into an isolated build artifact (not a git worktree/release). Normal utility suite15 passed/1 explicitly gated33MiB case skipped, including16.25MiB multi-level stream. The current source utility run separately15/1. These prove data streaming/cold checks, not physical joint quota or domain authority; repeated content deduplicates immutable page storage. An initial command ran in the source cwd rather than the artifact and is preserved as wrong-cwd evidence, never labeled prefix proof.
