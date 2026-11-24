---
title: "Independent Acceptance for Owner-Facing Work"
slug: "independent-owner-surface-acceptance"
author: "echo"
tier: 2
eli16-overview: "docs/specs/independent-owner-surface-acceptance.eli16.md"
---

# Independent Acceptance for Owner-Facing Work

## Problem statement

An implementation check passed after Camera opened the right app and identified the right computer. The owner still could not complete the link. An agent also wrote approval cards whose titles were readable while their descriptions and completion items exposed internal work. Delivery needs independent proof of what the person can do.

## Proposed design

Design owns the rules and reviews each project's acceptance line before the build. The project owns the work and supplies evidence from the normal journey on the actual phone or screen. An assigned verifier who did not build that candidate decides whether the line passed. Keep acceptance separate from the owner's consent, publication, and any project's existing close authority.

Pilot one explicitly registered project milestone and its automatic completion notice. Before the build, the coordinator records Design's approval of the exact acceptance line and applicable rule references in the Chief of Staff journal. An edit to the line requires new Design approval. The requirement binds the project, milestone, exact candidate commit and installed runtime identity, stable builder principals across respawns, assigned verifier principal, assignment epoch and monotonic revision. Disabling or expiring a registered pilot holds automatic completion. It cannot restore ordinary automatic closure.

The project supplies a private evidence manifest covering the actual entry point through the visible outcome and resulting state. Before recording Pass, the verifier independently observes a fresh request on the named surface and obtains the resulting state from that runtime using a request unique to that attempt. The coordinator can approve a paired-phone test fixture that uses the same owner role and production journey. Missing access, unresolved provenance or inability to repeat the critical transition yields Pending. Existing Design Standard screenshot requirements remain a separate gate for changed surfaces. Validate bounded private artifacts when submitted, record hashes and authorized pointers, and exclude secrets, private identifiers and reusable links from the journal.

Use strict sessionProducer credential verification and authoritative local live-session assignment lookup for receipt submission. Require the exact assigned stable principal and assignment epoch. Reject fallbacks, generic bearer alone, expired credentials, the builder roster and caller-supplied identity. The coordinator lease holder appends a signed record. This trust boundary covers supported interfaces. A compromised holder or unrestricted host principal can access the underlying credentials.

Store Pass, Fail or Pending with the active revision, candidate, artifact hashes, reason, verified principal and server sequence. Pass requires independent state readback. Canonical request identities are idempotent only for an exact payload. A later Fail or Pending supersedes a Pass. Changing candidate, manifest, assignment or acceptance line requires a fresh attempt. An unknown, incomplete or contradictory record holds completion.

In the automatic close path in ChiefOfStaffLoop.processProject, check the active receipt before recording closure or mirroring initiative completion. For the registered pilot, replace the disposable in-memory completion note with one signed durable accepted-completion intent. Use it as the source for closure projection and the pending owner notice. Existing owner-initiated Finish and Confirm Done remain available and create no verified milestone notice. Ordinary chat, review requests, consent and draft publication retain their paths.

At the Chief notice dispatcher, serialize requirement and receipt writes with a durable dispatch reservation on the same holder. Deduplicate by destination, project, milestone, revision and notice kind. A newer decision committed before reservation holds dispatch. Once the reservation is recorded, an invoked external send cannot be recalled. Check current lease immediately before invoking transport and record confirmed delivery durably. If the adapter may have accepted a send before interruption, keep the attempt pending for reconciliation without automatic resending. Only a known pre-send failure may return to admission, which rechecks the current binding.

## First acceptance line

**“Justin can finish it on his phone without being redirected.”**

Start on the computer only to make a fresh link code. Scan from the paired owner's iPhone Camera. Instar must identify the computer, explain access, use the phone's native identity check and show that the computer is linked. Read back the intended computer and authorization once. After the scan, a browser, dashboard, second computer action, typed PIN or separate person fails the line. Cancellation and expiry from an unlinked phone must leave it unlinked. Replaying an already used code must preserve the original authorization and create no additional grant. Member approval is a separate path. Today's observed run opened Instar and matched the fingerprint but did not complete direct linking. Record it as **Fail**, not as acceptance of the next candidate.

PR 3783 is the card-text component. Apply the Design Standard's plain language, next-action and five-second rules to the tested result. A lint pass is supporting evidence and cannot replace the owner journey.

## Decision points touched

- Assignment and receipt origin — invariant; basis: irreversible-consequence; evidence: trusting a builder's own verdict allows unsupported completion to reach the owner.
- Requirement and evidence binding, including the delivered candidate — invariant; basis: enumerable-domain; evidence: compare the active revision, candidate and hashes against the receipt and outbox item.
- Evidence meaning and design compliance — judgment-candidate; an assigned independent verifier decides pass, fail or pending. The floor requires the declared real surface, observed outcome and durable state readback. Missing proof falls back to pending.
- Delivery and milestone completion — invariant; basis: enumerable-domain; evidence: only the latest complete pass for the active binding can admit the structured accepted event.

## Multi-machine posture

Use a complete Chief of Staff journal read at startup and verify authoritative holder signatures and contiguous pilot sequence. Cache the folded pilot state against the journal version and update it on each successful append. Missing records, unknown peer coverage and invalid signatures keep the pilot pending. The first pilot runs on its registering lease epoch. Suspend automatic completion on handoff until an authoritative catch-up mechanism is available. Gate the first write on support for the record types by all participating readers. Keep protected captures on the authorized artifact owner.

## Verification and rollout

Unit tests cover strict credential and assignment checks, same-principal builder rejection, wrong candidate, missing readback, contradictory receipts, duplicate requests and stale leases. Integration tests drive registration and receipt submission through HTTP, then exercise the real journal and automatic completion dispatcher. Test burst retries, known pre-send failure, a newer Fail committed before reservation, transport acknowledgment loss, and owner-initiated closure. A production lifecycle and wiring test checks that restart with the authoritative lease preserves the result and that takeover with incomplete or even apparently current peer data keeps the pilot pending. Run the Camera success and negative cases on the real phone before accepting any candidate. Provide the side-effects artifact for state and notification changes and keep the pilot to one registered milestone.

## Open questions

*(none)*
