## What Changed

WS5.2 R7a — the per-account spend ceiling, lease-sliced and owned by the fenced single-writer, so multiple machines sharing one operator account can never collectively over-spend its quota (bounded by sum-of-leases, never N×ceiling — even under partition and across a lease-holder failover). New module `src/core/AccountFollowMeSpendSlice.ts` (pure/injectable): `SliceIssuer` (holder-side; refuses unless it holds the live fenced lease; delegates the sum-of-leases ceiling to the durable PR1 grant-ledger; epoch-stamps every slice), `SliceRenewalControl` (requester-side rate-cap + exponential backoff + per-(account,machine) coalescing + a P19 breaker that fails a machine closed to its OWN account when the holder is slow/partitioned — so the renewal RPC rate is O(per-account-cap), not O(N)), and `decideAccountUse` (the pure selection-time check — a borrowed account is used ONLY for a live, current-epoch, unexpired, positive-remaining slice; every uncertainty falls back to the machine's own account). A new operator-mandate-gated `slice-renew` mesh verb (its own deny-by-default RBAC case). The `AnthropicSubscriptionRouter` gains an optional consult hook (subscription-path only). Config knobs under `multiMachine.accountFollowMe.spendSlice`. Dark behind `multiMachine.accountFollowMe`.

**Scope (honest):** this delivers the spend-ceiling MECHANISM + the consultation; the router currently surfaces the decision to observability. The pool's account selection actually choosing own-vs-borrowed based on it is the enforcement integration that requires the (not-yet-live) borrowed-account-in-pool concept — so the consultation is inert today by construction (nothing is borrowed yet), leaving no reachable over-spend path unguarded. The enforcement wiring lands with that selection layer.

## Evidence

- 59+ tests across `account-followme-spend-slice` (fenced issuance, non-holder refusal, sum-of-leases/Nth-VM refusal, failover re-derivation with no double-allocation, coalescing, rate-cap+backoff, refusal-vs-failure breaker distinction, breaker open/cooldown/reset, all `decideAccountUse` branches), `MeshRpc` (slice-renew deny-by-default RBAC: unwired/rogue/mandated), and `anthropic-subscription-router` (unwired byte-identical, consult on subscription paths only). `tsc --noEmit` clean. Dark-gate lint golden-map updated for the new config block (24/24).
- Side-effects review + mandatory independent second-pass security review (concurred on all 7 audit points: sum-of-leases bound, failover no-double-allocation, fail-closed-to-own everywhere, deny-by-default RBAC, O(per-account-cap) control plane, dark-by-default, no fail-open).
- Spec: `docs/specs/ws52-account-follow-me-security.md` R7a/R7/S5 (converged, approved).

## What to Tell Your User

Nothing to do — this ships off by default. It's the safety cap that lets several of your machines share one subscription account without them collectively blowing past that account's quota: each machine gets a metered slice of the account's allowance from one coordinating machine, and if it can't reach that coordinator it quietly uses its own account instead of overspending the shared one.

## Summary of New Capabilities

Cross-machine per-account spend ceiling (dark): lease-sliced sub-budgets issued by the fenced single-writer, bounded by sum-of-leases under partition + failover, with an operator-mandate-gated renewal mesh verb and fail-closed-to-own-account on every uncertainty. No user-facing surface is live in this release.
