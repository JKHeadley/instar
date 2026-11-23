# Side-Effects Review — Bounded Quoted-Reply Design

**Version / slug:** quoted-replies-bounded-design
**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewer:** quote_bounded_review; final result recorded in the bounded decision report.

## Summary of the change

Tier 1 documentation-only correction to an unimplemented Tier 2 feature design. The spec, plain-English companion, boundary inventory and bounded decision record accept old-codec quote loss as a disclosed compatibility limit under Chief handoff 39e3e5f6. They remove the proposed quote-evidence event/index/enrichment machinery. Exact receipt/base binding, masked source errors, existing stop authority and existing request recovery remain required. This commit changes no runtime, configuration, installed files, migration, credential or deployment state. One bounded review covers the changed scope; historical review rounds are not claimed converged.

## Decision-point inventory

This documentation commit has no executable block/allow surface. The future feature design passes through existing signature/access and idempotency invariants, preserves existing stop intent authority, and removes a proposed evidence reconstruction mechanism. It does not authorize new runtime policy.

## 1. Over-block

No block/allow surface in this commit. Future unresolved source lookup remains unavailable rather than certifying a hidden or absent source. Older historical Telegram records without physical namespace will not be eligible solely from current configuration; this limit is disclosed.

## 2. Under-block

No executable surface. Total marker loss cannot be recognized as a quote and may omit its chip. The design says this explicitly and does not promise reconstruction, continuity compliance or fleet graduation. Future implementations still must verify exact base identity and current source access.

## 3. Level-of-abstraction fit

This is a bounded feature-design decision. Existing stores, immutable-base deduplication, signatures, request reservations and MessageSentinel authority remain the implementation seams. No separate proof or recovery service is proposed.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The design preserves exact enumerable identity/access invariants and delegates contextual stop intent to the existing authority. It adds no phrase-list kill rule or new veto ahead of that authority. Reference: [signal vs authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The bounded compatibility decision is explicitly attributed to Chief's assignment; it is not encoded as a new global standard exception.

## 5. Interactions

No executable interaction. The design requires dedicated signed action admission and existing read-quota exemptions so new quote preflight cannot shadow stop handling. Existing missing-append and uncertain-delivery recovery remain authoritative. No duplicate evidence append or replay is introduced. The separate App-link candidate retains its own test and merge custody.

## 6. External surfaces

No external surface changes. No notice source, user action, URL, credential operation, persistent runtime state or installed template is added. The future capability answer is local protocol support, with dark holders unavailable/unknown; this prose commit changes no response. Publishing this documentation branch remains Chief's task.

## 6b. Operator-surface quality

No operator surface is changed in this commit. The proposed fallback uses plain language, "Quoted message unavailable". Native layout, phone-width validation and actual interaction remain future acceptance evidence rather than claims made here.

## 7. Multi-machine posture

Documentation is replicated through the existing repository. No runtime replication changes occur. The proposed feature uses existing appConversations replication for retained optional quote relations; old-codec metadata loss is disclosed, without an all-member acknowledgment or transferable-proof service. This commit emits no notices, holds no runtime state and generates no URLs. It neither certifies continuity nor graduates the feature to fleet-ready.

## Test coverage

No product tests run or required for this prose-only commit. Validate changed Markdown references, documented invariants, staging scope and whitespace; run normal repository commit hooks. The future signed HTTP, lifecycle, recovery and native acceptance fixtures remain unexecuted requirements. Full feature suites stay with throughput.

## 8. Rollback cost

Revert this documentation commit to restore the earlier design text. No persisted state, installed file or external operation requires compensation. Do not deploy a runtime feature from this design-only commit.

## Left behind

Runtime implementation and its three test tiers, merged App-link integration, native acceptance and released app evidence remain on card wc_4d8dd0e0144b636e. Durable transferable proof is excluded from this increment, not silently implemented or declared complete. Forwarding/deletion remain separate owned increments.

## Conclusion

The bounded design removes the proposed proof subsystem while retaining the exact identity, source privacy, stop and recovery requirements. No runtime capability is shipped. Independent review and normal hooks govern this documentation commit.

## Second-pass review

Reviewer: quote_bounded_review. Independent design review concurs; artifact recheck is recorded in the bounded decision report before commit. No test execution is attributed to the reviewer.

## Evidence pointers

See docs/specs/reports/quoted-replies-bounded-decision-20261123.md and the adjacent quoted-replies-boundary-matrix.md. Historical review reports are retained locally without relabeling their non-converged findings.
