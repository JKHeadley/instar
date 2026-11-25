---
title: Owner spending permission slips and standing budgets
slug: owner-spending-permission-slips
status: draft
tier: 2
---

# Owner spending permission slips and standing budgets

## Starting decisions

The first owner decision combines money-layer enablement and one standing $50 USD daily discretionary budget. The phone must show the exact existing rendered enable plan, the aggregate daily ceiling, each approved door and its cap, the reset timezone, review or expiry date, and where to revoke it. Resolve the per-door amounts, eligible agents and review date before issuing a real slip. Start with an isolated fixture and no billing or production configuration. The earlier $1 test authorization is a separate finite decision and does not become part of the standing grant.

## Owner approval

An agent can request a slip against a server-stored plan. The server obtains the exact rendered text and typed effects from the existing money-layer plan or the existing routing-spend plan, depending on the action. The chat link locates the pending record in Changes to approve. It carries no secret or authority. Reuse the installed owner-approved-actions and trust-request owner-device transport, active owner check, fresh presence signature and receipt recovery. Use a distinct action purpose. Bind the ordered effects, exact rendered UTF-8 digest, grant terms, server origin and spending scope, current owner and device generations, serving writer, pinned money/config revisions, challenge, slip ID and expiry. A changed effect requires a fresh rendering and owner review. Cancellation leaves the plan unapplied. Duplicate submissions return the original outcome.

A dashboard PIN remains a compatibility fallback only through a verified interactive owner channel. A bearer client, local session or readable configuration PIN cannot satisfy the fallback by itself. Keep the new profile unavailable until the fallback and all existing enable, cap, arm, unfreeze and restart entry points share the same authority boundary. Emergency stop can only reduce authority. Restart cannot grant or restore spending authority.

## Applying the first slip

Persist approval and an activation intent before changing effective policy. Activation must compare both predecessor revisions. Stage money enablement and the grant before publishing a single effective generation. If existing configuration and budget storage cannot share a transaction, the spending gate stays closed until the final committed generation and both staged effects agree. A crash can leave a signed decision pending, never an enabled gate with half the policy. Recovery rechecks custody and exact revisions before finishing. The phone receipt distinguishes signed, applied, and pending recovery.

## Grant, passport and ledger

Represent a grant as a signed, versioned standing authorization. The agent passport exposes a reference and scope in its allowed-action projection. Editing or restoring the passport does not create spend authority. Scope includes eligible immutable agent IDs, provider and door/key references, allowed purpose classes, named aggregate, per-door ceilings, reset timezone, validity interval and revocation generation. The existing money protections and org restrictions still apply. Current authority is the intersection of those restrictions and the grant.

At the existing metered admission boundary, resolve the grant and reserve the maximum allowed charge with the existing spend ledger before provider I/O. Count settled charges and open reservations against the same total across the fleet. Compare and reserve atomically using exact integer units. Record call ID, grant/version, actor, purpose, card or typed reason when no card applies, door, amount, and settlement status. Retries with the same operation resolve the existing record. An ambiguous provider outcome retains the reservation until reconciled. An unpriced operation or unavailable ledger refuses. Revocation stops new reservations and preserves settlement for attempts already admitted.

An over-budget eligible request produces a deduplicated exact bounded slip proposal for owner review, without retrying the charge. An explicit refusal remains a refusal. Spend shows reserved, settled and remaining amounts with reset time and freshness. Needs-you shows a deduplicated read-only nearing-cap item per grant period. Missing totals show unavailable. They never show zero by inference.

## Multi-machine posture

One authoritative spending holder owns grant activation and reservations. Route fleet writes to it using the existing authenticated holder route. Use the existing fencing and durable ledger transfer protocols only after they prove continuity of grant state, reservations, revocations and idempotency keys. A stale or unreachable holder cannot make local fallback reservations. The passport and Spend views project the authoritative result and show incomplete or stale state explicitly. No provider secret crosses a holder boundary in this protocol.

## Decision points touched

- Invariant. Exact owner proof, active device, expiry, holder and revision checks bind consent to the displayed plan.
- Invariant. Activation publishes a single usable generation only after both effects agree.
- Invariant. Admission and settlement enforce aggregate and door ceilings atomically and retain ambiguous holds.
- Invariant. Passport and dashboard projections cannot create authority.
- Judgment-candidate. Agents may draft purpose text or propose a finite exception. The exact scope and maximum charge are enforced by the typed plan, with owner signature as the decision and refusal as the fallback.

## Dark acceptance

Prove exact rendered-byte and body binding, wrong device/owner/origin, stale revisions, replay, wrong action path, PIN-only local refusal, and crash between staged effects. Prove simultaneous cross-door attempts at the last available dollar, day boundary, unknown settlement, revocation, stale holder, holder loss and missing projection. Exercise the existing phone approval surface with synthetic charges and verify no billing is possible. Live issuance waits for reviewed authority, activation, ledger and installed phone behavior.
