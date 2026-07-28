---
title: "Subscriptions fluid layout and mirror removal"
slug: "subscriptions-fluid-layout"
author: "Instar Agent (instar-codey)"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Justin-directed operator escalation via Echo dispatch, 2026-07-23"
review-convergence: "2026-07-23T18:25:00Z"
review-iterations: 1
review-completed-at: "2026-07-23T18:25:00Z"
cross-model-review: "Echo first-hand browser diagnosis plus Codex boundary review"
eli16-overview: "subscriptions-fluid-layout.eli16.md"
single-run-completable: true
---

# Subscriptions fluid layout and mirror removal

## Problem

The Subscriptions tab borrowed the Process Health reading-column class. At a
2560px viewport, its operational matrix was constrained to 760px and rendered
at roughly 27% width. The tab also retained a Pending logins section after the
complete sign-in flow had moved into each account-machine grid cell.

## Contract

1. Subscriptions owns a fluid, full-grid container with responsive gutters.
2. The Process Health `.ph-root` reading measure remains unchanged.
3. The account-machine matrix uses available width at desktop sizes and remains
   reachable through bounded horizontal scrolling on narrow mobile screens.
4. Delete the Pending logins section from the dashboard markup and controller
   mounts. Keep the pending-login API because the grid consumes it as state.
5. Render explicit “Done” and “Didn’t finish” outcome cards in the owning grid
   cell, including Retry for an expired flow.
6. Structural tests pin the fluid-container boundary and deprecated-section
   deletion.

## Rollback

Revert the Subscriptions-specific container and restore the former section. No
stored state or API migration is involved.
