# Revoked machines stay revoked — Plain-English Overview

> The one-line version: you'd kicked the stale Mac Mini off the mesh (revoked it), but after an update it quietly came back and started chattering again — because the code that re-adds a machine to the roster just stamped it "active" without noticing it had been revoked. Now re-adding a revoked machine is refused; it stays kicked off until you explicitly let it back in.

## The problem in one breath

When a machine joins (or re-joins, or re-registers itself after an update), the registry code wrote its entry as "active." If that machine had previously been **revoked**, the re-write silently flipped it back to active — so a machine you'd deliberately removed resurrected itself on the next update and resumed sending mesh/live-tail traffic.

## What already exists

- **The machine registry** — the roster of machines in the mesh, each with a status (active / revoked) and, when revoked, who revoked it and why.
- **Revoke** — removes a machine from the mesh (`revokeMachine`).
- **Sticky-merge** — when two copies of the registry are merged (e.g. after a git sync conflict), a revocation on either side already wins, so a merge can't un-revoke a machine. That door was already closed.

## What this adds

It closes the **other** door: the direct re-register. `registerMachine` now checks, before writing, whether the machine already has a revoked entry. If it does, it refuses — it logs a clear warning and leaves the revoked entry exactly as it was, instead of stamping it "active." So a revoked machine that boots up after an update and tries to re-register itself stays revoked.

## The safeguards

**Normal joins are untouched.** The refusal only triggers for an existing *revoked* entry. A brand-new machine joins normally; an already-active machine re-registering (a routine role/nickname/last-seen refresh) is unaffected.

**You can still bring a machine back.** Revocation is sticky against *silent* resurrection, not against a deliberate decision: the explicit un-revoke path clears the revoked state, after which the machine registers normally. So intended restoration still works — only the accidental comeback is blocked.

**The refusal is loud.** It logs a warning naming the machine, so if a revoked machine keeps trying to re-join you can see it (rather than it silently succeeding).

## What ships when

One PR, one guard in one file plus its tests. Multi-machine only — a single-machine agent never hits this path. No new API, config, or migration.

## Evidence

`machine-identity.test.ts` (new cases): a revoked machine, re-registered, stays revoked (its status, role, and revocation metadata are preserved — not resurrected); a brand-new machine still registers active. 75 machine-identity unit tests green; `tsc --noEmit` clean. causalAutopsy: latent — `registerMachine` has always rebuilt the entry with `status: 'active'`; it only mattered once a revoked machine re-registered after an update, which is exactly the 2026-06-07 Mac Mini case. The merge path was made sticky earlier; this is the symmetric fix for the direct-register path.
