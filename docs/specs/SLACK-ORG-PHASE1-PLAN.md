# Slack Org Permissions — Phase 1 Plan of Attack

**Status:** PROPOSAL, pending Justin's validation of Slice 0. Per the slice-first
principle ("validate before committing to the whole thing"), the *detailed* design of
each item below deliberately waits on Slice-0 feedback — this is the sequencing +
dependencies + the inputs I'd want from Justin, not committed design.

Slice 0 (shipped, observe-only, dark) proved the decision engine end-to-end for one
floor action. Phase 1 **generalizes** it into a usable foundation. Order is chosen so
each step is independently testable and nothing pre-empts a later decision.

## Work items (proposed order)

1. **Generalize the floor across the full set + wire to the real gate.**
   Today Slice 0's floor is enumerated and enforced by `RolePolicy`/`SlackPermissionGate`
   in isolation. Phase 1 routes floor evaluation through the existing `ExternalOperationGate`
   (risk matrix + per-service trust) and expresses the floor as **ORG-INTENT constraints**,
   so `/intent/org/test-action` can self-test a proposed action. *Dependency:* confirm the
   floor set with Justin (done — locked) and decide ExternalOperationGate vs. a thin adapter.

2. **The grant path (extend Coordination Mandate to user→agent).**
   Slice 0 has a `GrantStore` interface but no backing store. Phase 1 implements grants as
   bounded/expiring/revocable, requester≠authorizer, hash-chained — reusing the Mandate gate
   + audit. *Open input (spec Q2):* extend the existing Mandate vs. a sibling user-authority
   system. My lean: extend. **Want Justin's call before building this one.**

3. **Conversational registration UX.**
   Admin-registers ("register Sarah as a developer" → resolve Slack id → create profile) and
   self-registration-request → admin approval (Attention-queue item). Replaces the current
   CLI-only path. No terminal commands; all conversational. *Dependency:* the role taxonomy
   (spec Q1) — building it config-overridable so the answer can change later.

4. **Promote observe-only → enforce (gated on data).**
   Flip `enforce: true` ONLY after the observe-only ledger shows an acceptable false-positive
   rate (per the side-effects §4 follow-up). This is a data-gated decision, not a code task —
   it needs real traffic from the Layer-B demo first.

5. **Wire the verdict into an actual Slack reply.**
   Slice 0 computes the conversational refusal text but (observe-only) never sends it. Phase 1
   sends the refusal/clarify/step-up message back into the thread when enforcing.

## What stays for Phase 2 / 3 (NOT Phase 1)

- `considered`/ambient mode + the "should I speak?" gate, thread→session mapping (Phase 2).
- Relationship-anomaly behavioral baseline from real `RelationshipManager` data + real
  out-of-band step-up delivery + Dawn collaboration (Phase 3).

## Inputs I need from Justin before Phase 1 code

- **Q2 (grant mechanism):** extend Mandate, or sibling? (Blocks item 2.)
- **Q1 (role taxonomy granularity):** the 6-role default is built config-overridable; confirm
  it's the right shape or name the org-specific roles. (Shapes item 3.)
- **Slice-0 validation:** any change to the decision model from reviewing Slice 0 — the whole
  point of slice-first. Phase 1 builds on whatever Slice 0 becomes after your review.

## Test posture (unchanged from the standard)

Every item: unit + integration + e2e "feature is alive", wiring-integrity, both-sides-of-the-
boundary semantic tests. Observe-before-enforce for every judgment surface. Migration parity
for any installed-file change. Demonstration track (Layer-A suite) grows with each item.
