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

## Review decisions for the first slice

Use the enrolled phone path for both effects of the combined slip. Keep the legacy PIN path only for existing compatibility actions outside the signed-grant profile. It cannot stage or publish that profile. Adding a PIN fallback there requires an independently authenticated interactive owner session and an exact one-use challenge. Until that requirement is proven, the signed profile has no PIN effect authority.

Preserve the existing enable text about arming no doors. If a proposed plan would arm any door, add a separate, explicit server-rendered effect for each such door and show its previous and new posture. The first proof enables the money layer and records the budget without arming a provider or issuing an external charge. Unlisted doors and unmanaged external charges are outside the grant. Resolve the first real door list from the current cap and designation records and let the owner edit the proposal before one signature.

Reuse the reserve and settlement point in MeteredSpendLedger. The per-key mutex and caps are insufficient on their own. A single holder-fenced booking must check the grant-period aggregate, door cap, key caps, current policy and revocation together before recording dispatch authority. Use integer USD microdollars, round reserves up, and include supported fees and maximum request cost. Refuse routes without an enforceable provider-side bound or with unpriced fees, fallback or currency. Every billable egress must pass this gate. Legacy config, restarted state and an existing enable flag cannot substitute for the effective generation. Existing ceilings remain effective even if the grant would permit more.

Key the accounting period by stable budget family and signed timezone interval. Reissue, revoke, holder change and timezone edits cannot clear current charges or holds. A timezone change applies only after the original period ends and overlapping intervals share existing usage. A reservation pins its charged day, and settlement replaces the estimate on that day. Unknown dispatch or charge stays reserved past normal expiry until the provider receipt reconciler proves the outcome. First release has no automatic holder failover. Any later failover needs both a fence at old provider egress and continuity of charges, holds, revocation, operation identifiers and receipts.

Exhaustion can draft one deduplicated, typed, finite exception for the exact blocked call. A separately signed exception adds a named maximum increment to that period for that call only. It does not bypass original accounting or any hard provider, door or organizational ceiling. The phone shows the denying cap, available balance, incremental maximum, total effect and expiry. The exception binds one operation and one reservation and never retries the blocked charge automatically. Without that signed effect, the daily $50 remains the ceiling. Hard denial, unavailable accounting and unpriced work cannot draft an exception that would bypass those conditions.

Use the existing Spend and Needs-you projections. Reuse the existing upper cap-approach threshold of 80% in SpendAlertEmitters. Show a single nearing-cap item at 80% reserved plus settled per grant period, update it in place as usage changes, and show a distinct exhausted state at the cap. First proof uses test-only projections. The owner receipt has separate signed, pending application, applied, stale/review required and revoked states. A signed pending receipt never tells the owner spending is active.

## Open questions

Before a real slip, retrieve the current eligible agent and door records, the selected owner reset timezone, the current per-door amounts and the proposed review date. Show these together for correction and one approval. No real values are inferred from the earlier $1 test. Token Pacing owns confirmation of the provider bound, persisted holder fence, original-period settlement and reconciliation for each candidate door. Apple acceptance must verify the installed Changes to approve flow and exact signed bytes. Development uses clearly synthetic terms while those facts are gathered.

## Dispatch and complete disclosure

Today the Spend tab can render a proposed change and the dashboard PIN commits it. The new phone slip requires fresh presence from the paired owner device for the exact change. A door is one configured route through which an agent can incur a provider charge.

The phone must render eligible agents and their immutable identities, allowed purpose classes, and every existing field listed above from the same typed grant used for admission. Derive the purpose class on the server from a registered operation or authenticated Work Board record. Verify the actor may act on that record and that the requested operation belongs to it. Agent-drafted purpose text cannot change eligibility. Unknown classification stays outside the grant. Changing the eligible agent list or purpose classes requires fresh owner review even when the dollar amount stays the same.

