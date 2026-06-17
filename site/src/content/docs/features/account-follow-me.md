---
title: Account Follow-Me
description: Seamless, ToS-safe cross-machine account and quota sharing.
---

Run one agent across several machines and have your subscription account work on every one of them — **log in once, and each machine re-mints its own login the ToS-safe way**. No Claude OAuth token is ever copied between machines (Anthropic's terms forbid relocating a Claude login out of its own store); instead each machine holds its own grant, exactly like logging the same account into a second laptop yourself.

This is **WS5.2 Account Follow-Me**. It ships dark on the fleet (live on a development agent for dogfooding) behind `multiMachine.accountFollowMe`. The security design lives in `docs/specs/ws52-account-follow-me-security.md`.

## What replicates (and what never does)

Only a **redacted, credential-free metadata projection** of each subscription account crosses machines — id, nickname, email, provider, framework, status, quota — so a peer machine knows an account's depth and quota *without holding its login*. The login location (`configHome`) and every credential field are stripped. This projection is the `subscription-account-meta` replicated journal kind, implemented in `SubscriptionAccountMetaReplicatedStore`. The `SubscriptionAccountMetaReplicatedStore` schema is a strict allow-list: any unknown or credential-shaped field is rejected on both the send and receive ends.

## The security primitives

Account Follow-Me is built on a set of hardened primitives, each proven before any live credential path exists:

- **`AccountCredentialShare`** — the dedicated `account-credential-share` mesh verb and its RBAC-gated handler. `AccountCredentialShare` runs the authorization gate (recipient match → operator mandate → single-use grant) *before* any decryption, and is structurally separate from the general secret-sync path so a credential can never ride the looser channel.
- **`CrossMachineMandate`** — the asymmetric Ed25519 issuance signature that lets one machine prove an authorization came from *your* operator machine. `CrossMachineMandate` is required because the existing mandate authorship proof is a machine-local HMAC that a peer cannot verify.
- **`PairingEpochManager`** — de-pair key rotation. `PairingEpochManager` rotates a machine's X25519 key when it is removed, which instantly makes every credential ever sealed to it undecryptable, and anchors the rotation generation in durable, rollback-resistant storage.
- **`AccountFollowMeGrants`** — single-use grants plus a per-account, sum-of-leases spend ceiling. `AccountFollowMeGrants` keeps a shared account from being over-drawn across machines and re-derives outstanding spend safely across a lease-holder failover.

## Authorization

Account Follow-Me is **operator-rooted**: a peer machine can never enroll an account onto itself. Authorization flows from a single PIN-gated coordination mandate, carried across machines by the `CrossMachineMandate` signature and enforced at the `AccountCredentialShare` gate. The metadata projection (`SubscriptionAccountMetaReplicatedStore`) carries no authority — it is reference data only.

## Enrollment detection & consent (PR2)

When a machine has no account it can serve from (a "depth-zero" machine), the agent detects it and asks you to approve — it never enrolls on its own. The pieces:

- **`AccountFollowMeOrchestrator`** — the request-never-self-authorize rule. `AccountFollowMeOrchestrator` checks the operator mandate gate; with no mandate it surfaces a phone-first consent (a dashboard deep-link, never a CLI instruction) and does NOT proceed; only an explicit mandate `allow` lets it proceed.
- **`AccountFollowMeDetector`** — depth-zero detection. `AccountFollowMeDetector` decides which machines to offer an enrollment for, bounded by the per-account max-follow cap and one-offer-per-(account,target) (R7), so adding machines never multiplies traffic.
- **`AccountFollowMeService`** — the composition. `AccountFollowMeService.scanAndOffer()` runs detection and raises ONE aggregated consent (enrolling nothing); `AccountFollowMeService.onMandateDelivered()` verifies a delivered mandate before any action.
- **`AccountFollowMeEmailGate`** — the safety check. `AccountFollowMeEmailGate` validates a freshly-enrolled account's email against what you approved (S7); a surprise account is held for review, never auto-used.

These compose the depth adapter + the tolerant peer-views fetcher (which reuses the `?scope=pool` fan-out, carrying account metadata only — never a login). The scan surface is `POST /subscription-pool/follow-me/scan`, dark behind `multiMachine.accountFollowMe`.

## Status

PR1 ships the security primitives (`AccountCredentialShare`, `CrossMachineMandate`, `PairingEpochManager`, `AccountFollowMeGrants`) and the `SubscriptionAccountMetaReplicatedStore` metadata kind, with no live-credential code path. PR2 ships the enrollment detection→consent surface (`AccountFollowMeOrchestrator`, `AccountFollowMeDetector`, `AccountFollowMeService`, `AccountFollowMeEmailGate`). Subsequent rounds wire the per-machine enrollment completion + the router selection gate + revocation, then the live proof.
