---
title: Preserve exact Work Board decisions in Needs You
slug: owner-needs-work-board-approval
author: echo
---

# Preserve exact Work Board decisions in Needs You

## Problem

PR 3866 ships opt-in. In the November 25 Echo comparison, the open Conversations navigation decision `wc_c99de1c0e3a2aa90` would disappear. Its legacy fields overlap with agent-only tracking cards. The Chief of Staff confirmed the decision at 19:18 PST and approved an explicit binding at 19:20 PST. Keep PR 3866 unchanged.

## Contract

Use a separate immutable Work Board proposal record. Only a server-authenticated card custodian with authority to request this decision can append it. Derive the asker from the journal author and the recipient and recipient revision from the current owner assignment. Requests cannot name an arbitrary recipient. The record contains the concrete decision, its consequence and the exact base card version. The version includes the material hash and record identities for card and decision changes so edits away and back invalidate old disclosures. Text is display data only.

Only one binding can be current per card. Append versioned withdrawal, supersession or consumption through the authoritative writer. Return the original result for an identical operation only after authenticating the original actor, checking current authority and matching the exact digest. Replay cannot restore a superseded or consumed request. A bound card can start only through an approval that consumes the exact proposal. Enforce this in the common write service and fold for all approval ingress. Keep binding authoring and activation dark unless older writers are fenced or enforce the same rule.

The owner projection requires a complete authoritative fold, an exact current binding, a pending owner start approval, and an owner-certified completion condition for this pilot. Existing approval channels retain other start decisions. A client must explicitly negotiate Work Board approval support in addition to the general Needs You contract. Otherwise show a generic pending status and withhold the consent control. Release requires signed native client proof. Dashboard consent remains unavailable until its distinct authority path is approved and tested.

The signed disclosure contains bounded plain text for the asker, decision, affected work and consequence. Refuse material content that cannot be displayed in full. Use a separate Work Board action type. Bind the native presence challenge and signed submission to a canonical digest of the proposal ID, immutable revision, recipient authority revision, action and the complete disclosure. Compare current version and authority and append the resulting tap and consumption together at the authoritative write boundary. If the previous writer's prefix cannot be proven complete, return unavailable without an append. A verified change returns 409 and refreshes the list. Declining consumes that exact proposal and keeps work blocked. Closing the sheet makes no decision. An authorized proposer can withdraw an open proposal.

No migration infers new bindings from existing cards. The one Echo design-card binding uses the supported authenticated authoring path with its current verified version after the route is deployed. Do not edit Echo's journal directly. Verify the request is still open, the recorded decision matches the reviewed proposal, and the operator receiver is current.

## Work Board projection

When the checked projection is active, the owner lane and turn follow `waitingOn=agent` for an approval-derived wait or a server-owned waiting mirror without a current owner-decision binding. An active owner question or completion confirmation remains an independent reason to wait. The board summary and My Board approval section use the same decision. The projection never changes stored approval, status, holds, pickups or execution eligibility.

Replay the 46-card overflow preflight fixture. The genuine Conversations approval and the subsequently verified Instar App sign-off are separate owner decisions. Reconcile and preserve both before activating. The constitution fixture links revision 3 to the exact original request 146913 and the sender-verified owner approval 146917. Treat that revision as decided and do not author a new proposal for it. Preserve the stored approval state in this checkpoint. Before adding any general chat-evidence write path, prove the owner identity, exact request/reply relationship, document digest, card material version and decision currentness. A free-text assertion or pasted transcript supplies no execution authority.

## Activation

Preflight the prospective read before enabling. Incomplete pool attention, accounts, promises, or any other source fails the check. An unavailable prospective read also fails. For the Echo pilot use a dedicated local POST /needs/activation and a newly registered delivered-mandate action. Bind the verified requesting session and mandate to this installation, machine, rollout revision and exact enable action. Require current serving authority. Justin’s signed installed-client evidence is checked separately, so activation requires no additional phone confirmation. Ordinary agent and browser credentials cannot authorize the write. A retry of the same verified mandate and operation returns the durable result.

Use a dedicated activation state file with a single locked writer. This avoids races with existing config writers, which have no shared lock. Capture the activation record revision before preflight. At the write boundary check that revision, the serving lease, the current owner and client proof and all relevant settings again. A known disabled source is covered. An unreachable or indeterminate source is incomplete. Require installed owner client evidence for the exact policy approval and exact Work Board proposal.

Store the desired activation state and installation-authenticated receipt together. Sync the temporary file, atomically replace the record and sync the containing directory before returning a durable result. Boot reads this record independently and resolves off for absent, invalid, disabled or mismatched state, including when the old config flag is set without a receipt. The write returns pending restart. Verify that startup reports the effective mode after the normal managed restart. Disabling writes the disabled state and stays available without preflight. An activation check establishes coverage at that time. Future reads still report incomplete sources.

## Older clients

A legacy owner client must retain genuine pending trust requests. Prefer a plain notice naming the verified request and one phone action, such as opening Changes to review the request, only if the old client can actually render the notice and reach an authorized action. The notice carries no consent authority and never links to an unsigned approval. For the Echo pilot, refuse activation until the capable client and accepted consent are confirmed. Introduce an older-client notice only after separately verifying its compatibility. Use synthetic or disposable proof for regression, then a signed installed-client read of the exact Echo request before activation.

## Acceptance

- Reproduce the live design card shape. Legacy replay omits it from Needs You. Projection shows one in-place approval after an exact binding is appended.
- Replay the structurally similar Token Pacing control and old records without binding. None enter the owner list.
- Exercise crossed signed disclosures, substituted or stale versions, changes away and back, a different owner, withdrawal, replay, and a non-owner device. None can create a new approval.
- Race two owner devices, race a legacy approval against a strict approval, and delay an authoritative peer update across handover. Verify single consumption and no append while currentness is unknown.
- Exercise peer attention and account failures independently. Activation refuses both, leaves the setting off and succeeds only after a complete prospective check.

- Cover a bare flag, concurrent config edits, interruption before and after atomic replacement, restart, and disable without source access.

## Implementation order

1. Establish the typed binding, version checks and migration tests in the Work Board fold. Existing peers must retain ordinary cards even if they cannot act on new bindings. Verify exact journal replay before enabling an authoring route.
2. Connect signed disclosure and the checked writer. Enable no authoring in production until the writer compatibility floor and predecessor currentness can be proven. Treat both as explicit dependencies on the shared journal work.
3. Add the scoped activation mandate and durable startup record. Test the check against the production-shaped source read with incomplete peers and a signed prospective owner read. Record the result before locally marking that exact mandate consumed, so the same operation can safely return the saved result after an interrupted acknowledgement. A different operation cannot reuse the mandate.
4. After the supported client is installed and enrolled, bind the still-open Echo card through the authoring path, confirm the exact rows and coverage, then perform the checked restart. Keep PR 3866 unchanged.
