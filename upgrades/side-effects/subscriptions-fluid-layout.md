# Side-Effects Review — Subscriptions fluid layout

**Version / slug:** `subscriptions-fluid-layout`
**Date:** `2026-07-23`
**Author:** Instar Agent (instar-codey)

## Summary

Subscriptions now owns a fluid operational layout instead of inheriting Process
Health’s reading-column width. The deprecated Pending logins mirror is removed,
with terminal outcome copy carried by the owning matrix cell.

## Decision-point inventory

- `.subscriptions-root` owns width and responsive gutters.
- `.ph-root` is unchanged.
- The pending-login endpoint remains because it feeds the matrix state model.
- Expired and completed flows render explicit in-cell outcome cards.

## Seven-dimension review

1. **Over-block:** narrow viewports retain access through horizontal matrix
   scrolling; no controls are hidden.
2. **Under-block:** a structural test fails if Subscriptions regains `.ph-root`
   or the deprecated `subPending` mount returns.
3. **Abstraction:** layout belongs to dashboard CSS; terminal presentation
   belongs to the existing matrix renderer.
4. **Signal vs authority:** pending-login and pool reads remain authoritative;
   the UI only projects them.
5. **Interactions:** controller polling and API contracts are unchanged.
6. **External surfaces:** only the Subscriptions dashboard tab changes.
7. **Rollback:** markup/CSS/renderer revert; no data repair.

## Operator surface quality

The matrix uses the available desktop canvas, has mobile gutters, and keeps
terminal feedback next to the action that produced it. No duplicate panel asks
the operator to reconcile two copies of one flow.

## Evidence

Renderer, panel-placement, tab-purpose, and Subscriptions integration tests
cover both the fluid boundary and outcome presentation.
