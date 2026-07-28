# Side-Effects Review — WS5.2 R7a: lease-sliced per-account spend ceiling

**Version / slug:** `ws52-account-follow-me-r7a-spend-slice`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `pending (HIGHEST-risk: cross-machine money/quota ceiling under partition + a new operator-mandate-gated mesh verb)`

## Summary of the change

WS5.2 R7a. A per-account spend ceiling, lease-sliced, owned by the fenced single-writer (the `FencedLease` holder), so N machines sharing one operator account can never collectively over-spend its quota — bounded by sum-of-leases, never N×ceiling, even under partition and across lease-holder failover. New module `src/core/AccountFollowMeSpendSlice.ts` (pure/injectable): `SliceIssuer` (holder-side — refuses `not-lease-holder`, stamps the current lease epoch, delegates the sum-of-leases ceiling to the existing durable `AccountFollowMeGrantLedger`); `SliceRenewalControl` (requester-side rate-cap + exponential backoff + per-(account,machine) coalescing + P19 breaker → fail-closed-to-own-account on a slow/partitioned holder); `decideAccountUse` (pure selection-time consultation — borrowed account used ONLY for a live, current-epoch, unexpired, remaining>0 slice; every uncertainty → own account). A new operator-mandate-gated `slice-renew` mesh verb in `MeshRpc.ts` (its own deny-by-default `checkCommandRBAC` case via an injected `authorizeSliceRenew` seam). `AnthropicSubscriptionRouter` gains optional `consultSlice`/`onSliceConsult` hooks invoked only on the subscription-pool selection path (no-op when unwired). Config knobs under `multiMachine.accountFollowMe.spendSlice`. Dark behind `multiMachine.accountFollowMe`; default behavior byte-identical when the hook is unwired/off.

## Decision-point inventory

- `slice-renew` mesh verb RBAC — **add** — deny-by-default; only the operator-mandate-authorized requester (via `authorizeSliceRenew`) may request a slice; absent seam → deny.
- `SliceIssuer.issueForRenew` — **add** — only the live `FencedLease` holder issues; ceiling enforced by the durable ledger; epoch-stamped.
- `decideAccountUse` — **add** — selection-time: borrowed vs own account; fail-closed-to-own on every uncertainty.
- `SliceRenewalControl` — **add** — the control-plane bound (rate-cap/coalesce/breaker) → O(per-account-cap) renewal RPCs.

---

## 1. Over-block

The conservative direction is intentional: when a slice is unknown/stale/expired/exhausted, or the holder is slow/partitioned, a machine "over-blocks" by falling back to its OWN account rather than using the borrowed one. This is the REQUIRED safe direction (never overspend a borrowed money/quota credential). It cannot wrongly deny the machine's own account (fallback is always available). No legitimate over-block of a healthy borrowed slice (a live current-epoch slice with budget is used).

## 2. Under-block

The ceiling is enforced at slice ISSUANCE (the ledger refuses `outstanding + amount > ceiling`) and at selection (a machine without budget falls back). It does NOT meter per-call token spend WITHIN a slice — a slice is a pre-allocated sub-budget; intra-slice accounting is the slice's granularity (by design — the spec's lease-slice model). A compromised holder could in principle over-issue, but the holder is the fenced single-writer (the same trust root as who-is-awake) and the ledger still caps the durable sum; a non-holder cannot issue at all.

## 3. Level-of-abstraction fit

Correct layers: issuance authority on the FencedLease holder (the existing single-writer), durable accounting in the existing GrantLedger (reused, not rebuilt), the renewal control-plane as a pure injectable state machine, the consultation as a pure function the router calls. The mesh verb sits in MeshRpc with the other commands. No logic duplicated; the ledger's sum-of-leases + epoch-fencing is reused as-is.

## 4. Signal vs authority compliance

The authority here (issue a spend slice) is held by the fenced single-writer + gated by the operator mandate (deny-by-default) — appropriate, not a brittle heuristic. The consultation (`decideAccountUse`) is a deterministic pure function (field checks on a slice), fail-closed. The breaker is a signal (consecutive transport failures → open) that only ever makes a machine MORE conservative (fall back to own account). No brittle blocking authority over user actions. Reference `docs/signal-vs-authority.md`: operator-mandate + fenced-single-writer authority, deny-by-default, is correctly-placed.

## 5. Interactions

