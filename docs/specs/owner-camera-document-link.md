---
title: "Approve a document computer link from the owner's iPhone"
slug: owner-camera-document-link
author: Echo
tier: 2
status: draft
eli16-overview: owner-camera-document-link.eli16.md
parent-principle: "Trust Is Earned by Work and Granted Only by the Person"
---

# Approve a document computer link from the owner's iPhone

## Problem statement

Camera handoff reaches Instar, but the owner currently sees a member action and is sent back to the computer for approval. The owner must be able to complete this specific document link from an eligible paired iPhone using Face ID or Touch ID.

## Proposed design

The browser remains open on the normal document page and generates its own key locally. It asks `POST /docs/:id/_link/nonce` for a short-lived owner-document proposal on the canonical agent origin. The server validates the same-origin request, applies existing issuance limits, and binds a nonce to the exact document, machine, origin, browser public key, scope and expiry. Issuance reveals neither document content nor whether a guessed private document exists. The app accepts the versioned Camera payload only for an exact already-trusted paired origin. It neither changes the pairing nor sends anything to a URL supplied by the QR before that check.

The app calls signed `POST /mobile/docs/:id/browser-link/lookup`. The served machine checks the active accepted owner device and current owner presence eligibility through the same authority used for native trust decisions. An ordinary paired device identity, a claimed role, a transport signature alone, or a bearer token cannot count as presence. Return a typed owner proposal with server-derived fingerprint, document title, origin, expiry, scope and a single-use challenge. Require the owner to compare the browser fingerprint and explicitly choose **Approve computer with Face ID**. Preserve the ordinary OS fallback only where the existing owner presence policy permits it. For the first slice disclose access to read this one document for the shown time only. The approval confers no dashboard login, general owner device role, write access or access to other documents.

The app sends `POST /mobile/docs/:id/browser-link/approve` with the existing signed-device transport and a presence signature for a distinct canonical action. Bind the same device and presence key generation, canonical origin and machine, document ID, nonce, browser key digest, exact disclosure digest, scope, expiry and authority epoch. Re-derive every binding from the stored proposal and current eligibility at consumption. A stale nonce or changed scope needs a new scan. Store one durable decision and scoped link with an idempotent success receipt in a single transaction. A lost reply can recover only that receipt after reauthentication. No general credential, private key or PIN is returned.

The browser proves possession of its original key before status or session exchange. Issue only a document-scoped read cookie after the normal signed open. Enforce the scoped principal at both authentication and document read routes. Treat it as neither team member nor owner browser. Deny writes, different document IDs and every general route. Use the owner app's linked computer list for visibility and revocation, requiring current owner proof. Owner key revocation, expiry and loss of eligible authority fence all new reads and invalidate live sessions on their next server check. Existing team lookup/submit remains independent. Do not treat one mode's proposal or signature as the other's.

## Multi-machine posture

The link is bound to the exact serving origin and machine. The browser private key is physically held by the browser and never moves. The owner-facing link summary and revocation route to that serving authority through the existing owner-machine surface. A peer may show a verified summary and cannot authorize or serve this link from stale state. Machine and owner epoch are rechecked. Disconnection fails closed. An origin transfer requires a new proposal and confirmation at the new origin.

machine-local-justification: physical-credential-locality

## Decision points touched

- Issue a proposal without exposing document contents — invariant; basis: enumerable-domain; evidence: an unconfirmed browser can submit only an origin-bound challenge request.
- Approve exact document scope — invariant; basis: irreversible-consequence; evidence: each misplaced decision exposes private content outside verified owner consent.
- Scope and key enforcement at each read — invariant; basis: enumerable-domain; evidence: the principal carries one exact verified document and a read-only capability.
- Owner guidance and available controls — judgment-candidate; floor: verified mode and scope come from the server, with no inferred eligibility; arbiter: native and dashboard product review.

## Verification

Unit tests bind device, presence key epoch, document, origin, machine, browser key, expiry, nonce and scope, including wrong-purpose signatures and replay. Integration proves matching native presence yields read-only access, a second device or token cannot approve, and the wrong browser cannot open. Production lifecycle covers server restart, duplicate receipt, member compatibility, owner unlink, cross-document and dashboard denial, and loss of authority. Simulator proof must perform the signed approval against the disposable server. Physical approval requires an installed build, new QR, matching fingerprint, actual Face ID, linked browser opening that document, and refusal after unlink. Keep current production QR until combined acceptance. An app that only reaches the fingerprint screen has not completed acceptance.

## Open questions

None.
