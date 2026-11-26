# Side-Effects Review — Work Board approval writer checkpoint

**Version / slug:** work-board-approval-writer-wip
**Date:** 2026-11-24
**Author:** Echo
**Second-pass reviewer:** independent focused implementation reviewer

## Summary of the change

Tier 2 project. This work-in-progress checkpoint adds the core compare-and-set and exact-receipt component, focused tests, and the reviewed first-slice spec. The two focused design passes resolved the selection of a current writer. This commit's work is limited to the component interface and its implementation.

## Decision-point inventory

- Current writer — add core proof comparison for the epoch, owner generation and writer incarnation.
- Approval generation — add synchronous comparison of the displayed card and policy versions, followed by an exact append request.
- Applied receipt — add exact durable event verification and attribution.

## 1. Over-block

An exact receipt unavailable after a journal timeout returns unresolved. Once exact durable evidence is available, the same request can retrieve its receipt. A policy revision invalidates the reviewed approval generation even when the card text looks the same.

## 2. Under-block

Production safety depends on ports that enforce the pinned writer proof, authoritative synchronous append and exact durable readback. This checkpoint adds no production port or route and has no activation surface.

## 3. Level-of-abstraction fit

This component consumes authoritative proof and journal evidence. The production adapter must enforce the same pinned epoch before append and when projecting a durable event.

## 4. Signal vs authority compliance

[Signal vs Authority](../../docs/signal-vs-authority.md). No brittle detector holds blocking authority. Exact enrolled owner and writer identities, immutable revisions and durable records define the enumerable compare-and-set domain.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. An exact event or revision either matches the authenticated record or it does not.

## 5. Interactions

- **Shadowing:** no runtime route calls this component at this checkpoint.
- **Double-fire:** matching concurrent requests share a pending generation and query the same exact receipt.
- **Races:** the eventual production append port owns the atomic reservation, and the journal port owns the distinction between known missing and unknown.
- **Feedback loops:** no existing pickup or projection is driven from the checkpoint.

## 6. External surfaces

No runtime route, client or migration change in this checkpoint. It must stay out of a release until production composition and the signed slip flow are verified.

## Verification

Six focused unit checks exercised both ordinary-versus-slip orders, same-text revision change, writer loss, uncertain durability and caller mutation while waiting for the journal. These checks use a controlled port and do not establish production wiring or live approval.

## Independent second pass

The reviewer concurred after the writer was changed to freeze the proof, version, request and event at entry. The regression checks that caller mutation cannot change the reserved event or its attribution. Concurrence covers the checkpoint only.