Reuses `AccountFollowMeGrantLedger` (PR1) for the durable sum-of-leases bound + epoch-fenced consume — failover re-derivation is "for free" because `SliceIssuer` holds no in-memory slice state (reads the durable store live; a new holder over the same store sees the committed set). The `not-lease-holder` guard prevents a stale ex-holder from issuing during a handoff. The breaker distinguishes grant REFUSALS (`would-exceed-ceiling` — the holder answered; back off but don't trip) from transport FAILURES (trip the breaker) — so a healthy-but-full account doesn't open the breaker. The router hook runs only on the subscription path (never sdk-credit), so it can't perturb SDK routing.

## 6. External surfaces

One new mesh verb (`slice-renew`), deny-by-default, dark behind the flag. New config block (`spendSlice`, additive, defaulted). No new HTTP route. When `multiMachine.accountFollowMe` is off (or the router hook unwired — the default), behavior is byte-identical: the consult hook is never invoked. Other agents see the new verb only if they're mandated peers in a follow-me pool.

## 7. Multi-machine posture (Cross-Machine Coherence)

This IS a multi-machine coherence mechanism by construction. The single source of truth is the fenced-lease holder + the durable grant-ledger; slices are epoch-stamped so a failover voids stale-epoch slices and the new holder re-derives the outstanding set from the durable store before issuing — the sum-of-leases bound holds across the handoff with no double-allocation. Under partition, a VM that can't reach the holder fails closed to its own account (bounded, never unbounded overshoot). The renewal control plane is O(per-account-cap), not O(N), so it can't storm the holder. A single-machine agent is a no-op (no peers, the flag is off).

## 8. Rollback cost

Low. Entirely dark behind `multiMachine.accountFollowMe` + the unwired router hook → no live effect by default. New module + additive config + one mesh verb. Revert is a single-commit back-out; no migration, no persisted-schema change (the slice records live in the existing grant-ledger store, which already shipped in PR1).

---

## Scope note (honest, not a hidden deferral)

R7a delivers the spend-ceiling MECHANISM end-to-end: the fenced-single-writer slice issuer (ledger-backed sum-of-leases ceiling + epoch-fenced failover re-derivation), the requester-side renewal control plane (rate-cap + coalescing + P19 breaker → O(per-account-cap)), the operator-mandate-gated `slice-renew` mesh verb, the pure `decideAccountUse` consultation (fail-closed-to-own on every uncertainty), AND the router hook that invokes it. The router currently SURFACES the decision to observability (`onSliceConsult`); the pool's account-selection actually CHOOSING own-vs-borrowed based on that decision is the enforcement integration that belongs to — and requires — the borrowed-account-in-pool concept, which is not yet live (enrollment adds accounts as normal local accounts; nothing is marked `isBorrowedAccount` yet). So the consultation is inert today by construction (every account → `own`), meaning there is NO reachable over-spend path that this layer leaves unguarded. This is the correct decomposition for a dark mechanism, not a deferral of reachable behavior; the enforcement wiring lands with the borrowed-account selection layer.

## Second-pass review

**Concur with the review** (security substance) — the independent reviewer verified all 7 points directly:
1. **Sum-of-leases bound holds** — `SliceIssuer.issueForRenew` delegates to the ledger's `issue()` (re-reads outstanding from the durable store, refuses `outstanding + amount > ceiling`); `SliceIssuer` holds ZERO in-memory accounting state; the `GrantStore` is synchronous so no interleave past the ceiling (structural invariant: keep the store synchronous). `outstandingFor` conservatively over-counts (safe direction).
2. **Failover / no double-allocation** — `holdsLease()` blocks a stale ex-holder; the new holder re-derives from the same durable store; epoch-stamped slices are void on stale epoch. Tested.
3. **Fail-closed-to-own on every uncertainty** — `decideAccountUse` returns `own` for flag-off / not-borrowed / no-slice / stale-epoch / expired / `!(remaining>0)` (0, negative, NaN). `borrowed` only via a live current-epoch unexpired positive-remaining slice.
4. **slice-renew RBAC deny-by-default** — own `checkCommandRBAC` case; `authorizeSliceRenew?.(...) ?? false` → absent seam OR false → 403; not the any-peer read class.
5. **Control plane O(per-account-cap)** — coalescing + rate-cap + exponential backoff + P19 breaker on transport `failed` only; grant `refused` (would-exceed-ceiling) backs off but does NOT trip the breaker.
6. **Dark by default / byte-identical when off** — `consultSlice` no-ops when unwired; subscription-path only, never sdk-credit. (Observe-only in this layer — see Scope note above.)
7. **No fail-open** — no catch/`||true`/default-allow; every positive outcome follows explicit guards.

The reviewer's one CONCERN was the dark-gate lint golden-map line shift from the new `spendSlice` config block — **FIXED**: the 7 shifted entries updated to the attributor's values (924/949/978/1147/1269/1314/1339); `lint-dev-agent-dark-gate.test.ts` now 24/24 green. tsc EXIT=0; the 3 R7a suites 59 passed.
