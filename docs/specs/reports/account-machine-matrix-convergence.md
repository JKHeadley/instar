# Convergence Report — Account × Machine matrix

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex, gpt-5.5) ran and succeeded on every round (4 rounds), alongside a combined internal panel (security + adversarial + decision-completeness + lessons). The panel caught the one material flaw; codex drove the operational-precision refinements.

## ELI10 Overview

When the agent runs on more than one machine, each machine signs into your subscription accounts separately (the ToS-safe way — nothing copied). There was no good way to do that on demand: the dashboard only offered to add an account when its load-balancer felt like it, so adding your accounts to the Mac Mini meant a clunky chat dance (a DM'd link, the code pasted back in chat). This builds the grid the operator proposed: accounts down the side, machines across the top, each cell a ✓ (active there) or a "Set up" button. Tapping a cell runs the whole sign-in in the dashboard and flips the cell to ✓ when done — at-a-glance "who's active where," auth never leaving the dashboard. It reuses the code-paste-back plumbing shipped earlier the same day; the only new backend is a thin, PIN-gated "start this cell" action.

## Original vs Converged

The first draft got the UX right but the AUTHORIZATION wrong. It claimed "Set up" needed no mandate because the operator's dashboard is Bearer-authed. The internal panel caught that this was unsound: the AGENT also holds the Bearer token, so a Bearer-only start route would let any agent session start a cross-machine account login with no operator present — re-creating the exact agent-acts-as-operator hole that the PIN gate on `issue-for-machine` exists to close (Know Your Principal). Converged design: the "Set up" route is PIN-gated (operator presence) and drives the EXISTING PIN-gated mandate-issuance + mandate-gated enroll-start chain — the PIN gate is preserved end-to-end, never bypassed; the PIN is collected as an inline tap on the cell. Subsequent rounds sharpened: S7 gates the ADD not the START (it's not a substitute for the PIN); offline machines render machine-level offline only (no fabricated per-account "last known" — that data doesn't exist for a dark peer); a strict `(accountId, machineId)` pending-login invariant + concrete `loginId` in the submit; idempotent retry that reuses an existing pending login rather than stacking mandates; URL opens in the operator's browser (url-code-paste only, no local-callback flows); PIN-caching explicitly out of scope.

## Iteration Summary

| Iteration | Reviewer(s) | Verdict | Material | Changes |
|-----------|-------------|---------|----------|---------|
| 1 | codex; internal panel | codex MINOR; **panel: 2 material** | FD4 Bearer-only unsound (PIN required); S7-overclaim | PIN-gated start-cell; S7-gates-add-not-start; +account-key/url-in-browser/cell-integrity/held-source/can't-resolve FDs |
| 2 | codex | MINOR | 0 new (refinements) | url-code-paste-only precondition; last-known-offline; PIN scope/TTL/single-use; pending-logins source; rejected batch-model |
| 3 | codex | MINOR | 0 new | simplified to machine-level offline (no fake last-known); (accountId,machineId) in-progress correlation; start-cell partial-failure/idempotency; PIN-caching deferred out of scope |
| 4 | codex | MINOR | 0 new (stable) | idempotent reuse-not-restack ordering; pending-login uniqueness invariant + loginId in submit |

## Full Findings Catalog (by theme)

- **Authorization (panel, MATERIAL)** → start-cell PIN-gated, drives the shipped PIN→mandate→enroll-start chain; Bearer-only rejected (agent shares Bearer). RESOLVED.
- **S7 overclaim (panel, MATERIAL)** → S7 gates the ADD (wrong-account → held, confirmed), not the START; start auth = PIN. RESOLVED.
- **Account key / email identity (codex #1)** → keyed by pool `id`, displayed by email, pool's identity model. RESOLVED.
- **URL/browser locality (codex #2/#1)** → URL opens in operator's browser; url-code-paste-only precondition; CLI pane stays on target. RESOLVED.
- **Cell integrity / offline vs empty (panel + codex)** → `(accountId, machineId)` pivot; ✓ only from reachable machines; dark peer = machine-level offline, no fabricated ✓; can't-resolve cell state. RESOLVED.
- **Held-state source (codex #5)** → client-side last-attempt transient (the `held` response for that cell), not a fabricated durable state. RESOLVED.
- **In-progress correlation + pending-login uniqueness (codex r3/r4)** → from `pending-logins?scope=pool`, correlate on `(login.id===accountId, machineId)`; one-pending-per-pair invariant; `loginId` in submit. RESOLVED.
- **PIN scope/TTL/caching (codex r2/r3)** → one scoped single-use mandate per tap, existing TTL; PIN-caching out of scope for v1. RESOLVED.
- **Partial-failure / idempotency (codex r3/r4)** → idempotent; unused mandate lapses by TTL; retry reuses an existing valid pending login, never stacks. RESOLVED.
- **Batch/job model (codex r2 #5)** → rejected-alternative documented (transient pending logins suffice at this scale). RESOLVED.

## Convergence verdict

**Converged at iteration 4.** The single material flaw (Bearer-only authorization) was caught by the internal panel in round 1 and fixed (PIN-gated, reusing the shipped PIN→mandate→enroll-start chain); rounds 2–4 produced only operational-precision refinements with no new material design flaw, stabilizing by round 4. `## Open questions` is empty. Ready for approval + build. The build is largely a frontend grid over shipped routes (`?scope=pool`, `pending-logins?scope=pool`, `submit-code`) plus one new PIN-gated `start-cell` orchestrator.
