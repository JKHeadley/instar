---
title: "Needs-you Cards That Can Be Finished in Place"
slug: "owner-needs-card-rules"
tier: 2
parent-principle: "Operator-Surface Quality"
eli16-overview: "docs/specs/owner-needs-card-rules.eli16.md"
---

# Needs-you Cards That Can Be Finished in Place

## Problem statement

An owner saw a disk cleanup card with a button to open the dashboard. The agent could handle the cleanup. An audit of the 41 visible Needs-you rows found that all 41 used dashboard links, including legitimate approvals and credential requests that should be actionable in place.

## Proposed design

Apply one owner-card admission check before presenting an item from an operational source. The source resolves who can act from its authoritative state and assigns agent-fixable work to its existing owning session or project. Agent-fixable disk cleanup, context repair and sign-in repair use that path. If source authority establishes that only the owner can act, it supplies exactly one typed action. Unknown ownership holds the presentation and remains visible to the source owner.

The supported actions are one existing approval request with its Approve and Decline choices, one existing Secret Drop credential request, or one ordered set of plain instructions that can be followed directly. If any dashboard or other navigation action remains, hold the card and return it to its owning source for repair. Do not use a dashboard page, work board link or conversation link as an action or fallback. Approval and credential references must resolve to existing current requests for this exact owner. The check cannot create authority or remove an approval hold.

In the owner Needs composer, enforce the check before merging, counting, caching or paginating owner cards. The owner web, app and Mac clients render the typed action in place and retain their existing approval and credential authorization. Team views retain their own authorization and projection. The app and Telegram renderers validate the typed action again immediately before rendering or emitting a card. A malformed or unresolved action never emits a dashboard fallback.

The five pending project completion requests become one in-place approval disclosure. Reuse Identity’s paired-device presence challenge, disclosure digests, and signed receipt design. Give project completion a distinct signed action routed to the Chief of Staff completion authority. Bind the exact projects, binding versions, visible evidence and outcome to one disclosure. Recheck each item on execution and return durable per-item outcomes. The Work Board approval-to-start action keeps its current scope.

In Attention, apply the same check to owner entry points for list, pool, detail and the mobile owner detail. Preserve agent lifecycle and incident access through an explicit authenticated agent path. Route agent-fixable observations to the existing owning session or project before they can produce an owner notice. Read-side suppression is a compatibility backstop for older or stale rows. Source rerouting is idempotent by source item and episode and does not close the item. A held row must stay visible to its source. Add a safe owner status when a genuine action is unavailable so it cannot appear completed or be counted as ready.

## Decision points touched

- Who can act — judgment-candidate; source authority owns the decision. Unknown ownership holds the owner card and returns it to its source.
- In-place action count, schema and reference binding — invariant; basis: enumerable-domain; evidence: one supported action and no handoff.
- Approve, decline or submit a credential — invariant; basis: irreversible-consequence; evidence: existing request validation and current owner authorization remain the execution boundary.

## Multi-machine posture

Apply the owner projection after pooling and to both detail paths. Resolve action references using the source authority on its current holder. If the holder is unavailable, hold the action. Keep operational records in their existing source stores. Do not replicate credential contents or create a second owner notice.

## First source corrections

Route the disk cleanup, automatic sign-in repair and context recovery to their owning agents. Remove the Work Board overflow row from the owner model. Return vague project requests to their owners for an exact decision or retirement. These source corrections do not remove an existing approval hold.

## Verification and rollout

Unit tests exercise the three allowed actions, agent work, unknown custody, zero or multiple actions and dashboard handoffs. Integration tests cover both owner route families, local and pooled attention, mobile and web, direct detail reads, invalid references and no side effects on listing. Provider tests verify disk and automatically repairable sign-in go to the owning project. A production lifecycle test confirms that an approved owner decision can be completed from within each owner surface with no navigation and that the agent path retains held items. Confirm legacy owner clients can read and act on the new projection before enforcing it on their default reads.

## Maturation plan

- **test-agent-live:** Exercise route fixtures and the production lifecycle with synthetic requests.
- **dev-agent-live:** Enable for the Echo owner surfaces after in-place actions work in the supported clients.
- **fleet:** Extend to other agents after the Echo audit and rollout checks pass.
- **graduation criterion:** A real approval, credential request and direct instructions are visible and usable in place, and a real agent-fixable item reaches its source without an owner card.
- **dark-window:** Revisit within 28 days if any client or source still cannot meet the criterion.
- **ladder:** not applicable: owner presentation rules follow the tested client rollout rather than a separate registered ladder.

## Open questions

*(none)*
