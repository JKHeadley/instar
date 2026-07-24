# Side-Effects Review — Dashboard Throughput

**Version / slug:** `dashboard-throughput`  
**Date:** 2026-07-24  
**Author:** Instar-codey  
**Second-pass reviewer:** not required

## Summary of the change

Adds a read-only dashboard tab and server route that derive daily pull-request delivery metrics from bounded, structured GitHub CLI responses. The browser renders the server-owned contract and never writes GitHub or Instar state.

## Decision-point inventory

No behavioral decision point. The only rejection is structural API validation limiting windows to 7, 14, or 30 days.

## 1. Over-block

Malformed or unsupported window values receive 400. Valid documented windows are all accepted; there is no message or action block surface.

## 2. Under-block

GitHub outages and malformed responses return 503 rather than plausible zero data. The metric remains limited by GitHub's bounded review list (30 reviews per PR) and 400 merged PR list.

## 3. Level-of-abstraction fit

Aggregation belongs on the server because it is the canonical contract and can safely execute structured `gh` calls. The browser only selects and plots.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

These are observational signals only and authorize no action.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. The published composite is descriptive arithmetic with returned weights, not an authority.

## 5. Interactions

The route uses authenticated dashboard middleware already owned by AgentServer. A one-minute private cache header reduces repeated reads. It shares no mutable state, so there is no double-fire, race, or feedback loop.

## 6. External surfaces

The external read surface is GitHub pull-request metadata. The user-visible dashboard adds no operator action and no persistent state.

## 6b. Operator-surface quality

1. The primary content—the index and charts—is visible immediately.
2. Labels are plain language; no hashes, JSON, or internal identifiers are primary content.
3. There are no destructive actions.
4. Selectors and all seven charts were browser-verified at 2560px and 390px; phone layout is one column with no horizontal overflow.

## 7. Multi-machine posture

**Proxied-on-read:** each machine computes the same repository-global GitHub view on request. There is no durable state to replicate, no notice requiring one-voice gating, and no generated URL.

## 8. Rollback cost

Pure code rollback: revert the route registration and tab, then ship a patch. No data migration or agent-state repair is required.

## Conclusion

The review moved all metric and index ownership server-side, made GitHub failure explicit, and kept the dashboard fluid and read-only. Clear to ship.

## Second-pass review

Not required: no messaging, lifecycle, dispatch, context-recovery, coherence, trust, sentinel, guard, gate, or watchdog authority changes.

## Evidence pointers

Focused suite: 127 passed, one pre-existing conditional skip. TypeScript and repository invariants pass. Browser captures: `throughput-2560.png` and `throughput-390.png`.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