Reservation holds funds. Provider I/O requires a separate durable one-way dispatch claim. Compare and set that claim under the current effective generation, owner grant or exception revision and live holder fence, serialized with revoke and freeze. If revoke, freeze or holder loss wins before claim, the call cannot start. A successful claimant may invoke the exact provider attempt once. A response lost after claim leaves an ambiguous charge under reconciliation. A second worker or restarted caller can retrieve the original claim only. A future enrolled door may retry an already-started operation only if its provider contract guarantees idempotency for the same key and exact request. Fixture tests drop the response, race claimants, and revoke between reservation and dispatch. Recovery requires the committed activation generation, both staged effects and the matching receipt, even on ordinary restart.

An exception is a separate call-specific allowance accounted in the same ledger under the original period. The signed disclosure pins the ordinary allocation and the incremental maximum. Booking revalidates that exact allocation under lock. If an intervening charge leaves insufficient ordinary balance or changes eligibility, refuse and show the revised decision. Settlement uses ordinary allocation first, then the exception. Release unused ordinary funds and retire unused exception funds. Unused exception funds never increase ordinary balance. For example, a reservation holds $3 ordinary and $2 exception. If it settles at $1, $2 returns to ordinary headroom and the entire exception retires. Repeated exception requests can inform a separate owner-reviewed standing grant change, with no automatic increase.

The nearing-cap item is informational. An agent may surface earlier headroom concerns for a concrete planned operation. It may not change any threshold or approval rule. Covered requests that fit the scope and both ceilings need no repeat approval for the allowance. Other existing task and organizational decisions still apply.

At dispatch claim, recheck the grant and exception validity interval against the current holder clock. An unclaimed reservation cannot start in a later accounting day. Release it only after proving no dispatch claim exists in the same transaction. A new-day attempt requires current-day booking and its own authorized operation identity. An already-started attempt settles in its original period. Test midnight rollover independently of grant expiry.

The current holder's recovery worker scans pending activation intents and unsettled dispatch claims, and shows unresolved records in the approval receipt and Spend. Retain operation identity, claim, payload digest, period and provider idempotency reference through the provider reconciliation horizon. The door's enrollment proof must name authoritative provider evidence for no charge, such as a terminal provider receipt for the exact idempotency key. A caller cancellation, silence or TTL is insufficient. If the provider cannot distinguish a crash before I/O from a lost response after I/O, preserve the hold and show it as unresolved. Test those crash points separately. Without a proven reconciliation contract, the first fixture remains synthetic.

Owner revocation uses the same enrolled owner path with a distinct exact grant/version revoke action. The phone may show a locally queued or submitted request while the holder is unreachable. Only a committed holder receipt may display Revoked. The owner interface shows that a disconnected holder has not yet enforced a queued request. There is no alternate holder in the first slice. On recovery, the holder applies durable pending revocations before opening provider dispatch and fences old unclaimed reservations.

Give each reservation a signed-plan-bounded claim deadline. The holder's recovery worker also checks unclaimed reservations and closes and releases an abandoned one atomically if its deadline has passed and no dispatch claim exists. A released row remains terminal for that operation. Late claimants cannot dispatch and a repeat reconciliation cannot release funds twice.

The Spend totals refer to the current signed accounting period. Show prior-period unresolved holds separately, including the period and reconciliation status. A prior-day hold can remain visible alongside fresh daily headroom. Late settlement updates its original period only. On the phone, expiry means new dispatch stops, while a review reminder alone does not change authority. The first fixture includes an explicit expiry and no separate reminder.

Owner transfer closes the applied grant immediately at the authoritative policy transition. Removal of the approving device also closes the first-profile grant and requires the current owner to reapprove it from a remaining enrolled device. The phone discloses both conditions. An unclaimed reservation cannot dispatch after either change. A claimed attempt is already committed to the provider boundary and may still begin or settle after revocation. The committed revoke receipt and Spend show the count and maximum charge of claimed attempts outstanding at the cutoff. Test a worker paused just after its claim.

At first booking, bind each operation ID to its authenticated actor and deployment scope and exact request digest. Reuse with the same binding returns the prior outcome. Reuse with a different actor, scope or payload reports a conflict and cannot allocate funds or return another actor's receipt.
